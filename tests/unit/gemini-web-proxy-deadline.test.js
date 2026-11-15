import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/executors/gemini-web/config.js", async (original) => {
  const config = await original();
  return { ...config, GEMINI_WEB_LIMITS: { ...config.GEMINI_WEB_LIMITS, bootstrapTimeoutMs: 30 } };
});
const { bootstrapGeminiWeb } = await import("../../open-sse/executors/gemini-web/protocol.js");
let proxy;
const sockets = new Set();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  proxy?.closeAllConnections();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
});

describe("Gemini Web HTTP-proxy deadlines", () => {
  it("ends a bootstrap when the local proxy never answers CONNECT", async () => {
    proxy = http.createServer();
    proxy.on("connect", (_request, socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const work = bootstrapGeminiWeb({
      cookieHeader: "__Secure-1PSID=synthetic-proxy-deadline",
      authUser: "0",
      signal: controller.signal,
      proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: `http://127.0.0.1:${proxy.address().port}`, strictProxy: true },
    }).then(() => ({ kind: "success" }), (error) => ({ kind: "error", message: error.message }));
    let timer;
    try {
      const result = await Promise.race([work, new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "missing-deadline" }), 300);
      })]);
      expect(result.kind).toBe("error");
      expect(result.message).toMatch(/timed out|timeout|aborted/i);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await work;
    }
  });
});
