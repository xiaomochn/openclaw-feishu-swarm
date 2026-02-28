/**
 * 入站代理：在 0.0.0.0 上监听，接收 Registry 的 POST。
 * 由插件 init 时传入 handleDirect 时，直接调用飞书入站处理，不转发到本机网关。
 * 由插件 init 时未传 handleDirect（如独立脚本 scripts/inbound-proxy-server.ts）时，转发到 gatewayInboundUrl。
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const INBOUND_PATH = "/channels/feishu/bot-registry/inbound";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export type StartInboundProxyOptions = {
  port: number;
  /** 直接调用飞书入站处理（推荐）：不转发到网关，避免依赖 127.0.0.1:18789。与 gatewayInboundUrl 二选一。 */
  handleDirect?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** 转发到本机网关（仅当未传 handleDirect 时使用，如独立脚本）。 */
  gatewayInboundUrl?: string;
  /** 代理开始监听后调用，用于在 listen 完成后再向 Registry 注册，避免竞态导致 Registry 连不上 */
  onListening?: () => void;
};

/**
 * 启动入站代理 HTTP 服务，监听 0.0.0.0:port。
 * 若传入 handleDirect，收到 POST 后直接调用，不转发；否则转发到 gatewayInboundUrl。
 */
export function startInboundProxy(options: StartInboundProxyOptions): import("node:http").Server {
  const { port, handleDirect, gatewayInboundUrl, onListening } = options;

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    if (req.method !== "POST" || path !== INBOUND_PATH) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Not Found", path }));
      return;
    }

    if (handleDirect) {
      try {
        await handleDirect(req, res);
        if (!res.writableEnded) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        }
      } catch (err) {
        console.error("[feishu bot-registry] 入站代理 直接处理异常:", err);
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal Server Error", detail: String(err) }));
        }
      }
      return;
    }

    if (!gatewayInboundUrl) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Bad Configuration", detail: "Neither handleDirect nor gatewayInboundUrl" }));
      return;
    }

    try {
      const body = await readBody(req);
      const contentType = req.headers["content-type"] ?? "application/json";

      const proxyRes = await fetch(gatewayInboundUrl, {
        method: "POST",
        headers: { "Content-Type": contentType, "Content-Length": String(body.length) },
        body: body as unknown as BodyInit,
      });

      const respBody = await proxyRes.text();
      res.statusCode = proxyRes.status;
      res.setHeader("Content-Type", proxyRes.headers.get("Content-Type") ?? "application/json");
      res.end(respBody);

      if (proxyRes.ok) {
        console.log("[feishu bot-registry] 入站代理 转发成功 status=" + proxyRes.status);
      } else {
        console.error("[feishu bot-registry] 入站代理 网关返回异常 status=" + proxyRes.status, respBody.slice(0, 200));
      }
    } catch (err) {
      const cause = err && typeof err === "object" && "cause" in err ? (err as { cause?: { code?: string } }).cause : undefined;
      console.error("[feishu bot-registry] 入站代理 转发异常:", err);
      console.error("[feishu bot-registry] 入站代理 转发目标（本机网关）:", gatewayInboundUrl, cause?.code === "ECONNREFUSED" ? "→ 连接被拒绝，请确认网关已启动且端口一致（OPENCLAW_GATEWAY_PORT 或 18789）" : "");
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Bad Gateway", detail: String(err) }));
    }
  });

  const mode = handleDirect ? "直接调飞书入站" : `转发到 ${gatewayInboundUrl ?? "?"}`;
  server.listen(port, "0.0.0.0", () => {
    console.log("[feishu bot-registry] 入站代理已启动 http://0.0.0.0:" + port + INBOUND_PATH, "模式=" + mode);
    onListening?.();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error("[feishu bot-registry] 入站代理 端口 " + port + " 已被占用，请设置 OPENCLAW_BOT_REGISTRY_INBOUND_PROXY_PORT 为其他端口");
    } else {
      console.error("[feishu bot-registry] 入站代理 服务异常:", err);
    }
  });

  return server;
}
