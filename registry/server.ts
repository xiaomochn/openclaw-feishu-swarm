/**
 * Bot Registry HTTP + WebSocket server（独立服务，与飞书插件拆开）。
 * - POST /register: 接收各飞书插件上报的 bot 信息（app_id, bot_open_id, inbound_url, group_chat_ids）。
 * - POST /copy: 接收插件抄送，按 @ 与同群规则转发到目标 bot 的 inbound_url。
 * - WS /ws: 长连接通道，bot 通过 WebSocket 注册、抄送、接收入站消息（NAT 友好）。
 * - 注册信息持久化到本地 JSON 文件，重启后自动加载。
 *
 * 启动：pnpm run registry  或  npx tsx registry/server.ts
 * 环境变量：REGISTRY_PORT，默认 3001；REGISTRY_DATA_FILE，持久化文件路径，默认 .registry/bots.json。
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";

const PORT = Number(process.env.REGISTRY_PORT) || 3001;
const DATA_FILE = process.env.REGISTRY_DATA_FILE?.trim() || ".registry/bots.json";

type BotRecord = {
  app_id: string;
  bot_open_id: string;
  bot_name?: string;
  inbound_url: string;
  group_chat_ids: string[];
  /** 消息 @ 中出现的 open_id 列表（与 bot_open_id 可能不同，飞书同一机器人在不同场景可能用不同 id），用于抄送 @ 匹配 */
};

const bots = new Map<string, BotRecord>();

// ── WebSocket connection tracking ─────────────────────────────────────────
/** bot_open_id → active WS connection */
const wsConnections = new Map<string, WsWebSocket>();

/** WS connection → bot_open_id (reverse lookup for disconnect cleanup) */
const wsConnToBotId = new Map<WsWebSocket, string>();

/** WS heartbeat interval refs for cleanup */
const wsHeartbeatTimers = new Map<WsWebSocket, ReturnType<typeof setInterval>>();

const WS_HEARTBEAT_INTERVAL_MS = 30_000;
const WS_HEARTBEAT_TIMEOUT_MS = 90_000;

/** Last pong received timestamp per connection */
const wsLastPong = new Map<WsWebSocket, number>();

/**
 * Resolve a mention open_id to a registered bot_open_id (direct match only).
 * Works in single-app scenarios where at-tag open_id equals the bot's own open_id.
 * For cross-app scenarios, name-based matching (resolveBotByName) handles it.
 */
function resolveMentionToBotOpenId(mentionId: string): string | undefined {
  return bots.has(mentionId) ? mentionId : undefined;
}

/**
 * Resolve a display name (from @at tag) to a registered bot_open_id.
 * Uses bot_name from registration (which comes from /bot/v3/info app_name).
 * Returns undefined if no match or multiple matches (ambiguous).
 */
function resolveBotByName(name: string): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const matches: string[] = [];
  for (const [botOpenId, bot] of bots) {
    if (bot.bot_name && bot.bot_name.trim() === trimmed) {
      matches.push(botOpenId);
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.warn("[registry] 名称匹配不唯一 name=" + trimmed + " 匹配到 " + matches.length + " 个 bot: " + matches.join(", "));
  }
  return undefined;
}

function loadBots(): void {
  if (!existsSync(DATA_FILE)) {
    console.log("[registry] 持久化文件不存在，跳过加载:", DATA_FILE);
    return;
  }
  try {
    const raw = readFileSync(DATA_FILE, "utf8");
    const arr = JSON.parse(raw) as BotRecord[];
    if (Array.isArray(arr)) {
      bots.clear();
      for (const r of arr) {
        if (r?.bot_open_id && r?.inbound_url) bots.set(r.bot_open_id, r);
      }
      console.log("[registry] 已从文件加载注册信息:", bots.size, "个 bot，文件:", DATA_FILE);
      for (const [id, b] of bots) {
        console.log("[registry]   -", id, b.bot_name ?? b.app_id, "入站:", b.inbound_url, "群数:", b.group_chat_ids?.length ?? 0);
      }
    } else {
      console.warn("[registry] 持久化文件格式无效，非数组，跳过加载");
    }
  } catch (e) {
    console.error("[registry] 加载注册信息失败:", e);
  }
}

