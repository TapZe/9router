// Gemini Web image adapter — delegates to the executor's native image task.
// The generation turn, image collection and byte download all live in the
// executor; this module only maps the OpenAI image request/response shape.
import { nowSec } from "./_base.js";
import { getExecutor } from "../../executors/index.js";

export default {
  useExecutor: true,

  // Stubs - required by imageGenerationCore interface but unused with useExecutor
  buildUrl: () => "",
  buildHeaders: () => ({}),
  buildBody: () => ({}),

  async executeViaExecutor(model, body, credentials, log, { signal } = {}) {
    const executor = getExecutor("gemini-web");
    if (!executor) throw new Error("Gemini Web executor not found");

    const data = credentials?.providerSpecificData || {};
    const proxyOptions = {
      enabled: data.connectionProxyEnabled === true,
      url: data.connectionProxyUrl || "",
      connectionProxyEnabled: data.connectionProxyEnabled === true,
      connectionProxyUrl: data.connectionProxyUrl || "",
      connectionNoProxy: data.connectionNoProxy || "",
      vercelRelayUrl: data.vercelRelayUrl || "",
      proxyPoolId: data.connectionProxyPoolId || data.proxyPoolId || null,
      strictProxy: data.strictProxy === true,
    };

    const media = await executor.generateMedia({
      prompt: body.prompt,
      size: body.size,
      n: Math.max(1, Math.min(4, Number(body.n) || 1)),
      credentials,
      log,
      signal,
      proxyOptions,
    });

    return {
      created: nowSec(),
      data: media.map((m) => ({
        b64_json: m.b64,
        ...(m.mime ? { mime_type: m.mime } : {}),
      })),
    };
  },

  normalize: (responseBody) => responseBody,
};
