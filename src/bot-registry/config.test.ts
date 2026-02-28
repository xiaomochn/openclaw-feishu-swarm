import { describe, it, expect } from "vitest";
import {
  getRegistryConfig,
  configSchemaFragment,
  DEFAULT_BOT_REGISTRY_URL,
  resolveInboundBaseUrl,
  getGatewayPort,
  getPreferredLocalAddress,
  getInboundProxyPort,
  DEFAULT_INBOUND_PROXY_PORT,
} from "./config.js";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";

describe("bot-registry config", () => {
  it("getRegistryConfig returns null when channels.feishu not set", () => {
    const cfg = {} as ClawdbotConfig;
    expect(getRegistryConfig(cfg)).toBeNull();
  });

  it("getRegistryConfig returns default Registry url when botRegistryUrl empty", () => {
    const cfg = {
      channels: { feishu: { botRegistryUrl: "", botRegistryEnabled: true } },
    } as ClawdbotConfig;
    const out = getRegistryConfig(cfg);
    expect(out).not.toBeNull();
    expect(out!.url).toBe(DEFAULT_BOT_REGISTRY_URL);
  });

  it("getRegistryConfig returns default Registry url when botRegistryUrl whitespace only", () => {
    const cfg = {
      channels: { feishu: { botRegistryUrl: "  ", botRegistryEnabled: true } },
    } as ClawdbotConfig;
    const out = getRegistryConfig(cfg);
    expect(out).not.toBeNull();
    expect(out!.url).toBe(DEFAULT_BOT_REGISTRY_URL);
  });

  it("getRegistryConfig returns resolved inboundBaseUrl when inboundBaseUrl not set", () => {
    const cfg = {
      channels: { feishu: { appId: "x" } },
    } as ClawdbotConfig;
    const out = getRegistryConfig(cfg);
    expect(out).not.toBeNull();
    expect(out!.inboundBaseUrl).toBe(resolveInboundBaseUrl());
    expect(out!.inboundBaseUrl).toMatch(/^http:\/\/[\d.]+\:\d+$/);
  });

  it("resolveInboundBaseUrl returns http://host:port with default proxy port 18790", () => {
    const url = resolveInboundBaseUrl();
    expect(url).toMatch(/^http:\/\/[\d.]+\:\d+$/);
    const port = getInboundProxyPort() ?? DEFAULT_INBOUND_PROXY_PORT;
    expect(url).toContain(`:${port}`);
  });

  it("getInboundProxyPort returns null when env not set", () => {
    expect(getInboundProxyPort()).toBe(null);
  });

  it("DEFAULT_INBOUND_PROXY_PORT is 18790", () => {
    expect(DEFAULT_INBOUND_PROXY_PORT).toBe(18790);
  });

  it("getPreferredLocalAddress returns a non-empty IPv4 string", () => {
    const addr = getPreferredLocalAddress();
    expect(addr).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it("getRegistryConfig returns url and enabled true when url set", () => {
    const cfg = {
      channels: {
        feishu: {
          botRegistryUrl: "https://registry.example.com",
          botRegistryInboundBaseUrl: "https://gateway.example.com",
        },
      },
    } as ClawdbotConfig;
    const out = getRegistryConfig(cfg);
    expect(out).not.toBeNull();
    expect(out!.url).toBe("https://registry.example.com");
    expect(out!.enabled).toBe(true);
    expect(out!.inboundBaseUrl).toBe("https://gateway.example.com");
  });

  it("getRegistryConfig respects botRegistryEnabled false", () => {
    const cfg = {
      channels: {
        feishu: {
          botRegistryUrl: "https://registry.example.com",
          botRegistryEnabled: false,
        },
      },
    } as ClawdbotConfig;
    const out = getRegistryConfig(cfg);
    expect(out).not.toBeNull();
    expect(out!.enabled).toBe(false);
  });

  it("getRegistryConfig trims url and inboundBaseUrl", () => {
    const cfg = {
      channels: {
        feishu: {
          botRegistryUrl: "  https://registry.example.com/  ",
          botRegistryInboundBaseUrl: "  https://gateway.example.com  ",
        },
      },
    } as ClawdbotConfig;
    const out = getRegistryConfig(cfg);
    expect(out!.url).toBe("https://registry.example.com/");
    expect(out!.inboundBaseUrl).toBe("https://gateway.example.com");
  });

  it("configSchemaFragment has botRegistryUrl, botRegistryEnabled, botRegistryInboundBaseUrl", () => {
    expect(configSchemaFragment.botRegistryUrl).toBeDefined();
    expect(configSchemaFragment.botRegistryUrl.type).toBe("string");
    expect(configSchemaFragment.botRegistryEnabled).toBeDefined();
    expect(configSchemaFragment.botRegistryEnabled.type).toBe("boolean");
    expect(configSchemaFragment.botRegistryInboundBaseUrl).toBeDefined();
    expect(configSchemaFragment.botRegistryInboundBaseUrl.type).toBe("string");
  });
});