function saveBots(): void {
  try {
    const dir = dirname(DATA_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const arr = Array.from(bots.values());
    writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), "utf8");
    console.log("[registry] 已持久化注册信息:", bots.size, "个 bot ->", DATA_FILE);
  } catch (e) {
    console.error("[registry] 保存注册信息失败:", e);
  }
}
const seenCopyKeys = new Set<string>();
const MAX_SEEN_KEYS = 10000;
/** message_id（按 chat 维度）→ 发送者 bot_open_id，用于「回复某条消息时也转发给被回复消息的发送者」 */
const messageIdToSender = new Map<string, string>();
const MAX_MESSAGE_ID_MAP = 10000;

function parseJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: import("node:http").ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getClientAddress(req: import("node:http").IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : forwarded[0];
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? "?";
}

/**
 * Core registration logic shared by HTTP POST /register and WS register message.
 * Returns { ok, error? }.
 */
function processRegister(body: BotRecord, source: string): { ok: boolean; error?: string } {
  if (!body.app_id || !body.bot_open_id) {
    console.warn("[registry] 注册失败：缺少 app_id / bot_open_id (via " + source + ")");
    return { ok: false, error: "Missing app_id or bot_open_id" };
  }
  // WS 注册时 inbound_url 非必须（WS 连接本身就是投递通道），HTTP 注册时仍需要
  if (!body.inbound_url && source === "HTTP") {
    console.warn("[registry] 注册失败：缺少 inbound_url (via HTTP)");
    return { ok: false, error: "Missing inbound_url" };
  }
  let inboundHost = "?";
  if (body.inbound_url) {
    try {
      const u = new URL(body.inbound_url);
      inboundHost = u.hostname + (u.port ? ":" + u.port : "");
    } catch {
      inboundHost = body.inbound_url;
    }
  }
  console.log("[registry] 注册接口 body: app_id=" + body.app_id, "bot_open_id=" + body.bot_open_id, "inbound_url=" + (body.inbound_url || "(WS)"), "inbound 主机=" + inboundHost, "(via " + source + ")");
  const group_chat_ids = Array.isArray(body.group_chat_ids) ? body.group_chat_ids : [];


  // Merge: keep existing inbound_url if WS registration doesn't provide one
  const existing = bots.get(body.bot_open_id);
  const inbound_url = body.inbound_url || existing?.inbound_url || "";

  bots.set(body.bot_open_id, {
    app_id: body.app_id,
    bot_open_id: body.bot_open_id,
    bot_name: body.bot_name,
    inbound_url,
    group_chat_ids,

  });
  saveBots();
  console.log("[registry] 注册成功 bot_open_id=" + body.bot_open_id, "名称=" + (body.bot_name ?? body.app_id), "入站=" + (inbound_url || "(WS only)"), "群数=" + group_chat_ids.length, "(via " + source + ")");
  return { ok: true };
}

async function handleRegister(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const callerIp = getClientAddress(req);
  console.log("[registry] 收到注册请求 POST /register 调用方 IP=" + callerIp);
  try {
    const body = (await parseJsonBody(req)) as BotRecord;
    const result = processRegister(body, "HTTP");
    if (!result.ok) {
      send(res, 400, { error: result.error ?? "Bad Request" });
    } else {
      const peers = getPeersForBot(body.bot_open_id);
      send(res, 200, { ok: true, peers });
    }
  } catch (e) {
    console.error("[registry] 注册请求解析失败:", e);
    send(res, 400, { error: String(e) });
  }
}

/**
 * 向目标 bot 投递入站消息：优先 WS 长连接，失败或无连接时降级 HTTP POST。
 */
