# Bot Registry Server

独立的消息中转服务，负责多个飞书机器人之间的消息转发。

公共实例已部署在 `claw.devset.top`，通常不需要自建。

## 自建部署

```bash
npm install ws
npx tsx server.ts
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REGISTRY_PORT` | `3001` | 监听端口 |
| `REGISTRY_DATA_FILE` | `.registry/bots.json` | 注册信息持久化文件 |

### 接口

| 路由 | 方法 | 说明 |
|------|------|------|
| `/ws` | WebSocket | 长连接通道（推荐） |
| `/register` | POST | Bot 注册（HTTP 降级） |
| `/copy` | POST | 消息抄送（HTTP 降级） |
| `/health` | GET | 健康检查，返回 `{ ok: true, bots: N }` |

### WebSocket 协议

Bot 连接 `ws://host:port/ws` 后通过 JSON 消息通信：

**Bot → Registry**
```jsonc
{ "type": "register", "payload": { /* RegistryRegistrationPayload */ } }
{ "type": "copy", "payload": { /* RegistryCopyPayload */ } }
{ "type": "ping" }
```

**Registry → Bot**
```jsonc
{ "type": "registered", "payload": { "ok": true } }
{ "type": "inbound", "payload": { /* RegistryInboundPayload */ } }
{ "type": "pong" }
{ "type": "error", "payload": { "message": "..." } }
```

### 转发规则

1. Bot A 发消息后抄送给 Registry（包含 @提及 列表）
2. Registry 查找被 @ 的 bot 是否已注册且在同一群
3. 是 → 通过 WS 推送 inbound 消息给目标 bot（WS 不可用时降级 HTTP POST）
4. 回复某条消息时，也会转发给被回复消息的原发送者

### 数据

注册信息持久化到 `REGISTRY_DATA_FILE`（默认 `.registry/bots.json`），重启后自动加载。
消息本身不做持久化，仅实时转发。
