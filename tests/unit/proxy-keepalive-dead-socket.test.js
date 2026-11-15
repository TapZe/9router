import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("undici keep-alive dead-socket protection & fresh-socket retry", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.FETCH_KEEPALIVE_TIMEOUT_MS;
    delete process.env.FETCH_FRESH_RETRY;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("undici");
  });

  it("keeps the existing 4s default, clamps keepAliveMaxTimeout, and honors FETCH_KEEPALIVE_TIMEOUT_MS", async () => {
    const { resolveKeepAliveTimeouts } = await import("../../open-sse/config/runtimeConfig.js");

    expect(resolveKeepAliveTimeouts()).toEqual({
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 4_000,
    });

    process.env.FETCH_KEEPALIVE_TIMEOUT_MS = "1";
    expect(resolveKeepAliveTimeouts()).toEqual({
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    });
  });

  it("creates distinct shared direct and fresh-retry dispatchers", async () => {
    const {
      getDirectDispatcher,
      getFreshRetryDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const direct1 = await getDirectDispatcher(false);
    const direct2 = await getDirectDispatcher(false);
    const fresh1 = await getFreshRetryDispatcher(false);
    const fresh2 = await getFreshRetryDispatcher(false);

    expect(direct1).not.toBeNull();
    expect(direct1).toBe(direct2);
    expect(fresh1).not.toBeNull();
    expect(fresh1).toBe(fresh2);
    expect(fresh1).not.toBe(direct1);
  });

  it("classifies only provable dead-socket errors and excludes aborts/DNS/TLS/bare fetch failed", async () => {
    const { isStaleSocketError } = await import("../../open-sse/utils/proxyFetch.js");

    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "EPIPE" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }))).toBe(true);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: new Error("other side closed") }))).toBe(true);
    expect(isStaleSocketError(new Error("socket hang up"))).toBe(true);

    // A bare "fetch failed" with no code is ambiguous: the upstream may already have the
    // request, so replaying it could double-charge. Never treat it as a stale socket.
    expect(isStaleSocketError(new TypeError("fetch failed"))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_INVALID_ARG" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("aborted"), { name: "AbortError", cause: { code: "UND_ERR_SOCKET" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(false);
    expect(isStaleSocketError(Object.assign(new Error("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }))).toBe(false);
    expect(isStaleSocketError(null)).toBe(false);
  });

  it("replays once on the fresh-socket dispatcher when a pooled socket dies", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }))
      .mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const {
      proxyAwareFetch,
      getDirectDispatcher,
      getFreshRetryDispatcher,
      resetDirectDispatchersForTests,
    } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const res = await proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer nvapi-test" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const directDispatcher = await getDirectDispatcher(false);
    const freshDispatcher = await getFreshRetryDispatcher(false);

    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(directDispatcher);
    expect(fetchMock.mock.calls[1][1].dispatcher).toBe(freshDispatcher);
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer nvapi-test" });
  });

  it("does not replay on the fresh socket when the caller aborted or the body is a locked stream", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const controller = new AbortController();
    controller.abort();
    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay on an ambiguous bare fetch failed (request may have been served)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay when FETCH_FRESH_RETRY=off", async () => {
    process.env.FETCH_FRESH_RETRY = "off";
    const fetchMock = vi.fn()
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }));
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await expect(
      proxyAwareFetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the fresh-socket dispatcher immediately when forceFreshSocket is requested", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ status: 200, ok: true });
    vi.doMock("undici", async () => {
      const actual = await vi.importActual("undici");
      return { ...actual, fetch: fetchMock };
    });

    const { proxyAwareFetch, getFreshRetryDispatcher, resetDirectDispatchersForTests } = await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    await proxyAwareFetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      { forceFreshSocket: true }
    );

    const freshDispatcher = await getFreshRetryDispatcher(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(freshDispatcher);
  });

  it("BaseExecutor.execute sets forceFreshSocket=true when retrying after connect timeout or 502", async () => {
    const fetchMock = vi.fn();
    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => fetchMock(...args) }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const ex = new BaseExecutor("nvidia", {
      baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
      timeoutMs: 15,
      retry: { 502: { attempts: 2, delayMs: 0 } },
    });

    fetchMock
      .mockImplementationOnce((_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("fetch connect timeout");
          err.name = "AbortError";
          reject(err);
        });
      }))
      .mockResolvedValueOnce({ status: 200, headers: { get: () => "application/json" } });

    const out = await ex.execute({
      model: "deepseek-ai/deepseek-v4-flash",
      body: { messages: [] },
      stream: true,
      credentials: { apiKey: "nvapi-key" },
    });

    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][2]).toBeNull();
    expect(fetchMock.mock.calls[1][2]).toEqual({ forceFreshSocket: true });
  });

  it("DefaultExecutor.transformRequest strips stream_options on non-streaming calls without mutating input body", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const ex = new DefaultExecutor("nvidia");
    const input = {
      model: "deepseek-ai/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
    };

    const nonStreamBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input, false, { apiKey: "nvapi-x" });
    expect(nonStreamBody.stream_options).toBeUndefined();
    expect(input.stream_options).toEqual({ include_usage: true });

    const omittedStreamArgBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input);
    expect(omittedStreamArgBody.stream_options).toBeUndefined();

    const streamBody = ex.transformRequest("deepseek-ai/deepseek-v4-flash", input, true, { apiKey: "nvapi-x" });
    expect(streamBody.stream_options).toEqual({ include_usage: true });
  });
});

