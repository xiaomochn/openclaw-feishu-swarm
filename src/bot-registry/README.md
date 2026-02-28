# Bot Registry 模块

飞书插件内置模块，负责与 Registry Server 通信。

## 模块职责

| 文件 | 职责 |
|------|------|
| `index.ts` | 初始化：建 WS 连接、启动 HTTP 降级代理、注册路由 |
| `ws-client.ts` | WebSocket 客户端：连接 Registry，自动重连，收发消息 |
| `notify.ts` | 消息抄送：发消息后通知 Registry（WS 优先，HTTP 降级） |
| `register.ts` | 注册：构建 payload、HTTP 注册降级路径 |
| `inbound.ts` | 入站处理：收到 Registry 转发的消息，分派给 Agent |
| `inbound-proxy.ts` | HTTP 入站代理（:18790），WS 不可用时的降级接收通道 |
| `config.ts` | 配置解析：Registry URL、WS URL、本机 IP 检测 |
| `types.ts` | TypeScript 类型定义 |

## 消息流

```
发消息 → send.ts 调 notifySent() → WS sendCopy / HTTP POST /copy → Registry
Registry → WS inbound / HTTP POST → inbound.ts → dispatchInbound → Agent 处理 → 回复
```

## 通信优先级

1. **WebSocket**（首选）：NAT 友好，实时，无需暴露端口
2. **HTTP POST**（降级）：WS 断连或不可用时自动切换