async function deliverInbound(botId: string, inboundPayload: object): Promise<void> {
  const wsConn = wsConnections.get(botId);
  if (wsConn && wsConn.readyState === 1 /* WebSocket.OPEN */) {
    try {
      wsConn.send(JSON.stringify({ type: "inbound", payload: inboundPayload }));
      console.log("[registry] 转发成功 bot=" + botId + " via WS");
      return;
    } catch (err) {
      console.error("[registry] WS 转发失败 bot=" + botId + "，降级 HTTP:", err);
    }
  }

  // Fallback: HTTP POST to inbound_url
  const bot = bots.get(botId);
  if (!bot?.inbound_url) {
    console.error("[registry] 转发失败 bot=" + botId + " 无 inbound_url 且无 WS 连接");
    return;
  }
  console.log("[registry] 转发 POST -> bot=" + botId, "url=" + bot.inbound_url);
  try {
    const r = await fetch(bot.inbound_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inboundPayload),
    });
    const respBody = await r.text();
    if (!r.ok) {
      console.error("[registry] 转发失败 bot=" + botId, "status=" + r.status, "body=" + respBody.slice(0, 200));
    } else {
      console.log("[registry] 转发成功 bot=" + botId, "status=" + r.status);
    }
  } catch (err: unknown) {
    const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: { code?: string; address?: string; port?: number } }).cause : undefined;
    if (cause?.code === "ECONNREFUSED") {
      console.error("[registry] 转发连接被拒 bot=" + botId, "地址=" + (cause.address ?? "?") + ":" + (cause.port ?? "?"));
      console.error("[registry] 请确认：1) 该机器人的网关（OpenClaw/clawdbot）已启动；2) 网关监听地址与 botRegistryInboundBaseUrl 一致（若为局域网 IP，需监听 0.0.0.0）；3) 端口正确。");
    } else {
      console.error("[registry] 转发异常 bot=" + botId, err);
    }
  }
}

type CopyPayload = {
  sender_bot_id: string;
  sender_bot_name?: string;
  to: string;
  chat_id: string;
  message_id: string;
  reply_to_message_id?: string;
  content: string;
  mentions?: string[];
  /** Display names from @at tags, for name-based matching when open_id doesn't resolve */
  mention_names?: string[];
  sent_at_ms: number;
};

/**
 * Core copy logic shared by HTTP POST /copy and WS copy message.
 * Returns { ok, forwarded?, skipped?, error? }.
 */
