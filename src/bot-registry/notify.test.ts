import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setCachedBotIdentity, notifySent } from "./notify.js";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";

describe("bot-registry notify", () => {
  const cfgNoRegistry = {} as ClawdbotConfig;
  const cfgWithRegistry = {
    channels: {
      feishu: {
        botRegistryUrl: "https://registry.example.com",
        botRegistryEnabled: true,
      },
    },
  } as ClawdbotConfig;

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve({ ok: true } as Response));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setCachedBotIdentity("", "");
  });

  it("setCachedBotIdentity stores bot_open_id", () => {
    setCachedBotIdentity("app_1", "ou_bot");
    notifySent({
      cfg: cfgWithRegistry,
      to: "oc_chat",
      chatId: "oc_chat",
      messageId: "msg_1",
      content: "hello",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.sender_bot_id).toBe("ou_bot");
  });

  it("notifySent is no-op when cfg has no botRegistryUrl", () => {
    notifySent({
      cfg: cfgNoRegistry,
      to: "oc_chat",
      chatId: "oc_chat",
      messageId: "msg_1",
      content: "hello",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("notifySent is no-op when no cached sender and no param senderBotId", () => {
    notifySent({
      cfg: cfgWithRegistry,
      to: "oc_chat",
      chatId: "oc_chat",
      messageId: "msg_1",
      content: "hello",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("notifySent sends copy payload when senderBotId provided", () => {
    notifySent({
      cfg: cfgWithRegistry,
      senderBotId: "ou_me",
      to: "oc_chat",
      chatId: "oc_chat",
      messageId: "msg_1",
      replyToMessageId: "msg_0",
      content: "hello",
      mentions: ["ou_a", "ou_b"],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://registry.example.com/copy",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.sender_bot_id).toBe("ou_me");
    expect(body.chat_id).toBe("oc_chat");
    expect(body.message_id).toBe("msg_1");
    expect(body.reply_to_message_id).toBe("msg_0");
    expect(body.content).toBe("hello");
    expect(body.mentions).toEqual(["ou_a", "ou_b"]);
    expect(body.sent_at_ms).toBeDefined();
  });

  it("notifySent parses at tag from content when mentions not provided", () => {
    setCachedBotIdentity("app_1", "ou_9cb0b8f1032bf4ca8f2eb03bc82619d1");
    notifySent({
      cfg: cfgWithRegistry,
      to: "oc_chat",
      chatId: "oc_chat",
      messageId: "msg_1",
      content: '<at user_id="ou_9cb0b8f1032bf4ca8f2eb03bc82619d4">机器人B</at> 你好',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.mentions).toEqual(["ou_9cb0b8f1032bf4ca8f2eb03bc82619d4"]);
    expect(body.content).toContain("你好");
  });
});
