import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { configSchemaFragment, DEFAULT_INBOUND_PROXY_PORT, getInboundProxyPort, getRegistryConfig, getRegistryWsUrl } from "./config.js";
import { handleInbound, handleInboundPayload } from "./inbound.js";
import { startInboundProxy } from "./inbound-proxy.js";
import { notifySent, setCachedBotIdentity } from "./notify.js";
import { registerWithRegistry, buildRegistrationPayload } from "./register.js";
import { connectToRegistryMulti } from "./ws-client.js";
import { listEnabledFeishuAccounts } from "../accounts.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { FeishuConfig } from "../types.js";
import { probeFeishu } from "../probe.js";
import { listFeishuDirectoryGroupsLive } from "../directory.js";

export { configSchemaFragment, getRegistryConfig } from "./config.js";
export { notifySent, setCachedBotIdentity } from "./notify.js";
export type { RegistryCopyPayload, RegistryInboundPayload, RegistryRegistrationPayload } from "./types.js";

/**
 * Write peers info to the bot's workspace so the agent knows how to @mention other bots.
 * Creates/overwrites {workspace}/PEERS.md with at-tag format instructions.
 */
function writePeersFile(workspace: string | undefined, selfName: string | undefined, selfOpenId: string, peers: Array<{ bot_open_id: string; bot_name?: string }>): void {
  if (!workspace) return;
  const resolvedWs = workspace.replace(/^~/, homedir());
  try {
    const lines: string[] = [
      "# Peers - 同群机器人列表",
      "",
      "> 本文件由 Bot Registry 自动生成，请勿手动编辑。",
      "> 在飞书群里 @其他机器人时，使用 `<at user_id=\"open_id\">名称</at>` 格式。",
      "",
      "## 我的信息",
      "",
      `- **名称**: ${selfName ?? "未知"}`,
      `- **open_id**: ${selfOpenId}`,
      `- **at 格式**: \`<at user_id="${selfOpenId}">${selfName ?? ""}</at>\``,
      "",
      "## 同群机器人",
      "",
    ];
    if (peers.length === 0) {
      lines.push("暂无同群机器人。");
    } else {
      for (const p of peers) {
        lines.push(`### ${p.bot_name ?? p.bot_open_id}`);
        lines.push("");
        lines.push(`- **open_id**: ${p.bot_open_id}`);
        lines.push(`- **at 格式**: \`<at user_id="${p.bot_open_id}">${p.bot_name ?? ""}</at>\``);
        lines.push("");
      }
    }
    lines.push("");
    lines.push("## 使用示例");
    lines.push("");
    lines.push("在发送飞书消息时，要 @某个机器人，在消息内容里插入对应的 at 标签即可：");
    lines.push("");
    if (peers.length > 0) {
      const example = peers[0];
      lines.push(`\`\`\``)
      lines.push(`<at user_id="${example.bot_open_id}">${example.bot_name ?? ""}</at> 你好，请帮我看看这个问题`);
      lines.push(`\`\`\``);
    } else {
      lines.push("```");
      lines.push(`<at user_id="ou_xxxxxxx">机器人名</at> 你好`);
      lines.push("```");
    }
    lines.push("");

    mkdirSync(resolvedWs, { recursive: true });
    writeFileSync(join(resolvedWs, "PEERS.md"), lines.join("\n"), "utf-8");
    console.log("[feishu bot-registry] 已写入 PEERS.md → " + join(resolvedWs, "PEERS.md") + " peers=" + peers.length);
  } catch (err) {
    console.error("[feishu bot-registry] 写入 PEERS.md 失败:", err);
  }
}


const INBOUND_PATH = "/channels/feishu-swarm/bot-registry/inbound";

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

    const feishu = (cfg as { channels?: { "feishu-swarm"?: { botRegistryInboundBaseUrl?: string } } })?.channels?.["feishu-swarm"];
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
      (api as { registerHttpRoute: (params: { path: string; auth: string; handler: (req: unknown, res: unknown) => Promise<void> }) => void }).registerHttpRoute({
        path: INBOUND_PATH,
        auth: "plugin", // Registry callback — plugin handles its own auth
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

      // Track bot identity resolved during registration, for use in onInbound and peer file
      let resolvedBotOpenId = "";
      let resolvedBotName = "";

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
          resolvedBotName = probe.botName ?? "";
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
        onRegistered: (peers) => {
          console.log("[feishu bot-registry:" + label + "] WS 注册成功（Registry 已确认）peers=" + (peers?.length ?? 0));
          const ws = (acctCfg as { workspace?: string }).workspace;
          if (peers) {
            writePeersFile(ws, resolvedBotName, resolvedBotOpenId, peers);
          }
        },
        onError: (err) => {
          console.error("[feishu bot-registry:" + label + "] WS 连接错误:", err);
        },
      });
    }
  }
}
