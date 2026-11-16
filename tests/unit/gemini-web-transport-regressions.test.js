import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const TRANSPORT_URL = new URL("../../open-sse/executors/gemini-web/transport.js", import.meta.url).href;

const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().close();
  }
});

async function start(factory, options) {
  const server = await factory(options);
  servers.push(server);
  return server;
}

function runChildModule(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

describe("Gemini Web transport regressions", () => {
  it("survives an abort that lands while the SOCKS agent is still resolving", async () => {
    const result = await runChildModule(`
import { geminiWebHttp1Fetch } from ${JSON.stringify(TRANSPORT_URL)};
const controller = new AbortController();
queueMicrotask(() => controller.abort(new Error("caller cancelled")));
try {
  await geminiWebHttp1Fetch(
    "https://gemini.google.com/app",
    { signal: controller.signal },
    "socks5h://127.0.0.1:1"
  );
  console.log(JSON.stringify({ outcome: "resolved" }));
} catch (error) {
  console.log(JSON.stringify({ outcome: "rejected", name: error?.name, code: error?.code }));
}
`);

    expect(result.stderr).not.toMatch(/Unhandled 'error' event|uncaughtException/);
    expect(result.code).toBe(0);
    const lastLine = result.stdout.trim().split("\n").pop();
    expect(JSON.parse(lastLine)).toEqual({
      outcome: "rejected",
      name: "AbortError",
      code: "ABORT_ERR",
    });
  }, 20_000);
});

describe("proxyFetch null fetch init", () => {
  it("treats a null init as empty options on the proxied path", async () => {
    const { startHeaderServer, startHttpConnectProxy } = await import(
      "../fixtures/gemini-web/loopbackServers.js"
    );
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const target = await start(startHeaderServer, { headerBytes: 4 });
    const proxy = await start(startHttpConnectProxy);

    const response = await proxyAwareFetch(target.url, null, {
      enabled: true,
      url: proxy.url,
      strictProxy: true,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(proxy.connectCount()).toBe(1);
  });

  it("keeps the patched global fetch working with an explicit null init", async () => {
    const { startHeaderServer } = await import("../fixtures/gemini-web/loopbackServers.js");
    await import("../../open-sse/utils/proxyFetch.js");
    const target = await start(startHeaderServer, { headerBytes: 4 });
    const savedNoProxy = [process.env.NO_PROXY, process.env.no_proxy];
    process.env.NO_PROXY = "127.0.0.1";
    process.env.no_proxy = "127.0.0.1";
    try {
      const response = await globalThis.fetch(target.url, null);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      for (const [key, value] of [["NO_PROXY", savedNoProxy[0]], ["no_proxy", savedNoProxy[1]]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("rejects through strict proxy enforcement, not a null-init crash", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    const error = await proxyAwareFetch("https://example.test/v1/chat", null, {
      enabled: true,
      url: "http://127.0.0.1:1",
      strictProxy: true,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Proxy required but failed/);
    expect(error.message).toMatch(/fetch failed/);
    expect(error.message).not.toMatch(/properties of null/);
  });
});

describe("relay response-header limit", () => {
  const RELAY_URL = "https://relay-target.test/v1/chat";

  it("honors an explicit maxHeaderSize above the default limit", async () => {
    const { startHeaderServer } = await import("../fixtures/gemini-web/loopbackServers.js");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const relay = await start(startHeaderServer, { headerBytes: 64 * 1024 });

    const response = await proxyAwareFetch(
      RELAY_URL,
      { method: "POST", body: "{}", maxHeaderSize: 2 * 1024 * 1024 },
      { vercelRelayUrl: relay.url }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-large-header")).toHaveLength(64 * 1024);
    expect(await response.text()).toBe("ok");
    expect(relay.requestCount()).toBe(1);
  });

  it("keeps the default header limit when maxHeaderSize is omitted", async () => {
    const { startHeaderServer } = await import("../fixtures/gemini-web/loopbackServers.js");
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const relay = await start(startHeaderServer, { headerBytes: 64 * 1024 });

    const error = await proxyAwareFetch(
      RELAY_URL,
      { method: "POST", body: "{}" },
      { vercelRelayUrl: relay.url }
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(`${error.message} ${error.cause?.code || ""}`).toMatch(/UND_ERR_HEADERS_OVERFLOW|fetch failed/);
  });
});
