// Regression: provider-level thinking defaults are injected into the request
// body before Gemini Web's compatibility guard runs. extractThinking() reads
// `reasoning_effort` before the Claude/Gemini shapes, so the injected default
// hid a client's explicit disabled/budget control and the guard let an
// unservable request through to the executor.
//
// The guard must see the client's own intent first. Provider pinned/on defaults
// still apply when the client expressed none, and a model suffix keeps its
// precedence over the body.
//
// The effective intent is proven end-to-end: the real GeminiWebExecutor runs
// under handleChatCore against an injected Google transport, and the assertions
// read the thinking enum actually encoded in the captured StreamGenerate
// request plus the answer handed back to the client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_HTML_WITHOUT_CHANNEL_IDENTITY,
  SYNTHETIC_COOKIE,
  answerFrame,
  lengthPrefixedBody,
  modelDiscoveryBody,
  modelEntry,
} from "../fixtures/gemini-web/wireFixtures.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// The real executor is what encodes the wire thinking level; the only injected
// dependency is its external Google transport. handleChatCore keeps calling
// executor.execute() exactly as in production.
const harnessState = vi.hoisted(() => ({ transport: null }));

vi.mock("../../open-sse/executors/index.js", async () => {
  const { GeminiWebExecutor } = await import("../../open-sse/executors/gemini-web.js");
  const real = new GeminiWebExecutor();
  return {
    getExecutor: () => ({
      noAuth: false,
      execute: (args) => real.execute({ ...args, transport: harnessState.transport }),
      refreshCredentials: async () => null,
    }),
  };
});

const geminiWeb = await import("../../open-sse/executors/gemini-web.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  line: vi.fn(),
  errorLine: vi.fn(),
};

const MODELS = [
  { modelId: "auto-model-id", name: "Auto", modelNumber: 1 },
  { modelId: "pro-model-id", name: "Pro", modelNumber: 2 },
];

// Wire enums the executor maps low/medium/high onto (config.js).
const WIRE = { low: 1, medium: 4, high: 2 };

function discoveryBody() {
  return modelDiscoveryBody({
    tiers: [8],
    entries: MODELS.map((entry) => modelEntry(entry.modelId, entry.name, entry.name, entry.modelNumber)),
  });
}

// One local stand-in for the three Google endpoints this path reaches. It only
// serves fixtures; nothing is captured from a real account.
function createGeminiTransport() {
  const calls = [];
  const transport = vi.fn(async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    const parsed = new URL(call.url);
    if (parsed.origin === "https://www.google.com") return new Response("warm", { status: 200 });
    if (parsed.pathname === "/") return new Response("primed", { status: 200 });
    if (parsed.pathname.endsWith("/app")) {
      // These assertions read the thinking enum off the StreamGenerate wire, so
      // the account here has no channel identity and text chat stays on it.
      // Channel-lane precedence has its own case below.
      return new Response(BOOTSTRAP_HTML_WITHOUT_CHANNEL_IDENTITY, { status: 200 });
    }
    if (parsed.searchParams.has("rpcids")) return new Response(discoveryBody(), { status: 200 });
    if (parsed.pathname.includes("StreamGenerate")) {
      return new Response(lengthPrefixedBody([answerFrame("Hello")]), { status: 200 });
    }
    throw new Error(`unexpected Gemini Web request: ${call.url}`);
  });
  return { transport, calls };
}

function makeCredentials() {
  const now = new Date().toISOString();
  const record = {
    id: "session-precedence",
    name: "Precedence",
    cookieHeader: SYNTHETIC_COOKIE,
    fingerprint: "fingerprint-precedence",
    revision: 1,
    source: "paste",
    createdAt: now,
    updatedAt: now,
    lastRotatedAt: now,
  };
  return {
    connectionId: "gemini-web-precedence",
    apiKey: SYNTHETIC_COOKIE,
    providerSpecificData: { authUser: "" },
    geminiWebSession: {
      id: record.id,
      read: vi.fn(async () => record),
      commit: vi.fn(async (patch) => ({ ...record, ...patch, revision: record.revision + 1 })),
      recordModels: vi.fn(async () => {}),
    },
  };
}