async function processCopy(body: CopyPayload, source: string): Promise<{ ok: boolean; forwarded?: number; skipped?: string; error?: string }> {
  if (!body.sender_bot_id || !body.chat_id || !body.message_id || body.content === undefined) {
    console.warn("[registry] 抄送失败：缺少 sender_bot_id / chat_id / message_id / content (via " + source + ")");
    return { ok: false, error: "Missing sender_bot_id, chat_id, message_id, or content" };
  }
  const contentPreview = String(body.content).slice(0, 80) + (String(body.content).length > 80 ? "…" : "");
  console.log("[registry] 抄送 发送者=" + body.sender_bot_id, "群=" + body.chat_id, "消息id=" + body.message_id, "回复id=" + (body.reply_to_message_id ?? "无"), "内容=" + contentPreview, "(via " + source + ")");
  const copyKey = `${body.chat_id}:${body.message_id}:${body.sender_bot_id}`;
  if (seenCopyKeys.has(copyKey)) {
    console.log("[registry] 抄送跳过：重复 key=" + copyKey);
    return { ok: true, skipped: "duplicate" };
  }
  if (seenCopyKeys.size >= MAX_SEEN_KEYS) {
    seenCopyKeys.clear();
  }
  seenCopyKeys.add(copyKey);

  const msgKey = `${body.chat_id}:${body.message_id}`;
  messageIdToSender.set(msgKey, body.sender_bot_id);
  if (messageIdToSender.size >= MAX_MESSAGE_ID_MAP) {
    messageIdToSender.clear();
    console.log("[registry] 消息发送者映射已满，已清空");
  }

  const mentions = body.mentions ?? [];
  const mentionNames = Array.isArray(body.mention_names) ? body.mention_names : [];
  console.log("[registry] 抄送 @列表=" + JSON.stringify(mentions), "@名称=" + JSON.stringify(mentionNames), "已注册 bot=" + Array.from(bots.keys()).join(", ") || "无");

  // ── Mention → bot 解析（三层匹配，名称优先）──────────────────────────
  //
  // 飞书 open_id 是 per-app 隔离的：
  //   app A 看 bot B 的 open_id ≠ bot B 通过 /bot/v3/info 查到的自身 open_id
  //   → 导致 @at 标签里的 open_id 无法直接匹配注册表的 bot_open_id
  //
  // 解决方案：at 标签同时包含 open_id 和 **名称**，而名称在所有 app 中一致。
  // 所以匹配策略为：
  //   1. 名称匹配（最可靠）：mention_names 里的名称 → bot_name（来自 /bot/v3/info app_name）
  //   2. 直接 open_id 匹配：mentionId 本身就是已注册的 bot_open_id（单 app 场景）
  //   3. 直接 open_id 匹配作为补充（单应用场景，at 标签 ID = bot_open_id）
  //
  let targetBotIds: string[] = [];

  // Step 1: 名称匹配（推荐，跨应用一致）
  for (const name of mentionNames) {
    const resolved = resolveBotByName(name);
    if (resolved && resolved !== body.sender_bot_id && !targetBotIds.includes(resolved)) {
      targetBotIds.push(resolved);
      console.log("[registry] 抄送 名称匹配 name=" + JSON.stringify(name) + " → bot=" + resolved + " ✓");
    }
  }

  // Step 2: open_id 匹配（直接 + 别名 + 遗留，仅对名称未覆盖的 id）
  for (const id of mentions) {
    if (id === body.sender_bot_id) continue;
    const resolved = resolveMentionToBotOpenId(id);
    if (resolved && !targetBotIds.includes(resolved)) {
      targetBotIds.push(resolved);
      console.log("[registry] 抄送 open_id匹配 id=" + id + " → bot=" + resolved + " ✓");
    }
  }

  targetBotIds = [...new Set(targetBotIds)];
  if (body.reply_to_message_id) {
    const replyKey = `${body.chat_id}:${body.reply_to_message_id}`;
    const repliedToBotId = messageIdToSender.get(replyKey);
    if (repliedToBotId && repliedToBotId !== body.sender_bot_id && bots.has(repliedToBotId)) {
      if (!targetBotIds.includes(repliedToBotId)) {
        targetBotIds = [...targetBotIds, repliedToBotId];
        console.log("[registry] 抄送 按回复关系追加目标: " + repliedToBotId + "（被回复消息的发送者）");
      }
    } else {
      console.log("[registry] 抄送 回复的 message_id=" + body.reply_to_message_id + " 未找到发送者或已是自己");
    }
  }
  if (mentions.length > 0 && targetBotIds.length === 0 && !body.reply_to_message_id) {
    console.log("[registry] 抄送 有 @但无匹配目标 发送者=" + body.sender_bot_id, "@ids=" + JSON.stringify(mentions), "@names=" + JSON.stringify(mentionNames), "（@的可能不是已注册的机器人）");
  }

  // No broadcast: only forward to explicitly targeted bots (@mention or reply chain).
  // This prevents bots from seeing every message in the group and responding when not addressed.
  if (targetBotIds.length === 0) {
    console.log("[registry] 抄送 无指定目标，跳过（不广播）");
    return { ok: true, forwarded: 0 };
  }

  const inGroup = targetBotIds.filter((botId) => {
    const bot = bots.get(botId);
    const inList = bot && bot.group_chat_ids.includes(body.chat_id);
    if (bot && !inList) {
      console.log("[registry] 抄送 bot " + botId + " 不在本群 chat=" + body.chat_id + "，该 bot 群数=" + (bot.group_chat_ids?.length ?? 0));
    }
    return !!inList;
  });

  console.log("[registry] 抄送 转发目标(同群)=" + JSON.stringify(inGroup), "共 " + inGroup.length + " 个");

  if (inGroup.length === 0) {
    console.log("[registry] 抄送结束：无需要转发的 bot（可能仅@自己或不在群内）");
    return { ok: true, forwarded: 0 };
  }

  // All targets are explicit (@mention or reply chain) — no broadcast.
  // So targeted=true for all of them.
  const mentionedBotIds = new Set(targetBotIds);

  for (const botId of inGroup) {
    const bot = bots.get(botId);
    const inboundPayload = {
      chat_id: body.chat_id,
      message_id: body.message_id,
      reply_to_message_id: body.reply_to_message_id,
      content: body.content,
      sender_bot_id: body.sender_bot_id,
      sender_bot_name: body.sender_bot_name,
      mentions: body.mentions,
      // targeted=true means this bot was specifically @mentioned or replied-to (not just broadcast)
      targeted: mentionedBotIds.has(botId),
    };
    await deliverInbound(botId, inboundPayload);
  }

  console.log("[registry] 抄送处理完成 已转发给 " + inGroup.length + " 个 bot");
  return { ok: true, forwarded: inGroup.length };
}

