import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { feishuPlugin } from "./src/channel.js";
import { setFeishuRuntime } from "./src/runtime.js";
import { init as initBotRegistry } from "./src/bot-registry/index.js";
// Tools (doc, wiki, drive, perm, bitable) are provided by the official feishu plugin.
// Do NOT register them here to avoid "plugin tool name conflict" warnings.

export { monitorFeishuProvider } from "./src/monitor.js";
export {
  sendMessageFeishu,
  sendCardFeishu,
  updateCardFeishu,
  editMessageFeishu,
  getMessageFeishu,
} from "./src/send.js";
export {
  uploadImageFeishu,
  uploadFileFeishu,
  sendImageFeishu,
  sendFileFeishu,
  sendMediaFeishu,
} from "./src/media.js";
export { probeFeishu } from "./src/probe.js";
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./src/reactions.js";
export {
  extractMentionTargets,
  extractMessageBody,
  isMentionForwardRequest,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionTarget,
} from "./src/mention.js";
export { feishuPlugin } from "./src/channel.js";

const plugin = {
  id: "feishu-swarm",
  name: "Feishu Swarm",
  description: "Feishu/Lark 增强版通道 - 多 Bot 支持 + API 缓存优化",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setFeishuRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });
    // Only register bot-registry (the raison d'être of feishu-swarm).
    // All other tools (doc, wiki, drive, perm, bitable) come from the official feishu plugin.
    initBotRegistry({ api });
  },
};

export default plugin;
