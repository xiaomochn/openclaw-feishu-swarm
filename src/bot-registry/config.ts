import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import os from "node:os";

/** Registry 为多机器人共用的公共服务端，默认地址（无需配置）。 */
export const DEFAULT_BOT_REGISTRY_URL = "https://claw.devset.top";
/** 默认网关端口（与 OpenClaw 主进程一致，主进程会设置 OPENCLAW_GATEWAY_PORT） */
export const DEFAULT_GATEWAY_PORT = 18789;
/** 入站代理默认端口（插件 init 时在 0.0.0.0 上启动，供 Registry 回调，再转发到网关） */
export const DEFAULT_INBOUND_PROXY_PORT = 18790;

export type FeishuConfigWithRegistry = {
  botRegistryUrl?: string;
  botRegistryEnabled?: boolean;
  /** 可选。不填时由插件自动解析：端口用 OPENCLAW_GATEWAY_PORT 或 18789，主机用本机局域网 IP（供 Registry 回调）。 */
  botRegistryInboundBaseUrl?: string;
};

/** 虚拟/桥接网卡名称关键词（如 WSL、Hyper-V、Docker），这些接口的 IP 不优先用于 Registry 回调 */
const VIRTUAL_IFACE_KEYWORDS = /vEthernet|WSL|Hyper-V|Default Switch|Docker|VMware|VirtualBox|Loopback|Bluetooth/i;

/** 判断是否为 172.16–31.x.x（常见虚拟网段，如 WSL/Hyper-V/Docker），优先不选 */
function isLikelyVirtualSegment(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4) return false;
  const second = parseInt(parts[1], 10);
  return parts[0] === "172" && second >= 16 && second <= 31;
}

/** 优先级：10.x > 192.168.x > 其他非 172.16/12；同档内排除虚拟网卡名、虚拟网段 */
function scoreAddress(addr: string, ifaceName: string): number {
  if (addr.startsWith("10.")) return 100;
  if (addr.startsWith("192.168.")) return 80;
  if (isLikelyVirtualSegment(addr) || VIRTUAL_IFACE_KEYWORDS.test(ifaceName)) return 10;
  return 50;
}

/**
 * 取本机首选局域网 IP（非 127.0.0.1、非 internal），供 Registry 从其他机器回调。
 * 优先 10.x、192.168.x，排除虚拟网卡（vEthernet、WSL、Hyper-V 等）及 172.16–31.x 虚拟网段。取不到则返回 127.0.0.1（仅同机可用）。
 */
export function getPreferredLocalAddress(): string {
  const ifaces = os.networkInterfaces();
  let best: { addr: string; score: number } | null = null;
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name];
    if (!list) continue;
    for (const iface of list) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      const addr = iface.address?.trim();
      if (!addr || addr === "127.0.0.1") continue;
      const score = scoreAddress(addr, name);
      if (best === null || score > best.score) best = { addr, score };
    }
  }
  return best?.addr ?? "127.0.0.1";
}

/**
 * 取当前网关端口：环境变量 OPENCLAW_GATEWAY_PORT（主进程启动网关时会设置）或默认 18789。
 */
export function getGatewayPort(): number {
  const raw = process.env.OPENCLAW_GATEWAY_PORT?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_GATEWAY_PORT;
}

/**
 * 取入站代理端口：环境变量 OPENCLAW_BOT_REGISTRY_INBOUND_PROXY_PORT 或 INBOUND_PROXY_PORT。
 * 当设置时插件会在 0.0.0.0:该端口 上启动入站代理，注册给 Registry 的地址用此端口。
 */
export function getInboundProxyPort(): number | null {
  const raw =
    process.env.OPENCLAW_BOT_REGISTRY_INBOUND_PROXY_PORT?.trim() ||
    process.env.INBOUND_PROXY_PORT?.trim();
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  return null;
}

/**
 * 解析「本机入站基地址」：用于向 Registry 注册时上报，供 Registry 回调本机。
 * 默认使用入站代理端口 18790（插件 init 时自动在 0.0.0.0:18790 启动代理，无需人工或环境变量）。
 * 若设置了 OPENCLAW_BOT_REGISTRY_INBOUND_PROXY_PORT（或 INBOUND_PROXY_PORT）则用该端口；若配置了 botRegistryInboundBaseUrl 则由 getRegistryConfig 直接使用配置值。
 */
export function resolveInboundBaseUrl(): string {
  const host = getPreferredLocalAddress();
  const proxyPort = getInboundProxyPort() ?? DEFAULT_INBOUND_PROXY_PORT;
  return `http://${host}:${proxyPort}`;
}

/**
 * JSON Schema fragment to merge into channel configSchema.properties.
 */
export const configSchemaFragment: Record<string, { type: string; description?: string }> = {
  botRegistryUrl: {
    type: "string",
    description: "Bot Registry root URL for registration and copy.",
  },
  botRegistryEnabled: {
    type: "boolean",
    description: "Whether Bot Registry integration is enabled. Default true when botRegistryUrl is set.",
  },
  botRegistryInboundBaseUrl: {
    type: "string",
    description:
      "Optional. Gateway base URL for Registry to call inbound. If not set, plugin auto-resolves from local IP + OPENCLAW_GATEWAY_PORT.",
  },

};

export function getRegistryConfig(cfg: ClawdbotConfig): {
  url: string;
  enabled: boolean;
  inboundBaseUrl: string;
} | null {
  const feishu = cfg.channels?.feishu as (FeishuConfigWithRegistry & { accounts?: Record<string, FeishuConfigWithRegistry> }) | undefined;
  if (!feishu) return null;

  // Check top-level first, then fall back to any account-level config
  let url = feishu.botRegistryUrl?.trim();
  let enabled = feishu.botRegistryEnabled;
  let inboundBaseUrl = feishu.botRegistryInboundBaseUrl?.trim();

  // In multi-account mode, check account configs for registry settings
  if (feishu.accounts && typeof feishu.accounts === "object") {
    for (const acct of Object.values(feishu.accounts)) {
      if (!acct || typeof acct !== "object") continue;
      if (!url && acct.botRegistryUrl?.trim()) url = acct.botRegistryUrl.trim();
      if (enabled === undefined && acct.botRegistryEnabled !== undefined) enabled = acct.botRegistryEnabled;
      if (!inboundBaseUrl && acct.botRegistryInboundBaseUrl?.trim()) inboundBaseUrl = acct.botRegistryInboundBaseUrl.trim();
    }
  }

  url = url || DEFAULT_BOT_REGISTRY_URL;
  const isEnabled = enabled !== false;
  inboundBaseUrl = inboundBaseUrl || resolveInboundBaseUrl();
  return { url, enabled: isEnabled, inboundBaseUrl };
}

/**
 * 从 HTTP Registry URL 推导 WebSocket URL（http→ws, https→wss），路径追加 /ws。
 * 例：https://claw.devset.top → wss://claw.devset.top/ws
 */
export function getRegistryWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
}

