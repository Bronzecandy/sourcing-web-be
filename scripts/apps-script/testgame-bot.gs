/**
 * Test Game bot — Apps Script web app chạy dưới tài khoản testgame@garena.vn.
 * BE gọi POST JSON { secret, action, ...payload } (src/services/testgame/google-bot.ts).
 *
 * Cài đặt:
 * 1. Đăng nhập testgame@garena.vn → script.google.com → New project → dán file này.
 * 2. Project Settings → Script Properties → thêm SECRET = chuỗi ngẫu nhiên dài (≥ 32 ký tự).
 * 3. Deploy → New deployment → Web app: Execute as "Me", Who has access "Anyone".
 *    Lần đầu chạy sẽ hỏi quyền Gmail + Drive → Allow.
 * 4. Copy URL /exec vào .env BE: TESTGAME_APPS_SCRIPT_URL, SECRET vào TESTGAME_APPS_SCRIPT_SECRET.
 * 5. Sửa code xong phải Deploy → Manage deployments → Edit → Version: New version (giữ nguyên URL).
 */

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
    if (!secret || req.secret !== secret) return reply_({ ok: false, error: "Sai secret" });
    switch (req.action) {
      case "ping":
        return reply_({ ok: true, email: Session.getEffectiveUser().getEmail(), quota: MailApp.getRemainingDailyQuota() });
      case "sendMail":
        return reply_(sendMail_(req));
      case "createFolder":
        return reply_(createFolder_(req));
      case "shareFolder":
        return reply_(shareFolder_(req));
      default:
        return reply_({ ok: false, error: "Action không hỗ trợ: " + req.action });
    }
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
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
