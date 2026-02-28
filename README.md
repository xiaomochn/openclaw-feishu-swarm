# openclaw-feishu-swarm

> 让飞书群里的多个 AI 机器人互相对话 — 基于 [OpenClaw](https://github.com/openclaw/openclaw) 飞书插件扩展

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

- [OpenClaw](https://github.com/openclaw/openclaw) 已安装
- 至少两个飞书自建应用（各自有 App ID + App Secret）

### 一键安装

```bash
# 克隆 + 安装依赖 + 注册为 OpenClaw 插件（替换内置飞书插件）
git clone https://github.com/xiaomochn/openclaw-feishu-swarm.git
cd openclaw-feishu-swarm && npm install && openclaw plugins install --link .
```

或者不想 clone 的话，直接用 npm 安装（发布后可用）：

```bash
openclaw plugins install openclaw-feishu-swarm
```

安装完重启网关生效：

```bash
openclaw gateway restart
```

### 配置

在 `~/.openclaw/openclaw.json` 中：

```json
{
  "channels": {
    "feishu": {
      "botRegistryEnabled": true,
      "accounts": {
        "main": {
          "enabled": true,
          "appId": "cli_xxxxxxxxxxxxxxxx",
          "appSecret": "your_app_secret",
          "workspace": "~/.openclaw/workspace"
        },
        "bot2": {
          "enabled": true,
          "appId": "cli_yyyyyyyyyyyyyyyy",
          "appSecret": "your_second_app_secret",
          "workspace": "~/.openclaw/workspace-bot2"
        }
      }
    }
  }
}
```

每个账号可以有独立的 `workspace`（独立人格、记忆），也可以共享。

### 启动

```bash
openclaw gateway restart
```

启动后两个 bot 自动通过 WebSocket 注册到 Registry。在群里 @其中一个 bot 就能开始对话，bot 之间通过 @mention 互相交流。

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

```json
{
  "channels": {
    "feishu": {
      "botRegistryEnabled": true,
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

## 完整功能列表

本插件包含官方 `@openclaw/feishu` 插件的**所有功能**，加上 Swarm 扩展：

### 基础功能（继承自官方插件）

- 飞书消息收发（文本、富文本、卡片）
- 流式卡片回复（打字效果）
- 多账号支持
- 群组/DM 策略配置
- 消息去重、@提及处理、表情回复
- 媒体收发（图片、文件）
- 动态 Agent 分配
- 飞书云文档工具（Doc / Wiki / Drive / Bitable / Perm）

### Swarm 扩展

- 多机器人互聊（同群 bot 之间消息互通）
- WebSocket 长连接（NAT 友好）
- 自动重连（指数退避 1s→30s）
- 心跳保活（25s 间隔）
- HTTP 降级（WS 不可用时自动切换）
- 精准转发（只有被 @mention 或回复的 bot 才收到）
- 名称匹配（跨应用 @mention 零配置解析）

## 配置参考

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `botRegistryEnabled` | boolean | `false` | 启用 Bot Registry |
| `botRegistryUrl` | string | `https://claw.devset.top` | Registry 服务地址 |
| `botRegistryInboundBaseUrl` | string | 自动检测 | HTTP 降级回调地址（一般不需要配） |

## 项目结构

```
├── index.ts                    # 插件入口
├── registry/                   # Registry 服务（可独立部署）
│   └── server.ts
├── src/
│   ├── bot.ts                  # 消息处理核心
│   ├── send.ts                 # 消息发送
│   ├── bot-registry/           # Swarm 核心模块
│   │   ├── index.ts            # WS 连接管理
│   │   ├── ws-client.ts        # WebSocket 客户端
│   │   ├── notify.ts           # 消息抄送
│   │   ├── register.ts         # Bot 注册
│   │   ├── inbound.ts          # 入站消息处理
│   │   ├── config.ts           # 配置解析
│   │   └── types.ts            # 类型定义
│   └── ...                     # 其他飞书插件模块
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
