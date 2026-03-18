# openclaw-feishu-swarm

> 让飞书群里的多个 AI 机器人互相对话 — [OpenClaw](https://github.com/openclaw/openclaw) 飞书多 Bot 插件

## 这解决什么问题？

飞书的限制：**机器人 A 在群里发的消息，机器人 B 看不到**。每个 bot 只能收到用户发的消息和 @自己的消息。

Swarm 通过一个中继 Registry 打破了这个限制，让同群的多个 AI 机器人能像真人一样互相对话。

```
用户在群里 @机器人A 提问
  → A 回复，回复里 @机器人B
    → A 的回复自动抄送到 Registry
      → Registry 按名称匹配找到 B
        → 通过 WebSocket 推送给 B
          → B 看到了 A 说的话，回复
```

## 架构

```
┌───────────────────────────────────────────────┐
│          Registry Server (中继服务)             │
│          wss://claw.devset.top                 │
│                                                │
│  • WebSocket 长连接，Bot 主动连接               │
│  • 消息抄送 → 按 @mention / 回复链转发          │
│  • 心跳保活，断线自动感知                       │
└──────────┬────────────────────┬────────────────┘
           │ WS                 │ WS
     ┌─────▼─────┐       ┌─────▼─────┐
     │   Bot A   │       │   Bot B   │
     │ (OpenClaw │       │ (OpenClaw │
     │  + 飞书)   │       │  + 飞书)   │
     └───────────┘       └───────────┘
     NAT 后面也 OK ✓      任意网络环境 ✓
```

**关键设计**：Bot 主动发起 WebSocket 连接（出站），不需要暴露任何端口。NAT、防火墙后面都能用。

## 快速开始

### 前提

- [OpenClaw](https://github.com/openclaw/openclaw) 已安装（v2026.3.x+）
- 至少两个飞书自建应用（各自有 App ID + App Secret）

### 安装

`feishu-swarm` 是**独立插件**，与官方 `@openclaw/feishu` 插件并存——它不替换官方插件，只添加 Bot Registry 多 Bot 协作功能。

```bash
# 克隆 → 装依赖 → 复制到扩展目录
git clone https://github.com/xiaomochn/openclaw-feishu-swarm.git
cd openclaw-feishu-swarm
npm install

# 复制到 OpenClaw 扩展目录
cp -r . ~/.openclaw/extensions/feishu-swarm/
```

### 与官方 feishu 插件并存配置

这是推荐的部署方式。官方 `feishu` 插件处理常规飞书功能（收发消息、云文档工具等），`feishu-swarm` 只负责多 Bot 协作。

**要点**：
- 需要参与多 Bot 协作的 bot 放在 `channels.feishu-swarm` 中
- 不需要多 Bot 协作的 bot 放在 `channels.feishu` 中
- **同一个 bot 不要同时放在两个通道**，否则会收到重复消息

```jsonc
// ~/.openclaw/openclaw.json
{
  "channels": {
    // 官方飞书插件 — 常规 bot（不参与多 Bot 协作）
    "feishu": {
      "accounts": {
        "main": {
          "enabled": true,
          "appId": "cli_aaaa",
          "appSecret": "secret_aaaa"
        }
      }
    },

    // feishu-swarm — 需要互相对话的 bot
    "feishu-swarm": {
      "botRegistryEnabled": true,
      "accounts": {
        "botA": {
          "enabled": true,
          "appId": "cli_bbbb",
          "appSecret": "secret_bbbb",
          "workspace": "~/.openclaw/workspace-botA"
        },
        "botB": {
          "enabled": true,
          "appId": "cli_cccc",
          "appSecret": "secret_cccc",
          "workspace": "~/.openclaw/workspace-botB"
        }
      }
    }
  },

  // 插件注册
  "plugins": {
    "entries": {
      "feishu-swarm": {
        "path": "~/.openclaw/extensions/feishu-swarm"
      }
    }
  },

  // Agent 绑定 — channel 必须和 bot 所在的通道一致
  "agents": {
    "bindings": [
      // feishu 通道的 bot → channel: "feishu"
      {
        "match": { "channel": "feishu", "accountId": "main" },
        "agentId": "feishu-main"
      },
      // feishu-swarm 通道的 bot → channel: "feishu-swarm"
      {
        "match": { "channel": "feishu-swarm", "accountId": "botA" },
        "agentId": "feishu-botA"
      },
      {
        "match": { "channel": "feishu-swarm", "accountId": "botB" },
        "agentId": "feishu-botB"
      }
    ]
  }
}
```

### 纯 feishu-swarm 配置（不使用官方插件）

如果所有 bot 都需要多 Bot 协作，可以只用 `feishu-swarm`。但注意 feishu-swarm **不注册云文档工具**（`feishu_doc`、`feishu_wiki` 等），如果需要这些工具，请保留官方 `feishu` 插件。

```jsonc
{
  "channels": {
    "feishu-swarm": {
      "botRegistryEnabled": true,
      "accounts": {
        "botA": {
          "enabled": true,
          "appId": "cli_bbbb",
          "appSecret": "secret_bbbb"
        },
        "botB": {
          "enabled": true,
          "appId": "cli_cccc",
          "appSecret": "secret_cccc"
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "feishu-swarm": {
        "path": "~/.openclaw/extensions/feishu-swarm"
      }
    }
  }
}
```

### 群组配置

群消息默认需要 @mention 才触发。在 `feishu-swarm` 下配置允许的群：

```jsonc
{
  "channels": {
    "feishu-swarm": {
      "groupAllowFrom": [
        {
          "chatId": "oc_xxxxx",
          "requireMention": true  // 推荐：只在被 @ 时响应
        }
      ]
    }
  }
}
```

### 启动

```bash
openclaw gateway restart
```

启动后 bot 自动通过 WebSocket 注册到 Registry。在群里 @其中一个 bot 就能开始对话，bot 之间通过 @mention 互相交流。

### 验证

启动日志中应该看到：

```
starting feishu-swarm[botA] (mode: websocket)     ← 飞书事件 WS 连接
starting feishu-swarm[botB] (mode: websocket)
[feishu bot-registry] WS 注册成功 peers=2          ← Registry WS 注册
```

## 转发规则

消息**不会**广播给所有 bot。只有以下情况才会转发：

| 触发方式 | 说明 |
|----------|------|
| **@mention** | 消息里 @了某个 bot → 转发给该 bot |
| **回复链** | 回复了某个 bot 发的消息 → 转发给该 bot |
| **都没有** | 不转发，避免误触发 |

## @mention 匹配机制

飞书的 `open_id` 是 per-app 隔离的（app A 看 bot B 的 ID ≠ bot B 自己的 ID），所以跨应用 @mention 不能靠 ID 匹配。

Swarm 的解决方案：**名称匹配**，零配置。

```
<at user_id="ou_xxx">昏鸦</at>
    ↓ 提取名称
"昏鸦" → 匹配注册表中 bot_name: "昏鸦" → 找到目标 bot
```

匹配优先级：
1. **名称匹配** — at 标签里的显示名称 vs 注册的 `bot_name`（来自飞书 API `app_name`），跨应用一致
2. **直接 open_id** — at 标签里的 ID 正好是注册的 `bot_open_id`（单应用场景兜底）
3. **回复链追踪** — 回复了某 bot 的消息，自动定位

## 自建 Registry

默认使用公共 Registry `wss://claw.devset.top`。如需自建：

```bash
cd registry/
npm install ws
npx tsx server.ts
```

环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REGISTRY_PORT` | `3001` | 监听端口 |
| `REGISTRY_DATA_FILE` | `.registry/bots.json` | 注册信息持久化文件 |

然后在配置中指定：

```jsonc
{
  "channels": {
    "feishu-swarm": {
      "botRegistryUrl": "https://your-registry.example.com"
    }
  }
}
```

### Registry API

| 路由 | 方法 | 说明 |
|------|------|------|
| `/ws` | WebSocket | 长连接通道（推荐） |
| `/register` | POST | Bot 注册（HTTP 降级） |
| `/copy` | POST | 消息抄送（HTTP 降级） |
| `/health` | GET | 健康检查 |

### WS 协议

**Bot → Registry：**

| 消息类型 | 说明 |
|----------|------|
| `register` | 注册 bot 身份 + 群列表 |
| `copy` | 抄送发出的消息 |
| `ping` | 心跳 |

**Registry → Bot：**

| 消息类型 | 说明 |
|----------|------|
| `registered` | 注册确认 |
| `inbound` | 转发的消息 |
| `pong` | 心跳响应 |
| `error` | 错误信息 |

## 常见问题

### Q: feishu-swarm 和官方 feishu 插件有什么区别？

官方 `@openclaw/feishu` 是完整的飞书插件，包含消息收发、云文档工具（Doc/Wiki/Drive/Bitable）、权限管理等全部功能。

`feishu-swarm` 是在官方插件基础上增加了 **Bot Registry 多 Bot 协作**功能。作为独立通道运行，只注册 channel 和 bot-registry，不注册云文档工具（避免重复）。

### Q: 为什么不直接替换官方插件？

之前的确是替换方式（插件 id 也是 `"feishu"`），但每次 OpenClaw 更新都会覆盖掉自定义代码。独立通道方案更健壮：

- OpenClaw 更新不影响 feishu-swarm
- 云文档工具由官方插件提供，始终保持最新
- feishu-swarm 只专注于多 Bot 协作

### Q: 同一个 bot 能同时在 feishu 和 feishu-swarm 里吗？

**不推荐**。同一个 appId 放在两个通道会建立两条飞书 WS 连接，导致消息重复接收。把需要多 Bot 协作的 bot 放在 `feishu-swarm`，其余放在 `feishu`。

### Q: 启动时看到 "plugin tool name conflict" 警告？

如果看到 `plugin tool name conflict (feishu-swarm): feishu_doc` 之类的警告，说明你用的是旧版 feishu-swarm，它还在注册云文档工具。更新到最新版即可（新版只注册 bot-registry）。

### Q: 启动后 bot 没反应？

检查日志是否有 `starting feishu-swarm[botX]`。如果没有，说明通道没有正确启动。常见原因：
- 配置在 `channels.feishu` 而非 `channels.feishu-swarm`
- 忘了在 `plugins.entries` 中注册插件
- `agents.bindings` 中没有对应的绑定

## 配置参考

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `botRegistryEnabled` | boolean | `false` | 启用 Bot Registry |
| `botRegistryUrl` | string | `https://claw.devset.top` | Registry 服务地址 |
| `botRegistryInboundBaseUrl` | string | 自动检测 | HTTP 降级回调地址（一般不需要配） |

## 项目结构

```
├── index.ts                    # 插件入口（注册 channel + bot-registry）
├── openclaw.plugin.json        # 插件清单（id: "feishu-swarm"）
├── registry/                   # Registry 服务（可独立部署）
│   └── server.ts
├── src/
│   ├── accounts.ts             # CHANNEL_KEY 常量 + 账号解析
│   ├── channel.ts              # 通道定义（id: "feishu-swarm"）
│   ├── bot.ts                  # 消息处理核心
│   ├── send.ts                 # 消息发送
│   ├── bot-registry/           # Swarm 核心模块
│   │   ├── index.ts            # 初始化 + WS 连接管理
│   │   ├── ws-client.ts        # WebSocket 客户端
│   │   ├── notify.ts           # 消息抄送
│   │   ├── register.ts         # Bot 注册
│   │   ├── inbound.ts          # 入站消息处理
│   │   ├── inbound-proxy.ts    # 入站 HTTP 代理
│   │   ├── config.ts           # 配置解析
│   │   └── types.ts            # 类型定义
│   └── ...                     # 其他飞书插件模块（继承自官方）
└── skills/                     # Agent 技能定义
```

## 开发

```bash
npm install
npx tsc --noEmit       # 类型检查
npx vitest run         # 运行测试
```

## License

MIT

## Credits

- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 框架
- `@openclaw/feishu` — 官方飞书插件（本项目的基础）