describe("proxyFetch response-header limit and adapter proxy-protocol filtering", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // An earlier case replaces the whole proxyFetch module with a single
    // export. Unmock before resetModules so this describe gets the real
    // dispatchers and the legacy proxy test keeps its own mock.
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    vi.doUnmock("undici");
    vi.resetModules();
    process.env = { ...savedEnv };
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    vi.doUnmock("undici");
  });

  it("keeps dispatcher identity when maxHeaderSize is omitted and separates configured agents", async () => {
    const { getDirectDispatcher, getFreshRetryDispatcher, resetDirectDispatchersForTests } =
      await import("../../open-sse/utils/proxyFetch.js");
    resetDirectDispatchersForTests();

    const directDefault = await getDirectDispatcher();
    const directExplicitDefault = await getDirectDispatcher(false);
    const directLarge = await getDirectDispatcher(false, 2 * 1024 * 1024);
    const freshDefault = await getFreshRetryDispatcher();
    const freshLarge = await getFreshRetryDispatcher(false, 2 * 1024 * 1024);

    expect(directDefault).toBe(directExplicitDefault);
    expect(directLarge).not.toBe(directDefault);
    expect(freshLarge).not.toBe(freshDefault);
  });

  it("fetches a large response header through the direct Node adapter", async () => {
    const { startHeaderServer } = await import("../fixtures/gemini-web/loopbackServers.js");
    const { geminiWebHttp1Fetch } = await import(
      "../../open-sse/executors/gemini-web/transport.js"
    );
    const server = await startHeaderServer({ headerBytes: 64 * 1024 });
    try {
      const response = await geminiWebHttp1Fetch(server.url, {
        method: "GET",
        maxHeaderSize: 2 * 1024 * 1024,
        strictTls: true,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-large-header")).toHaveLength(64 * 1024);
      expect(await response.text()).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("fetches a large response header through an HTTP CONNECT proxy", async () => {
    const { startHeaderServer, startHttpConnectProxy } = await import(
      "../fixtures/gemini-web/loopbackServers.js"
    );
    const { geminiWebDirectFetch } = await import(
      "../../open-sse/executors/gemini-web/transport.js"
    );
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const target = await startHeaderServer({ headerBytes: 64 * 1024 });
    const proxy = await startHttpConnectProxy();
    try {
      const response = await proxyAwareFetch(
        target.url,
        {
          method: "GET",
          maxHeaderSize: 2 * 1024 * 1024,
          strictTls: true,
          directFetch: geminiWebDirectFetch,
        },
        { enabled: true, url: proxy.url, strictProxy: true }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-large-header")).toHaveLength(64 * 1024);
      expect(await response.text()).toBe("ok");
      expect(proxy.connectCount()).toBe(1);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it.each(["socks5h", "socks5", "socks4", "socks4a", "socks"])(
    "fetches a large response header through a real %s loopback handshake",
    async (scheme) => {
      const { startHeaderServer, startSocks5Proxy, startSocks4Proxy } = await import(
        "../fixtures/gemini-web/loopbackServers.js"
      );
      const { geminiWebDirectFetch } = await import(
        "../../open-sse/executors/gemini-web/transport.js"
      );
      const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
      const target = await startHeaderServer({ headerBytes: 64 * 1024 });
      const proxy = scheme.startsWith("socks4")
        ? await startSocks4Proxy()
        : await startSocks5Proxy();
      const targetPort = new URL(target.url).port;
      try {
        const response = await proxyAwareFetch(
          `http://localhost:${targetPort}/`,
          {
            method: "GET",
            maxHeaderSize: 2 * 1024 * 1024,
            strictTls: true,
            directFetch: geminiWebDirectFetch,
          },
          {
            enabled: true,
            url: `${scheme}://${new URL(proxy.url).host}`,
            strictProxy: true,
          }
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-large-header")).toHaveLength(64 * 1024);
        expect(await response.text()).toBe("ok");
        expect(proxy.handshakes()).toBe(1);
      } finally {
        await proxy.close();
        await target.close();
      }
    }
  );

  it("keeps all-proxy behavior for adapters without proxyProtocols and restricts declared schemes", async () => {
    const { proxyAwareFetch, resetDirectDispatchersForTests } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );
    resetDirectDispatchersForTests();

    const unrestricted = vi.fn(async () => new Response("adapter-response"));
    unrestricted.proxyCapable = true;
    const unrestrictedResponse = await proxyAwareFetch(
      "https://gemini.google.com/app",
      { method: "GET", directFetch: unrestricted },
      { enabled: true, url: "socks5://127.0.0.1:1", strictProxy: true }
    );
    expect(await unrestrictedResponse.text()).toBe("adapter-response");
    expect(unrestricted).toHaveBeenCalledTimes(1);

    const restricted = vi.fn(async () => new Response("adapter-response"));
    restricted.proxyCapable = true;
    restricted.proxyProtocols = ["socks:", "socks5:", "socks5h:", "socks4:", "socks4a:"];
    const error = await proxyAwareFetch(
      "https://gemini.google.com/app",
      { method: "GET", directFetch: restricted },
      { enabled: true, url: "http://127.0.0.1:1", strictProxy: true }
    ).catch((caught) => caught);

    expect(restricted).not.toHaveBeenCalled();
    expect(error).toBeTruthy();
    expect(String(error.message)).toMatch(/proxy/i);
  });

  it("refuses a self-signed certificate with no insecure retry", async () => {
    const { startSelfSignedTlsServer } = await import(
      "../fixtures/gemini-web/loopbackServers.js"
    );
    const { geminiWebDirectFetch, geminiWebHttp1Fetch } = await import(
      "../../open-sse/executors/gemini-web/transport.js"
    );
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const server = await startSelfSignedTlsServer();
    try {
      for (const options of [{ strictTls: true }, {}, { strictTls: false }]) {
        const error = await geminiWebHttp1Fetch(server.url, {
          method: "GET",
          maxHeaderSize: 2 * 1024 * 1024,
          ...options,
        }).catch((caught) => caught);
        expect(error).toBeTruthy();
        expect(server.requestCount()).toBe(0);
      }

      const sharedError = await proxyAwareFetch(server.url, {
        method: "GET",
        maxHeaderSize: 2 * 1024 * 1024,
        strictTls: true,
        directFetch: geminiWebDirectFetch,
      }).catch((caught) => caught);
      expect(sharedError).toBeTruthy();
      expect(sharedError).not.toBeInstanceOf(Response);
      expect(server.requestCount()).toBe(0);
    } finally {
      await server.close();
    }
  });
});
