import { canSendAsBot, seatalkConfig } from "./config";

const HOST = "https://openapi.seatalk.io";

/** SeaTalk answers HTTP 200 even on failure; the real status lives in `code`. */
interface SeaTalkResponse {
  code?: number;
  msg?: string;
  message_id?: string;
  app_access_token?: string;
  expire?: number;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function postJson(url: string, body: unknown, token?: string): Promise<SeaTalkResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: SeaTalkResponse;
  try {
    json = JSON.parse(text) as SeaTalkResponse;
  } catch {
    throw new Error(`SeaTalk returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`SeaTalk HTTP ${res.status}: ${json.msg ?? text.slice(0, 200)}`);
  if (json.code !== undefined && json.code !== 0) {
    throw new Error(`SeaTalk error code ${json.code}: ${json.msg ?? "no message"}`);
  }
  return json;
}

/** Tokens live 7200s and the endpoint allows only 600 fetches/hour, so caching is mandatory. */
export async function appAccessToken(): Promise<string> {
  const cfg = seatalkConfig();
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error("SEATALK_APP_ID / SEATALK_APP_SECRET are not configured");
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 120_000 > now) return tokenCache.token;

  const json = await postJson(`${HOST}/auth/app_access_token`, {
    app_id: cfg.appId,
    app_secret: cfg.appSecret,
  });
  if (!json.app_access_token) throw new Error("SeaTalk did not return an app access token");
  tokenCache = {
    token: json.app_access_token,
    expiresAt: (json.expire ?? Math.floor(now / 1000) + 7200) * 1000,
  };
  return tokenCache.token;
}

export function resetSeaTalkTokenCache(): void {
  tokenCache = null;
}

function textMessage(content: string) {
  return {
    tag: "text" as const,
    text: { format: 1, content: content.slice(0, 4096) },
  };
}

/** One-way push into the configured group; needs only the webhook URL. */
export async function pushToWebhook(content: string): Promise<void> {
  const cfg = seatalkConfig();
  if (!cfg.webhookUrl) throw new Error("SEATALK_WEBHOOK_URL is not configured");
  await postJson(cfg.webhookUrl, textMessage(content));
}

export async function sendGroupMessage(groupId: string, content: string): Promise<string | undefined> {
  const token = await appAccessToken();
  const json = await postJson(
    `${HOST}/messaging/v2/group_chat`,
    { group_id: groupId, message: textMessage(content) },
    token,
  );
  return json.message_id;
}

/**
 * Prefer the bot API (group_chat), fall back to the group webhook.
 */
export async function deliver(opts: {
  groupId?: string | null;
  content: string;
}): Promise<void> {
  const cfg = seatalkConfig();
  if (canSendAsBot(cfg) && opts.groupId) {
    await sendGroupMessage(opts.groupId, opts.content);
    return;
  }
  await pushToWebhook(opts.content);
}
