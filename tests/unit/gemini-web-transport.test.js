import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchGeminiWeb, geminiWebHttp1Fetch } from "../../open-sse/executors/gemini-web/transport.js";

let server;
let heartbeat;
afterEach(async () => {
  clearInterval(heartbeat);
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
});

describe("Gemini Web native transport", () => {
  it("aborts body reads after headers instead of completing the upstream download", async () => {
    let upstream;
    server = http.createServer((_request, response) => {
      upstream = response;
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const response = await geminiWebHttp1Fetch(`http://127.0.0.1:${server.address().port}/bootstrap`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const body = response.text();
    controller.abort();
    upstream.end(" completed despite cancellation");
    await expect(body).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports a post-header deadline as an upstream failure, not a client cancellation", async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      heartbeat = setInterval(() => response.write("."), 5);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetchGeminiWeb(`http://127.0.0.1:${server.address().port}/bootstrap`, { timeoutMs: 50 });
    await expect(response.text()).rejects.toMatchObject({ status: 502, code: "gemini_web_upstream_error" });
  });
});
