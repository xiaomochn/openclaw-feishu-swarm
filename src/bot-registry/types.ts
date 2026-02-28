/**
 * Bot Registry payload types: registration, copy (notify), inbound, and WebSocket messages.
 */

export type RegistryRegistrationPayload = {
  app_id: string;
  bot_open_id: string;
  bot_name?: string;
  inbound_url: string;
  group_chat_ids: string[];
  /** 消息 @ 中出现的 open_id 列表（与 bot_open_id 可能不同），供 Registry 匹配抄送 @ */
  /** Optional TTL or heartbeat_interval_sec for Registry */
  heartbeat_interval_sec?: number;
};

export type RegistryCopyPayload = {
  sender_bot_id: string;
  sender_bot_name?: string;
  to: string;
  chat_id: string;
  message_id: string;
  reply_to_message_id?: string;
  content: string;
  content_type?: string;
  /** @mention open_id list (cross-app IDs, may differ from bot_open_id) */
  mentions?: string[];
  /** @mention display names from at-tags, for name-based matching fallback */
  mention_names?: string[];
  sent_at_ms: number;
  request_id?: string;
};

export type RegistryInboundPayload = {
  chat_id: string;
  message_id: string;
  reply_to_message_id?: string;
  content: string;
  sender_bot_id: string;
  sender_bot_name?: string;
  mentions?: string[];
};

export type RegistryInboundBody = RegistryInboundPayload & {
  /** Optional: Registry may send API key for verification */
  _registry_key?: string;
};

// ── WebSocket envelope types ──────────────────────────────────────────────

/** Messages sent from Bot → Registry */
export type WsBotMessage =
  | { type: "register"; payload: RegistryRegistrationPayload }
  | { type: "copy"; payload: RegistryCopyPayload }
  | { type: "ping" };

/** Messages sent from Registry → Bot */
export type WsRegistryMessage =
  | { type: "registered"; payload: { ok: true } }
  | { type: "inbound"; payload: RegistryInboundPayload }
  | { type: "pong" }
  | { type: "error"; payload: { message: string } };

/** Union of all WebSocket messages */
export type WsMessage = WsBotMessage | WsRegistryMessage;
