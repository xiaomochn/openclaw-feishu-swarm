/**
 * WebSocket client for Bot Registry — plugin side.
 * Supports multiple instances (one per bot account) for multi-account gateways.
 * Maintains persistent WS connections with auto-reconnect, heartbeat, and message routing.
 * Uses Node.js built-in WebSocket (Node 21+).
 *
 * Protocol — Bot → Registry: register, copy, ping
 *           Registry → Bot: registered, inbound, pong, error
 */

import type {
  RegistryRegistrationPayload,
  RegistryCopyPayload,
  RegistryInboundPayload,
  WsBotMessage,
  WsRegistryMessage,
} from "./types.js";

/** Options for WsRegistryClient / connectToRegistry() */
export type WsClientOptions = {
  /** WebSocket URL of the Registry server, e.g. wss://claw.devset.top/ws */
  wsUrl: string;
  /** Registration payload to send on every (re)connect */
  getRegistrationPayload: () => RegistryRegistrationPayload | Promise<RegistryRegistrationPayload>;
  /** Called when Registry forwards an inbound message via WS */
  onInbound: (payload: RegistryInboundPayload) => void;
  /** Called when registration is acknowledged */
  onRegistered?: () => void;
  /** Called on WS errors (informational) */
  onError?: (err: unknown) => void;
  /** Label for log messages (e.g. accountId) */
  label?: string;
};

const PING_INTERVAL_MS = 25_000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

// ── Multi-instance registry ───────────────────────────────────────────────

/** All active WS client instances, keyed by label/accountId */
const instances = new Map<string, WsRegistryClient>();

// ── Class-based client ────────────────────────────────────────────────────

export class WsRegistryClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private _registered = false;
  private readonly opts: WsClientOptions;
  private readonly tag: string;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
    this.tag = opts.label ? `[feishu bot-registry:${opts.label}]` : "[feishu bot-registry]";
  }

  get registered(): boolean { return this._registered; }
  get isConnected(): boolean { return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this._registered; }

  connect(): void {
    this.closed = false;
    this.reconnectAttempt = 0;
    this._registered = false;
    this.doConnect();
  }

  sendCopy(payload: RegistryCopyPayload): boolean {
    if (!this.isConnected) return false;
    return this.wsSend({ type: "copy", payload });
  }

  close(): void {
    this.closed = true;
    this._registered = false;
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, "client shutdown"); } catch { /* ignore */ }
      this.ws = null;
    }
    console.log(this.tag, "WS client closed");
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private doConnect(): void {
    if (this.closed) return;
    console.log(this.tag, "WS connecting to", this.opts.wsUrl, this.reconnectAttempt > 0 ? `(reconnect #${this.reconnectAttempt})` : "");
    try {
      this.ws = new WebSocket(this.opts.wsUrl);
    } catch (err) {
      console.error(this.tag, "WS constructor error:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener("open", () => this.onOpen());
    this.ws.addEventListener("message", (e) => this.onMessage(e));
    this.ws.addEventListener("close", (e) => this.onClose(e));
    this.ws.addEventListener("error", (e) => this.onError(e));
  }

  private async onOpen(): Promise<void> {
    console.log(this.tag, "WS connected to", this.opts.wsUrl);
    this.reconnectAttempt = 0;
    this.startPing();
    try {
      const payload = await this.opts.getRegistrationPayload();
      this.wsSend({ type: "register", payload });
      console.log(this.tag, "WS sent register message, bot_open_id=" + payload.bot_open_id);
    } catch (err) {
      console.error(this.tag, "WS failed to build registration payload:", err);
    }
  }

  private onMessage(event: MessageEvent): void {
    let msg: WsRegistryMessage;
    try {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      msg = JSON.parse(data) as WsRegistryMessage;
    } catch { console.warn(this.tag, "WS received non-JSON message, ignoring"); return; }

    switch (msg.type) {
      case "registered":
        this._registered = true;
        console.log(this.tag, "WS registration acknowledged by Registry");
        this.opts.onRegistered?.();
        break;
      case "inbound":
        console.log(this.tag, "WS received inbound message, chat=" + msg.payload?.chat_id);
        this.opts.onInbound?.(msg.payload);
        break;
      case "pong":
        break;
      case "error":
        console.error(this.tag, "WS received error from Registry:", msg.payload?.message);
        break;
      default:
        console.warn(this.tag, "WS received unknown message type:", (msg as { type?: string }).type);
    }
  }

  private onClose(event: CloseEvent): void {
    console.log(this.tag, "WS closed code=" + event.code, "reason=" + (event.reason || "(none)"));
    this._registered = false;
    this.stopPing();
    this.ws = null;
    if (!this.closed) this.scheduleReconnect();
  }

  private onError(event: Event): void {
    console.error(this.tag, "WS error event");
    this.opts.onError?.(event);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delayIndex = Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[delayIndex];
    this.reconnectAttempt++;
    console.log(this.tag, "WS will reconnect in " + delay + "ms");
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.doConnect(); }, delay);
  }

  private wsSend(msg: WsBotMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(msg)); return true; } catch (err) { console.error(this.tag, "WS send error:", err); return false; }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => { this.wsSend({ type: "ping" }); }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

// ── Backward-compatible module-level API ──────────────────────────────────
// These wrap a default singleton instance for code that expects the old API.

let defaultClient: WsRegistryClient | null = null;

/**
 * Establish a WebSocket connection to the Registry.
 * For multi-account support, use connectToRegistryMulti() instead.
 */
export function connectToRegistry(opts: WsClientOptions): void {
  if (defaultClient) defaultClient.close();
  defaultClient = new WsRegistryClient(opts);
  defaultClient.connect();
}

/** Check if the default WS connection is open and registered */
export function isConnected(): boolean {
  return defaultClient?.isConnected ?? false;
}

/** Send a copy payload via the default WS connection */
export function sendCopy(payload: RegistryCopyPayload): boolean {
  return defaultClient?.sendCopy(payload) ?? false;
}

/** Close the default WS connection */
export function close(): void {
  defaultClient?.close();
  defaultClient = null;
}

// ── Multi-instance API ────────────────────────────────────────────────────

/**
 * Connect a named WS client instance (for multi-account support).
 * Each account gets its own WS connection + registration.
 */
export function connectToRegistryMulti(label: string, opts: WsClientOptions): WsRegistryClient {
  const existing = instances.get(label);
  if (existing) existing.close();
  const client = new WsRegistryClient({ ...opts, label });
  instances.set(label, client);
  client.connect();
  return client;
}

/** Send copy via ANY connected instance (tries all, returns true if any succeeded) */
export function sendCopyAny(payload: RegistryCopyPayload): boolean {
  // Try default client first
  if (defaultClient?.sendCopy(payload)) return true;
  // Try all named instances
  for (const client of instances.values()) {
    if (client.sendCopy(payload)) return true;
  }
  return false;
}

/** Close all WS client instances */
export function closeAll(): void {
  close();
  for (const [label, client] of instances) {
    client.close();
    instances.delete(label);
  }
}


/** Check if ANY WS connection (default or named) is connected and registered */
export function isAnyConnected(): boolean {
  if (defaultClient?.isConnected) return true;
  for (const client of instances.values()) {
    if (client.isConnected) return true;
  }
  return false;
}