async function handleCopy(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  console.log("[registry] 收到抄送请求 POST /copy");
  try {
    const body = (await parseJsonBody(req)) as CopyPayload;
    const result = await processCopy(body, "HTTP");
    if (!result.ok) {
      send(res, 400, { error: result.error ?? "Bad Request" });
    } else {
      send(res, 200, result);
    }
  } catch (e) {
    console.error("[registry] 抄送请求解析失败:", e);
    send(res, 400, { error: String(e) });
  }
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  console.log("[registry] 请求 " + req.method + " " + path);
  if (req.method === "POST" && path === "/register") {
    await handleRegister(req, res);
    return;
  }
  if (req.method === "POST" && path === "/copy") {
    await handleCopy(req, res);
    return;
  }
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    console.log("[registry] 健康检查 当前注册 bot 数=" + bots.size);
    send(res, 200, { ok: true, bots: bots.size });
    return;
  }
  console.warn("[registry] 未知路径 " + req.method + " " + path);
  send(res, 404, { error: "Not Found" });
});

// ── WebSocket server (upgrade on /ws path) ───────────────────────────────


/**
 * Get peer bots that share at least one group with the given bot.
 * Returns list of { bot_open_id, bot_name } for the registering bot to know who else is around.
 */
function getPeersForBot(botOpenId: string): Array<{ bot_open_id: string; bot_name?: string }> {
  const self = bots.get(botOpenId);
  if (!self) return [];
  const selfGroups = new Set(self.group_chat_ids ?? []);
  const peers: Array<{ bot_open_id: string; bot_name?: string }> = [];
  for (const [id, bot] of bots) {
    if (id === botOpenId) continue;
    const shared = (bot.group_chat_ids ?? []).some((g) => selfGroups.has(g));
    if (shared) {
      peers.push({ bot_open_id: id, bot_name: bot.bot_name });
    }
  }
  return peers;
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (path === "/ws") {
    wss.handleUpgrade(req, socket, head, (wsConn) => {
      wss.emit("connection", wsConn, req);
    });
  } else {
    console.warn("[registry] WS upgrade 请求路径不是 /ws，拒绝:", path);
    socket.destroy();
  }
});

