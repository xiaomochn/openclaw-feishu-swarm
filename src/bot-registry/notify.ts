import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { getRegistryConfig } from "./config.js";
import { sendCopyAny, isAnyConnected } from "./ws-client.js";
import type { RegistryCopyPayload } from "./types.js";

/**
 * Per-account bot identity cache. Key = accountId, value = { id: bot_open_id, name: bot_name }.
 * Also keeps legacy single values for backward compat (single-account setups).
 */
type BotIdentity = { id: string; name?: string };
const botIdentityMap = new Map<string, BotIdentity>();
let cachedSenderBotId: string | null = null;
let cachedSenderBotName: string | undefined = undefined;

/** 从消息内容中解析 @机器人 标签，格式：<at user_id="ou_xxxxxxx">名称</at> */
const AT_TAG_REGEX = /<at\s+user_id\s*=\s*["'](ou_[a-zA-Z0-9]+)["'][^>]*>([^<]*)<\/at>/g;

type ExtractedMention = { id: string; name: string };

/**
 * Extract both open_id and display name from at-tags in message content.
 * Returns deduplicated list of { id, name } pairs.
 */
function extractMentionsFromContent(content: string): ExtractedMention[] {
  const result: ExtractedMention[] = [];
  const seenIds = new Set<string>();
  let m: RegExpExecArray | null;
  AT_TAG_REGEX.lastIndex = 0;
  while ((m = AT_TAG_REGEX.exec(content)) !== null) {
    const id = m[1];
    const name = m[2]?.trim() || "";
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      result.push({ id, name });
    }
  }
  return result;
}

/**
 * Set cached bot identity after successful registration. Used by register.ts / index.ts.
 * Stores both per-account and legacy global (for single-account compat).
 */
export function setCachedBotIdentity(appId: string, botOpenId: string, accountId?: string, botName?: string): void {
  const id = botOpenId || appId;
  cachedSenderBotId = id;
  cachedSenderBotName = botName;
  if (accountId) {
    botIdentityMap.set(accountId, { id, name: botName });
  }
}

/**
 * Get sender identity (id + name) for a specific account, falling back to legacy global.
 */
function getSenderIdentity(accountId?: string): BotIdentity | null {
  if (accountId) {
    const perAccount = botIdentityMap.get(accountId);
    if (perAccount) return perAccount;
  }
  return cachedSenderBotId ? { id: cachedSenderBotId, name: cachedSenderBotName } : null;
}

export type NotifySentParams = {
  cfg: ClawdbotConfig;
  senderBotId?: string;
  accountId?: string;
  to: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  content: string;
  contentType?: string;
  mentions?: string[];
};

/**
 * Copy sent message to Registry (fire-and-forget). Call after sendMessageFeishu/sendCardFeishu success.
 * No-op if Registry not configured or not enabled; failures are logged only.
 */
export function notifySent(params: NotifySentParams): void {
  const reg = getRegistryConfig(params.cfg);
  if (!reg?.enabled) {
    return;
  }

  const senderIdentity = getSenderIdentity(params.accountId);
  const senderBotId = params.senderBotId ?? senderIdentity?.id ?? null;
  if (!senderBotId) {
    console.log("[feishu bot-registry] 抄送跳过：无 senderBotId（可能尚未完成注册）");
    return;
  }
  const senderBotName = senderIdentity?.name;

  // Extract mention IDs and names from at-tags in content.
  // Names are the primary matching mechanism on Registry side (cross-app consistent).
  // IDs are sent as-is for direct-match fallback (works in single-app scenarios).
  const extracted = extractMentionsFromContent(params.content);
  const mentionIds = extracted.map((m) => m.id).filter(Boolean);
  const mentionNames = extracted.map((m) => m.name).filter(Boolean);

  const payload: RegistryCopyPayload = {
    sender_bot_id: senderBotId,
    sender_bot_name: senderBotName,
    to: params.to,
    chat_id: params.chatId,
    message_id: params.messageId,
    reply_to_message_id: params.replyToMessageId,
    content: params.content,
    content_type: params.contentType,
    mentions: mentionIds.length > 0 ? mentionIds : undefined,
    mention_names: mentionNames?.length ? mentionNames : undefined,
    sent_at_ms: Date.now(),
  };

  const contentPreview = String(params.content).slice(0, 60) + (String(params.content).length > 60 ? "…" : "");

  // Prefer WebSocket; fall back to HTTP POST
  if (isAnyConnected()) {
    const sent = sendCopyAny(payload);
    if (sent) {
      console.log("[feishu bot-registry] 抄送 Registry via WS 群=" + params.chatId, "内容=" + contentPreview);
      return;
    }
    console.warn("[feishu bot-registry] WS sendCopy 失败，降级 HTTP");
  }

  const registryBase = reg.url.replace(/\/$/, "");
  const copyUrl = `${registryBase}/copy`;
  console.log("[feishu bot-registry] 抄送 Registry POST", copyUrl, "群=" + params.chatId, "回复id=" + (params.replyToMessageId ?? "无"), "内容=" + contentPreview);

  fetch(copyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((r) => {
      if (!r.ok) {
        console.error("[feishu bot-registry] 抄送响应异常 status=" + r.status, r.statusText);
      } else {
        console.log("[feishu bot-registry] 抄送成功(HTTP) 群=" + params.chatId);
      }
    })
    .catch((err) => {
      console.error("[feishu bot-registry] 抄送请求失败:", err);
    });
}
