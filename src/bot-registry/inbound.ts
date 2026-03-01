import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "../runtime.js";
import { createFeishuReplyDispatcher } from "../reply-dispatcher.js";
import type { RegistryInboundBody, RegistryInboundPayload } from "./types.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Core inbound dispatch logic, shared by HTTP and WS paths.
 * Takes a parsed inbound payload and dispatches to the agent.
 *
 * @param targetAccountId - The account that received this inbound via WS. When provided,
 *   routing uses this account's agentId instead of the global resolveAgentRoute (which may
 *   pick the wrong account in multi-account setups).
 * @param targetBotOpenId - The bot_open_id of the receiving bot. Used to determine WasMentioned.
 */
async function dispatchInbound(
  body: RegistryInboundBody,
  getCfg: () => ClawdbotConfig | undefined,
  targetAccountId?: string,
  targetBotOpenId?: string,
): Promise<void> {
  const { chat_id: chatId, message_id: messageId, content, sender_bot_id: senderBotId } = body;

  const contentPreview = String(content).slice(0, 60) + (String(content).length > 60 ? "…" : "");
  console.log("[feishu bot-registry] 入站收到 群=" + chatId, "发送者bot=" + senderBotId, "目标账号=" + (targetAccountId ?? "auto"), "内容=" + contentPreview);

  const cfg = getCfg?.();
  if (!cfg) {
    console.error("[feishu bot-registry] 入站中止：配置不可用");
    return;
  }

  const core = getFeishuRuntime();
  const feishuFrom = `feishu:${senderBotId}`;
  const feishuTo = `chat:${chatId}`;

  // If targetAccountId is provided (WS path), construct route directly using that account.
  // This avoids resolveAgentRoute picking the wrong account in multi-account setups.
  let route: { sessionKey: string; agentId: string; accountId?: string };
  if (targetAccountId) {
    const agentId = `feishu-${targetAccountId}`;
    const sessionKey = `agent:${agentId}:feishu:group:${chatId}`;
    route = { sessionKey, agentId, accountId: targetAccountId };
    console.log("[feishu bot-registry] 入站路由(指定账号) sessionKey=" + sessionKey, "agentId=" + agentId);
  } else {
    route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu-swarm",
      peer: { kind: "group", id: chatId },
    });
    console.log("[feishu bot-registry] 入站路由(自动) sessionKey=" + route.sessionKey, "agentId=" + route.agentId);
  }

  // Determine WasMentioned: true if the content @mentions the receiving bot.
  // Because Feishu open_ids are per-app (app A sees bot B with a different open_id than bot B sees itself),
  // we check multiple signals:
  // 1. Direct open_id match in content
  // 2. The `targeted` flag set by Registry when this bot was a specific @mention target (not just broadcast)
  let wasMentioned = false;
  if (targetBotOpenId && content) {
    wasMentioned = content.includes(targetBotOpenId);
  }
  // Registry sets targeted=true when the bot was forwarded due to @mention resolution (not broadcast)
  if (!wasMentioned && (body as { targeted?: boolean }).targeted === true) {
    wasMentioned = true;
  }
  console.log("[feishu bot-registry] 入站 @检测 targetBot=" + (targetBotOpenId ?? "?"), "wasMentioned=" + wasMentioned, "targeted=" + String((body as { targeted?: boolean }).targeted ?? false));

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const speaker = body.sender_bot_name ?? senderBotId;
  const messageBody = `${speaker}: ${content}`;
  const envelopeFrom = `${chatId}:${senderBotId}`;
  const bodyFormatted = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: envelopeFrom,
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: messageBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyFormatted,
    RawBody: content,
    CommandBody: content,
    From: feishuFrom,
    To: feishuTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    GroupSubject: chatId,
    SenderName: body.sender_bot_name ?? senderBotId,
    SenderId: senderBotId,
    Provider: "feishu-swarm" as const,
    Surface: "feishu-swarm" as const,
    MessageSid: messageId,
    Timestamp: Date.now(),
    WasMentioned: wasMentioned,
    CommandAuthorized: true,
    OriginatingChannel: "feishu-swarm" as const,
    OriginatingTo: feishuTo,
  });

  const runtime = { log: console.log.bind(console), error: console.error.bind(console) };
  const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
    cfg,
    agentId: route.agentId,
    runtime,
    chatId,
    replyToMessageId: messageId,
    accountId: targetAccountId,
  });

  console.log("[feishu bot-registry] 入站开始派发 Agent 群=" + chatId);
  try {
    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });
    console.log("[feishu bot-registry] 入站派发完成 群=" + chatId);
  } catch (err) {
    console.error("[feishu bot-registry] 入站派发异常 群=" + chatId, err);
    throw err;
  } finally {
    markDispatchIdle();
  }
}

/**
 * Handle Registry inbound POST (HTTP path): parse body, validate, dispatch.
 * getCfg is provided by init (e.g. () => api.config).
 */
export async function handleInbound(
  req: IncomingMessage,
  res: ServerResponse,
  getCfg: () => ClawdbotConfig | undefined,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  let body: RegistryInboundBody;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw) as RegistryInboundBody;
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const { chat_id: chatId, message_id: messageId, content, sender_bot_id: senderBotId } = body;
  if (!chatId || !messageId || content === undefined || !senderBotId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Missing chat_id, message_id, content, or sender_bot_id" }));
    return;
  }

  // Respond immediately, then dispatch asynchronously
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true }));

  await dispatchInbound(body, getCfg);
}

/**
 * Handle inbound message received via WebSocket (no HTTP req/res).
 * Called by ws-client.ts when a WS `inbound` message arrives.
 *
 * @param targetAccountId - The accountId of the WS connection that received this message.
 *   Used for correct routing in multi-account setups.
 * @param targetBotOpenId - The bot_open_id of the receiving bot. Used for WasMentioned detection.
 */
export function handleInboundPayload(
  payload: RegistryInboundPayload,
  getCfg: () => ClawdbotConfig | undefined,
  targetAccountId?: string,
  targetBotOpenId?: string,
): void {
  const { chat_id, message_id, content, sender_bot_id } = payload;
  if (!chat_id || !message_id || content === undefined || !sender_bot_id) {
    console.error("[feishu bot-registry] WS 入站消息缺少必要字段，忽略");
    return;
  }
  // Fire-and-forget dispatch
  dispatchInbound(payload as RegistryInboundBody, getCfg, targetAccountId, targetBotOpenId).catch((err) => {
    console.error("[feishu bot-registry] WS 入站派发异常:", err);
  });
}