wss.on("connection", (wsConn: WsWebSocket, req: import("node:http").IncomingMessage) => {
  const callerIp = getClientAddress(req);
  console.log("[registry] WS 新连接 来自 IP=" + callerIp);

  // Set initial pong time
  wsLastPong.set(wsConn, Date.now());

  // Start heartbeat check for this connection
  const heartbeatTimer = setInterval(() => {
    const lastPong = wsLastPong.get(wsConn) ?? 0;
    if (Date.now() - lastPong > WS_HEARTBEAT_TIMEOUT_MS) {
      console.warn("[registry] WS 心跳超时，关闭连接 bot=" + (wsConnToBotId.get(wsConn) ?? "unknown"));
      wsConn.close(4000, "heartbeat timeout");
      return;
    }
    // Server can also send ping to check liveness
    if (wsConn.readyState === 1 /* OPEN */) {
      try {
        wsConn.ping();
      } catch {
        // ignore
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
  wsHeartbeatTimers.set(wsConn, heartbeatTimer);

  // Handle native WebSocket pong (from ws.ping())
  wsConn.on("pong", () => {
    wsLastPong.set(wsConn, Date.now());
  });

  wsConn.on("message", async (data: Buffer | string) => {
    let msg: { type?: string; payload?: unknown };
    try {
      const str = typeof data === "string" ? data : data.toString("utf8");
      msg = JSON.parse(str);
    } catch {
      wsSendJson(wsConn, { type: "error", payload: { message: "Invalid JSON" } });
      return;
    }

    switch (msg.type) {
      case "register": {
        const payload = msg.payload as BotRecord;
        const result = processRegister(payload, "WS");
        if (result.ok && payload.bot_open_id) {
          // Track WS connection for this bot
          const prevConn = wsConnections.get(payload.bot_open_id);
          if (prevConn && prevConn !== wsConn) {
            console.log("[registry] WS bot " + payload.bot_open_id + " 重新连接，关闭旧连接");
            cleanupWsConnection(prevConn);
            try { prevConn.close(4001, "replaced by new connection"); } catch { /* ignore */ }
          }
          wsConnections.set(payload.bot_open_id, wsConn);
          wsConnToBotId.set(wsConn, payload.bot_open_id);
          const peers = getPeersForBot(payload.bot_open_id);
          wsSendJson(wsConn, { type: "registered", payload: { ok: true, peers } });
          console.log("[registry] WS bot 已注册并跟踪连接 bot_open_id=" + payload.bot_open_id);
        } else {
          wsSendJson(wsConn, { type: "error", payload: { message: result.error ?? "Registration failed" } });
        }
        break;
      }
      case "copy": {
        const payload = msg.payload as CopyPayload;
        const result = await processCopy(payload, "WS");
        if (!result.ok) {
          wsSendJson(wsConn, { type: "error", payload: { message: result.error ?? "Copy failed" } });
        }
        // No explicit ack for copy — fire-and-forget style (consistent with HTTP behavior)
        break;
      }
      case "ping": {
        wsLastPong.set(wsConn, Date.now()); // treat client ping as liveness signal
        wsSendJson(wsConn, { type: "pong" });
        break;
      }
      default: {
        console.warn("[registry] WS 收到未知消息类型:", msg.type, "from bot=" + (wsConnToBotId.get(wsConn) ?? "unknown"));
        wsSendJson(wsConn, { type: "error", payload: { message: "Unknown message type: " + msg.type } });
      }
    }
  });

  wsConn.on("close", () => {
    const botId = wsConnToBotId.get(wsConn);
    console.log("[registry] WS 连接断开 bot=" + (botId ?? "unknown"));
    cleanupWsConnection(wsConn);
    // Keep bot's HTTP inbound_url in bots map for fallback delivery
  });

  wsConn.on("error", (err: Error) => {
    const botId = wsConnToBotId.get(wsConn);
    console.error("[registry] WS 连接错误 bot=" + (botId ?? "unknown"), err.message);
  });
});

function wsSendJson(wsConn: WsWebSocket, msg: object): void {
  if (wsConn.readyState !== 1 /* OPEN */) return;
  try {
    wsConn.send(JSON.stringify(msg));
  } catch (err) {
    console.error("[registry] WS send error:", err);
  }
}

function cleanupWsConnection(wsConn: WsWebSocket): void {
  const botId = wsConnToBotId.get(wsConn);
  if (botId) {
    // Only remove from wsConnections if this is still the active connection for this bot
    if (wsConnections.get(botId) === wsConn) {
      wsConnections.delete(botId);
    }
    wsConnToBotId.delete(wsConn);
  }
  const timer = wsHeartbeatTimers.get(wsConn);
  if (timer) {
    clearInterval(timer);
    wsHeartbeatTimers.delete(wsConn);
  }
  wsLastPong.delete(wsConn);
}

// ── Start server ──────────────────────────────────────────────────────────

loadBots();
server.listen(PORT, "0.0.0.0", () => {
  console.log("[registry] Bot Registry 已启动 监听 http://0.0.0.0:" + PORT + " (HTTP + WebSocket /ws) 持久化文件=" + DATA_FILE);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error("[registry] 端口 " + PORT + " 已被占用，请关闭其他进程或设置 REGISTRY_PORT（如 REGISTRY_PORT=3001 pnpm run registry）");
  } else {
    console.error("[registry] 服务异常:", err);
  }
  process.exit(1);
});
