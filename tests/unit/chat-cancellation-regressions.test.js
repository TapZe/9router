// Cancellation reporting at the two boundaries where it used to leak:
//
//   1. combo treated a member's 499 response, a thrown status-499 error or a
//      thrown AbortError as if the ORIGINAL client had aborted, so a still
//      connected caller lost fallback. Member cancellation is a member failure;
//      only the combo's own caller signal may stop dispatch.
//   2. after a synthetic successful token refresh, a client abort during the
//      retry inference was swallowed and the stale 401 came back out, which the
//      account loop reads as "credential unhealthy" and cools the account.
//
// The retry regression runs the real Chat Completions executor against a
// loopback server; only the external refresh service is stubbed.
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const usage = vi.hoisted(() => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

vi.mock("@/lib/usageDb.js", () => usage);

vi.mock("../../open-sse/services/tokenRefresh.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    refreshWithRetry: vi.fn(async () => ({ accessToken: "refreshed-token" })),
  };
});

import { handleComboChat } from "../../open-sse/services/combo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { isNonReplayableResponse, markNonReplayableResponse } from "../../open-sse/utils/replayPolicy.js";

const silentLog = { info() {}, warn() {}, debug() {} };
const chatLog = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  line: vi.fn(),
  errorLine: vi.fn(),
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successResponse(content) {
  return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content } }] }, 200);
}

describe("combo cancellation source", () => {
  it("falls back when a member returns 499 while the caller is still connected", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "provider-a/member-a"
          ? jsonResponse({ error: { message: "Request cancelled", code: "request_aborted" } }, 499)
          : successResponse("served by member b");
      },
      log: silentLog,
      comboName: "member-499",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["provider-a/member-a", "provider-b/member-b"]);
    expect(result.status).toBe(200);
    expect((await result.json()).choices[0].message.content).toBe("served by member b");
  });

  it("falls back when a member throws AbortError while the caller is still connected", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        if (modelStr === "provider-a/member-a") {
          const error = new Error("upstream stream aborted");
          error.name = "AbortError";
          throw error;
        }
        return successResponse("served by member b");
      },
      log: silentLog,
      comboName: "member-abort",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["provider-a/member-a", "provider-b/member-b"]);
    expect(result.status).toBe(200);
  });

  it("falls back when a member throws an error carrying status 499 while the caller is connected", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        if (modelStr === "provider-a/member-a") {
          throw Object.assign(new Error("Request cancelled"), { status: 499 });
        }
        return successResponse("served by member b");
      },
      log: silentLog,
      comboName: "member-thrown-499",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["provider-a/member-a", "provider-b/member-b"]);
    expect(result.status).toBe(200);
  });

  it("still stops at a non-replayable member cancellation", async () => {
    const calls = [];
    const first = markNonReplayableResponse(
      jsonResponse({ error: { message: "generation already accepted", code: "request_aborted" } }, 499)
    );
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "provider-a/member-a" ? first : successResponse("served by member b");
      },
      log: silentLog,
      comboName: "marked-499",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["provider-a/member-a"]);
    expect(result.status).toBe(499);
    expect(isNonReplayableResponse(result)).toBe(true);
  });

  it("stops dispatching when the caller aborts mid-combo", async () => {
    const calls = [];
    const controller = new AbortController();
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        controller.abort();
        return successResponse("late result");
      },
      log: silentLog,
      comboName: "caller-abort-mid",
      comboStrategy: "fallback",
      signal: controller.signal,
    });

    expect(calls).toEqual(["provider-a/member-a"]);
    expect(result.status).toBe(499);
  });

  it("still falls back on a normal 503", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "provider-a/member-a"
          ? jsonResponse({ error: { message: "service unavailable" } }, 503)
          : successResponse("served by member b");
      },
      log: silentLog,
      comboName: "normal-503",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["provider-a/member-a", "provider-b/member-b"]);
    expect(result.status).toBe(200);
  });

  it("still falls back on a request-scoped 4xx", async () => {
    const calls = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["provider-a/member-a", "provider-b/member-b"],
      handleSingleModel: async (_body, modelStr) => {
        calls.push(modelStr);
        return modelStr === "provider-a/member-a"
          ? jsonResponse({ error: { message: "Request validation failed" } }, 400)
          : successResponse("served by member b");
      },
      log: silentLog,
      comboName: "request-scoped",
      comboStrategy: "fallback",
    });

    expect(calls).toEqual(["provider-a/member-a", "provider-b/member-b"]);
    expect(result.status).toBe(200);
  });
});

describe("chatCore cancellation during the post-refresh retry", () => {
  let server = null;
  let sockets = null;

  afterEach(async () => {
    for (const socket of sockets || []) socket.destroy();
    sockets = null;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    vi.clearAllMocks();
  });

  function startAuthThenHangServer(attempts) {
    sockets = new Set();
    server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        attempts.push({ authorization: request.headers.authorization, body: JSON.parse(raw) });
        if (attempts.length === 1) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "unauthorized" } }));
        }
        // The second attempt stays open until the client aborts it.
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets?.delete(socket));
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  }

  function coreOptions({ provider, model, connectionId, baseUrl, abort, onCredentialsRefreshed }) {
    const body = {
      model: `${provider}/${model}`,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    };
    return {
      body,
      modelInfo: { provider, model },
      credentials: {
        accessToken: "first-token",
        providerSpecificData: { baseUrl },
      },
      log: chatLog,
      clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
      connectionId,
      onCredentialsRefreshed,
      sourceFormatOverride: "openai",
      clientSignal: abort.signal,
    };
  }

  it("returns 499 instead of the pre-refresh 401 and does not cool the account", async () => {
    const provider = "openai-compatible-chat-cancellation";
    const model = "test-model";
    const connectionId = "cancel-retry";
    const attempts = [];
    await startAuthThenHangServer(attempts);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const abort = new AbortController();
    const onCredentialsRefreshed = vi.fn(async () => {});

    const resultPromise = handleChatCore(coreOptions({
      provider, model, connectionId, baseUrl, abort, onCredentialsRefreshed,
    }));

    await vi.waitFor(() => {
      if (attempts.length < 2) throw new Error("waiting for the post-refresh retry");
    }, { timeout: 5000, interval: 10 });
    abort.abort();

    const result = await resultPromise;

    expect(attempts).toHaveLength(2);
    expect(attempts[0].authorization).toBe("Bearer first-token");
    expect(attempts[1].authorization).toBe("Bearer refreshed-token");
    expect(onCredentialsRefreshed).toHaveBeenCalledTimes(1);

    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(checkFallbackError(result.status, result.error, 0, provider).shouldFallback).toBe(false);
    expect(usage.trackPendingRequest.mock.calls.at(-1)).toEqual([model, provider, connectionId, false, true]);
  });

  it("does not send the retry when the caller aborts right after the refresh", async () => {
    const provider = "openai-compatible-chat-cancellation";
    const model = "test-model";
    const connectionId = "cancel-before-retry";
    const attempts = [];
    await startAuthThenHangServer(attempts);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const abort = new AbortController();
    const onCredentialsRefreshed = vi.fn(async () => { abort.abort(); });

    const result = await handleChatCore(coreOptions({
      provider, model, connectionId, baseUrl, abort, onCredentialsRefreshed,
    }));

    expect(attempts).toHaveLength(1);
    expect(onCredentialsRefreshed).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe(499);
    expect(checkFallbackError(result.status, result.error, 0, provider).shouldFallback).toBe(false);
    expect(usage.trackPendingRequest.mock.calls.at(-1)).toEqual([model, provider, connectionId, false, true]);
  });
});
