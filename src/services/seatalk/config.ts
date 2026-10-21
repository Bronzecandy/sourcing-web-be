export interface SeaTalkConfig {
  enabled: boolean;
  webhookUrl: string | null;
  appId: string | null;
  appSecret: string | null;
  dailyGroupId: string | null;
  publicUrl: string;
}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function seatalkConfig(): SeaTalkConfig {
  return {
    enabled: (process.env.SEATALK_ENABLED ?? "").trim().toLowerCase() === "true",
    webhookUrl: env("SEATALK_WEBHOOK_URL"),
    appId: env("SEATALK_APP_ID"),
    appSecret: env("SEATALK_APP_SECRET"),
    dailyGroupId: env("SEATALK_DAILY_GROUP_ID"),
    publicUrl: (env("SOURCING_PUBLIC_URL") ?? "https://sourcing-web.run.ingarena.net").replace(
      /\/+$/,
      "",
    ),
  };
}

/** App credentials are enough to POST group_chat (no inbound callback). */
export function canSendAsBot(cfg = seatalkConfig()): boolean {
  return Boolean(cfg.appId && cfg.appSecret);
}

export function canDeliver(cfg = seatalkConfig()): boolean {
  if (!cfg.enabled) return false;
  if (canSendAsBot(cfg) && cfg.dailyGroupId) return true;
  return Boolean(cfg.webhookUrl);
}