function chatBody(overrides = {}) {
  return {
    model: "gemini-web/gemini-auto",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    ...overrides,
  };
}

async function runCore({ body = chatBody(), providerThinking = null, model = "gemini-auto" } = {}) {
  const harness = createGeminiTransport();
  harnessState.transport = harness.transport;
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "gemini-web", model },
    credentials: makeCredentials(),
    log: silentLog,
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    connectionId: "gemini-web-precedence",
    providerThinking,
    sourceFormatOverride: "openai",
  });
  return { result, calls: harness.calls };
}

const generationCalls = (calls) => calls.filter((call) => call.url.includes("StreamGenerate"));

function headerOf(call, name) {
  const headers = call.options.headers || {};
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function innerOf(call) {
  const request = JSON.parse(new URLSearchParams(String(call.options.body)).get("f.req"));
  return JSON.parse(request[1]);
}

function wireThinkingOf(calls) {
  const generation = generationCalls(calls).at(-1);
  expect(generation, "one StreamGenerate dispatch").toBeTruthy();
  return {
    header: JSON.parse(headerOf(generation, "x-goog-ext-525001261-jspb"))[15],
    inner: innerOf(generation)[80],
  };
}

async function answerOf(result) {
  return (await result.response.json()).choices[0].message.content;
}

beforeEach(() => {
  geminiWeb.resetGeminiWebSessionCache?.();
  harnessState.transport = null;
});

afterEach(() => {
  geminiWeb.resetGeminiWebSessionCache?.();
  harnessState.transport = null;
});

describe("Gemini Web thinking precedence", () => {
  it("rejects a client-disabled request before an `on` default can hide it", async () => {
    const { result, calls } = await runCore({
      body: chatBody({ thinking: { type: "disabled" } }),
      providerThinking: { mode: "on" },
    });

    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a client token budget before a pinned default can hide it", async () => {
    const { result, calls } = await runCore({
      body: chatBody({ thinking: { type: "enabled", budget_tokens: 2048 } }),
      providerThinking: { mode: "high" },
    });

    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a disabled effort before an `on` default can hide it", async () => {
    const { result, calls } = await runCore({
      body: chatBody({ reasoning_effort: "none" }),
      providerThinking: { mode: "on" },
    });

    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("keeps the model suffix authoritative over the body", async () => {
    const { result, calls } = await runCore({
      body: chatBody({ model: "gemini-web/gemini-auto(none)", reasoning_effort: "high" }),
      providerThinking: { mode: "on" },
    });

    expect(result.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { client: "high", pinned: "low", expected: WIRE.high },
    { client: "medium", pinned: "high", expected: WIRE.medium },
  ])(
    "sends the client's $client level, not the pinned $pinned default",
    async ({ client, pinned, expected }) => {
      const { result, calls } = await runCore({
        body: chatBody({ reasoning_effort: client }),
        providerThinking: { mode: pinned },
      });

      expect(result.success, result.error || "chat core returned an error").toBe(true);
      expect(result.response.status).toBe(200);
      expect(await answerOf(result)).toBe("Hello");
      expect(generationCalls(calls)).toHaveLength(1);
      expect(wireThinkingOf(calls)).toEqual({ header: expected, inner: expected });
    }
  );

  it("sends the low enum for an `on` default when the client expressed no intent", async () => {
    const { result, calls } = await runCore({ providerThinking: { mode: "on" } });

    expect(result.success, result.error || "chat core returned an error").toBe(true);
    expect(result.response.status).toBe(200);
    expect(await answerOf(result)).toBe("Hello");
    expect(wireThinkingOf(calls)).toEqual({ header: WIRE.low, inner: WIRE.low });
  });

  it("sends a pinned default high enum when the client expressed no intent", async () => {
    const { result, calls } = await runCore({ providerThinking: { mode: "high" } });

    expect(result.success, result.error || "chat core returned an error").toBe(true);
    expect(result.response.status).toBe(200);
    expect(await answerOf(result)).toBe("Hello");
    expect(wireThinkingOf(calls)).toEqual({ header: WIRE.high, inner: WIRE.high });
  });
});
