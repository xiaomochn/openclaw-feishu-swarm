import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { configSchemaFragment, DEFAULT_INBOUND_PROXY_PORT, getInboundProxyPort, getRegistryConfig, getRegistryWsUrl } from "./config.js";
import { handleInbound, handleInboundPayload } from "./inbound.js";
import { startInboundProxy } from "./inbound-proxy.js";
import { notifySent, setCachedBotIdentity } from "./notify.js";
import { registerWithRegistry, buildRegistrationPayload } from "./register.js";
import { connectToRegistryMulti } from "./ws-client.js";
import { listEnabledFeishuAccounts } from "../accounts.js";
import type { FeishuConfig } from "../types.js";
import { probeFeishu } from "../probe.js";
import { listFeishuDirectoryGroupsLive } from "../directory.js";

export { configSchemaFragment, getRegistryConfig } from "./config.js";
export { notifySent, setCachedBotIdentity } from "./notify.js";
export type { RegistryCopyPayload, RegistryInboundPayload, RegistryRegistrationPayload } from "./types.js";

const INBOUND_PATH = "/channels/feishu/bot-registry/inbound";

/** Guard: inbound proxy only needs to start once */
let _proxyStarted = false;

export type InitOptions = {
  api: OpenClawPluginApi;
};

/**
 * Register HTTP route and perform initial registration with Registry.
 * In multi-account mode, creates one WS connection per enabled account.
 * Each bot registers independently so Registry can route messages correctly.
 *
 * NOTE: In multi-account gateways, this is called once per account by the plugin framework.
 * We handle multi-account ourselves by scanning all accounts on first call.
 */
export function init(options: InitOptions): void {
  const { api } = options;
  const cfg = (api as { config?: unknown }).config;
  const getCfg = (): typeof cfg => cfg;

  const reg = getRegistryConfig(cfg as Parameters<typeof getRegistryConfig>[0]);
  if (!reg?.enabled) return;

  // Start inbound proxy once (HTTP fallback, shared by all accounts)
  if (!_proxyStarted) {
    _proxyStarted = true;

    const feishu = (cfg as { channels?: { feishu?: { botRegistryInboundBaseUrl?: string } } })?.channels?.feishu;
    const explicitInbound = feishu?.botRegistryInboundBaseUrl?.trim();

    if (!explicitInbound) {
      const proxyPort = getInboundProxyPort() ?? DEFAULT_INBOUND_PROXY_PORT;
      startInboundProxy({
        port: proxyPort,
        handleDirect: (req, res) =>
          handleInbound(req as import("node:http").IncomingMessage, res as import("node:http").ServerResponse, getCfg),
        onListening: () => {
          // HTTP registration for first account (fallback)
          registerWithRegistry({
            cfg: getCfg() as Parameters<typeof registerWithRegistry>[0]["cfg"],
            log: (msg) => (api as { logger?: { info?: (m: string) => void } }).logger?.info?.(msg),
          }).then((result) => {
            if (!result.ok && "error" in result) {
              console.error("[feishu bot-registry] HTTP 注册失败:", result.error);
            }
          });
        },
      });
    }

    if (typeof (api as { registerHttpRoute?: (params: unknown) => void }).registerHttpRoute === "function") {
      (api as { registerHttpRoute: (params: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => void }).registerHttpRoute({
        path: INBOUND_PATH,
        handler: (req: unknown, res: unknown) =>
          handleInbound(req as import("node:http").IncomingMessage, res as import("node:http").ServerResponse, getCfg),
      });
    }

    // Connect WebSocket for each enabled account
    const typedCfg = cfg as Parameters<typeof listEnabledFeishuAccounts>[0];
    const accounts = listEnabledFeishuAccounts(typedCfg);

    if (accounts.length === 0) {
      console.warn("[feishu bot-registry] 没有找到已启用的飞书账号，跳过 WS 注册");
      return;
    }

    console.log("[feishu bot-registry] 发现", accounts.length, "个已启用账号，分别建立 WS 连接");

    const wsUrl = getRegistryWsUrl(reg.url);

    for (const account of accounts) {
      const acctCfg = account.config as FeishuConfig;
      if (!acctCfg?.appId) {
        console.warn("[feishu bot-registry] 账号", account.accountId, "缺少 appId，跳过");
        continue;
      }

      const label = account.accountId;
      console.log("[feishu bot-registry] 启动 WS 连接 account=" + label + " appId=" + acctCfg.appId + " url=" + wsUrl);

      // Track bot_open_id resolved during registration, for use in onInbound
      let resolvedBotOpenId = "";

      connectToRegistryMulti(label, {
        wsUrl,
        getRegistrationPayload: async () => {
          console.log("[feishu bot-registry:" + label + "] 构建注册 payload app_id=" + acctCfg.appId);
          const probe = await probeFeishu(acctCfg);
          if (!probe.ok || !probe.botOpenId) {
            throw new Error(probe.error ?? "Could not resolve bot_open_id for account " + label);
          }
          console.log("[feishu bot-registry:" + label + "] 探活成功 bot_open_id=" + probe.botOpenId + " bot_name=" + (probe.botName ?? ""));

          resolvedBotOpenId = probe.botOpenId;
          setCachedBotIdentity(acctCfg.appId, probe.botOpenId, label, probe.botName);

          const groups = await listFeishuDirectoryGroupsLive({ cfg: typedCfg, limit: 200 });
          const group_chat_ids = groups.map((g: { id: string }) => g.id);

          const base = reg ? reg.inboundBaseUrl.replace(/\/$/, "") : "";
          const inbound_url = base ? `${base}${INBOUND_PATH}` : "";

          console.log("[feishu bot-registry:" + label + "] 群列表数量:", group_chat_ids.length);

          return {
            app_id: acctCfg.appId,
            bot_open_id: probe.botOpenId,
            bot_name: probe.botName,
            inbound_url,
            group_chat_ids,
          };
        },
        onInbound: (payload) => {
          handleInboundPayload(payload, getCfg, label, resolvedBotOpenId);
        },
        onRegistered: () => {
          console.log("[feishu bot-registry:" + label + "] WS 注册成功（Registry 已确认）");
        },
        onError: (err) => {
          console.error("[feishu bot-registry:" + label + "] WS 连接错误:", err);
        },
      });
    }
  }
}
