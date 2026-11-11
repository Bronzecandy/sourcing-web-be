/**
 * Test Game bot — Apps Script chạy dưới testgame@garena.vn: gửi Gmail, tạo / share folder Drive cho Sourcing.
 * Sea chỉ cho web app trong domain và BE Sourcing nằm trong mạng nội bộ, nên script không nhận request:
 * trigger mỗi phút gọi poll() → nhận việc từ trạm trung chuyển (taptap-proxy trên VM data, /bot) → làm → trả kết quả.
 * BE: src/services/testgame/google-bot.ts + bot-jobs.ts.
 *
 * Cài đặt (đăng nhập testgame@garena.vn; nên dùng cửa sổ ẩn danh chỉ có tài khoản này):
 * 1. script.google.com → New project → dán file này → Save.
 * 2. Project Settings → Script Properties → SECRET = chuỗi trùng BOT_SECRET của trạm (admin Sourcing cấp).
 * 3. Chọn hàm setup → Run → Review permissions → Allow (Gmail, Drive, gọi URL ngoài, trigger).
 *    setup() tạo trigger chạy poll() mỗi phút và chạy thử một lượt.
 * Không cần Deploy web app. Sửa code xong chỉ cần Save — trigger luôn chạy bản đã lưu mới nhất.
 */

var RELAY_URL = "https://market-data.garena.vn/taptap-proxy/bot";
var VERSION = "2026-11-11";
var MAX_RUN_MS = 4 * 60 * 1000;

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "poll") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("poll").timeBased().everyMinutes(1).create();
  poll();
  Logger.log("Đã tạo trigger poll mỗi phút cho %s — trạm đã ghi nhận lượt ghé đầu tiên.", Session.getEffectiveUser().getEmail());
}

function poll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var started = Date.now();
    do {
      var data = call_("/poll", { account: Session.getEffectiveUser().getEmail(), quota: MailApp.getRemainingDailyQuota(), version: VERSION }, 1);
      var jobs = data.jobs || [];
      if (!jobs.length) return;
      call_("/results", { results: jobs.map(run_) }, 3);
    } while (Date.now() - started < MAX_RUN_MS);
  } finally {
    lock.releaseLock();
  }
}

function run_(job) {
  var handlers = { sendMail: sendMail_, createFolder: createFolder_, shareFolder: shareFolder_ };
  try {
    var handler = handlers[job.action];
    if (!handler) return { id: job.id, ok: false, error: "Action không hỗ trợ: " + job.action };
    var r = handler(job.payload || {});
    return { id: job.id, ok: r.ok !== false, result: r, error: r.error || null };
  } catch (err) {
    return { id: job.id, ok: false, error: String((err && err.message) || err) };
  }
}

/** Gọi trạm; `tries` > 1 để trả kết quả không bị mất khi mạng chập chờn (mất kết quả mail thì trạm báo lỗi thay vì gửi lại). */
function call_(path, body, tries) {
  var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret) throw new Error("Thiếu Script Property SECRET");
  var lastError = null;
  for (var i = 0; i < tries; i++) {
    if (i > 0) Utilities.sleep(2000 * i);
    try {
      var res = UrlFetchApp.fetch(RELAY_URL + path, {
        method: "post",
        contentType: "application/json",
        headers: { "x-bot-secret": secret },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
      var code = res.getResponseCode();
      var text = res.getContentText();
      var json = null;
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = null;
      }
      if (code === 200 && json && json.success) return json.data || {};
      lastError = new Error("Trạm " + path + " HTTP " + code + ": " + ((json && json.error) || text.slice(0, 200)));
      if (code === 401 || code === 400) break;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function sendMail_(req) {
  if (!req.to || !req.subject) return { ok: false, error: "Thiếu người nhận hoặc tiêu đề" };
  var options = { htmlBody: req.htmlBody || "", name: req.name || "Garena Test Game" };
  if (req.replyTo) options.replyTo = req.replyTo;
  if (req.attachments && req.attachments.length) {
    options.attachments = req.attachments.map(function (a) {
      return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mimeType || "application/octet-stream", a.name);
    });
  }
  GmailApp.sendEmail(req.to, req.subject, req.body || "", options);
  return { ok: true };
}

/** Folder mới để private (không bật "Anyone with the link"); chỉ chia sẻ đích danh qua shareFolder. */
function createFolder_(req) {
  if (!req.parentId || !req.name) return { ok: false, error: "Thiếu parentId hoặc tên folder" };
  var parent = DriveApp.getFolderById(req.parentId);
  var existing = parent.getFoldersByName(req.name);
  var folder = existing.hasNext() ? existing.next() : parent.createFolder(req.name);
  return { ok: true, id: folder.getId(), url: folder.getUrl() };
}

function shareFolder_(req) {
  if (!req.folderId) return { ok: false, error: "Thiếu folderId" };
  var folder = DriveApp.getFolderById(req.folderId);
  var results = {};
  (req.emails || []).forEach(function (email) {
    try {
      folder.addViewer(email);
      results[email] = "ok";
    } catch (err) {
      results[email] = String((err && err.message) || err);
    }
  });
  return { ok: true, results: results };
}
