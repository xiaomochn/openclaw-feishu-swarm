import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { FeishuConfig } from "../types.js";
import { getRegistryConfig } from "./config.js";
import type { RegistryRegistrationPayload } from "./types.js";
import { setCachedBotIdentity } from "./notify.js";
import { probeFeishu } from "../probe.js";
import { listFeishuDirectoryGroupsLive } from "../directory.js";
import { listEnabledFeishuAccounts } from "../accounts.js";

const INBOUND_PATH = "/channels/feishu/bot-registry/inbound";

export type RegisterResult = { ok: true } | { ok: false; error: string };

/**
 * Resolve the FeishuConfig to use for bot-registry.
 * Supports both single-account (appId at top level) and multi-account (accounts.xxx.appId) modes.
 * In multi-account mode, picks the first enabled account.
 */
function resolveFeishuConfigForRegistry(cfg: ClawdbotConfig): FeishuConfig | undefined {
  const raw = cfg.channels?.["feishu-swarm"] as FeishuConfig | undefined;
  if (!raw) return undefined;

  // Single-account mode: appId directly on feishu config
  if (raw.appId) return raw;

  // Multi-account mode: iterate enabled accounts, pick the first one with credentials
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) return undefined;

  // Use the first enabled account's merged config
  const account = accounts[0];
  return account.config as FeishuConfig;
}

/**
 * Build the registration payload (without sending). Used by both HTTP register and WS register.
 * Probes Feishu API for bot identity, fetches group list, and assembles the payload.
 * Supports both single-account and multi-account config modes.
 * Throws if probe fails or config is missing.
 */
export async function buildRegistrationPayload(params: {
  cfg: ClawdbotConfig;
}): Promise<RegistryRegistrationPayload> {
  const { cfg } = params;
  const reg = getRegistryConfig(cfg);
  const feishuCfg = resolveFeishuConfigForRegistry(cfg);

  if (!feishuCfg?.appId) {
    throw new Error("Feishu app_id not configured (checked both top-level and accounts.*)");
  }

  console.log("[feishu bot-registry] 构建注册 payload app_id=" + feishuCfg.appId);
  const probe = await probeFeishu(feishuCfg);
  if (!probe.ok || !probe.botOpenId) {
    throw new Error(probe.error ?? "Could not resolve bot_open_id");
  }
  console.log("[feishu bot-registry] 探活成功 bot_open_id=" + probe.botOpenId, "bot_name=" + (probe.botName ?? ""));

  // Cache identity for notifySent
  setCachedBotIdentity(feishuCfg.appId, probe.botOpenId, undefined, probe.botName);

  const groups = await listFeishuDirectoryGroupsLive({ cfg, limit: 200 });
  const group_chat_ids = groups.map((g) => g.id);

  const base = reg ? reg.inboundBaseUrl.replace(/\/$/, "") : "";
  const inbound_url = base ? `${base}${INBOUND_PATH}` : "";

  console.log("[feishu bot-registry] 群列表数量:", group_chat_ids.length, "前5个:", group_chat_ids.slice(0, 5).join(", ") + (group_chat_ids.length > 5 ? "…" : ""));

  return {
    app_id: feishuCfg.appId,
    bot_open_id: probe.botOpenId,
    bot_name: probe.botName,
    inbound_url,
    group_chat_ids,
  };
}

/**
 * Build registration payloads for ALL enabled accounts (multi-account support).
 * Returns an array of payloads, one per enabled account.
 */
export async function buildAllRegistrationPayloads(params: {
  cfg: ClawdbotConfig;
}): Promise<RegistryRegistrationPayload[]> {
  const { cfg } = params;
  const reg = getRegistryConfig(cfg);
  const raw = cfg.channels?.["feishu-swarm"] as FeishuConfig | undefined;
  if (!raw) return [];

  // Single-account mode
  if (raw.appId) {
    const payload = await buildRegistrationPayload({ cfg });
    return [payload];
  }

  // Multi-account mode
  const accounts = listEnabledFeishuAccounts(cfg);
  const payloads: RegistryRegistrationPayload[] = [];

  for (const account of accounts) {
    const acctCfg = account.config as FeishuConfig;
    if (!acctCfg?.appId) continue;

    try {
      console.log("[feishu bot-registry] 构建注册 payload (account=" + account.accountId + ") app_id=" + acctCfg.appId);
      const probe = await probeFeishu(acctCfg);
      if (!probe.ok || !probe.botOpenId) {
        console.error("[feishu bot-registry] 探活失败 (account=" + account.accountId + "):", probe.error);
        continue;
      }
      console.log("[feishu bot-registry] 探活成功 (account=" + account.accountId + ") bot_open_id=" + probe.botOpenId + " bot_name=" + (probe.botName ?? ""));

      setCachedBotIdentity(acctCfg.appId, probe.botOpenId, account.accountId, probe.botName);

      const groups = await listFeishuDirectoryGroupsLive({ cfg, limit: 200 });
      const group_chat_ids = groups.map((g: { id: string }) => g.id);

      const base = reg ? reg.inboundBaseUrl.replace(/\/$/, "") : "";
      const inbound_url = base ? `${base}${INBOUND_PATH}` : "";

      payloads.push({
        app_id: acctCfg.appId,
        bot_open_id: probe.botOpenId,
        bot_name: probe.botName,
        inbound_url,
        group_chat_ids,
      });
    } catch (err) {
      console.error("[feishu bot-registry] 构建注册 payload 失败 (account=" + account.accountId + "):", err);
    }
  }

  return payloads;
}

/**
 * Register this bot with the Registry via HTTP: bot info + group_chat_ids.
 */
export async function registerWithRegistry(params: {
  cfg: ClawdbotConfig;
  log?: (msg: string) => void;
}): Promise<RegisterResult> {
  const { cfg, log } = params;
  const reg = getRegistryConfig(cfg);
  if (!reg?.enabled) {
    const msg = "Registry not configured or disabled (need channels.feishu-swarm.botRegistryUrl and enabled)";
    console.log("[feishu bot-registry] 注册跳过：", msg);
    return { ok: false, error: msg };
  }

  try {
    const payload = await buildRegistrationPayload({ cfg });

    if (payload.inbound_url) {
      console.log("[feishu bot-registry] 本机入站地址（Registry 将向此地址 POST）:", payload.inbound_url);
      if (payload.inbound_url.includes("127.0.0.1")) {
        console.warn(
          "[feishu bot-registry] 入站地址含 127.0.0.1，Registry 若在别机将连不通；请配置 botRegistryInboundBaseUrl 为本机对外的 IP 或域名，或检查本机网络接口。",
        );
      }
    }

    const registryBase = reg.url.replace(/\/$/, "");
    const registerUrl = `${registryBase}/register`;

    console.log("[feishu bot-registry] 正在请求 Registry POST", registerUrl);

    const res = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[feishu bot-registry] Registry HTTP 注册失败 status=" + res.status, text);
      return { ok: false, error: `Registry register failed: ${res.status} ${text}` };
    }
    console.log("[feishu bot-registry] Registry HTTP 注册成功 bot_open_id=" + payload.bot_open_id, "群数=" + payload.group_chat_ids.length);
    log?.(`feishu bot-registry: registered via HTTP (groups=${payload.group_chat_ids.length})`);
    return { ok: true };
  } catch (err) {
    console.error("[feishu bot-registry] Registry HTTP 注册请求异常:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
