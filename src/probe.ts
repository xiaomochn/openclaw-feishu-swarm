import { createFeishuClient, type FeishuClientCredentials } from "./client.js";
import type { FeishuProbeResult } from "./types.js";

// Cache to reduce health-check API calls (free quota: 10k/month)
const SUCCESS_TTL = 60 * 60 * 1000; // 60 min
const FAILURE_TTL = 5 * 60 * 1000;  // 5 min
const cache = new Map<string, { result: FeishuProbeResult; expires: number }>();

export async function probeFeishu(creds?: FeishuClientCredentials): Promise<FeishuProbeResult> {
  if (!creds?.appId || !creds?.appSecret) {
    return {
      ok: false,
      error: "missing credentials (appId, appSecret)",
    };
  }

  const cached = cache.get(creds.appId);
  if (cached && Date.now() < cached.expires) {
    return cached.result;
  }

  try {
    const client = createFeishuClient(creds);
    const response = await (client as any).request({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      data: {},
    });

    if (response.code !== 0) {
      const result: FeishuProbeResult = {
        ok: false,
        appId: creds.appId,
        error: `API error: ${response.msg || `code ${response.code}`}`,
      };
      cache.set(creds.appId, { result, expires: Date.now() + FAILURE_TTL });
      return result;
    }

    const bot = response.bot || response.data?.bot;
    const result: FeishuProbeResult = {
      ok: true,
      appId: creds.appId,
      botName: bot?.app_name ?? bot?.bot_name,
      botOpenId: bot?.open_id,
    };
    cache.set(creds.appId, { result, expires: Date.now() + SUCCESS_TTL });
    return result;
  } catch (err) {
    const result: FeishuProbeResult = {
      ok: false,
      appId: creds.appId,
      error: err instanceof Error ? err.message : String(err),
    };
    cache.set(creds.appId, { result, expires: Date.now() + FAILURE_TTL });
    return result;
  }
}
