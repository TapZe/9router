// Thinking precedence is independent of transport: the client's own intent must
// beat a provider's pinned default before the executor encodes anything. Text
// chat is carried by the ProcessSession channel, so the enum that decides the
// turn has to be proven on that wire too, not only on StreamGenerate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_HTML,
  SYNTHETIC_COOKIE,
  modelDiscoveryBody,
  modelEntry,
} from "../fixtures/gemini-web/wireFixtures.js";
import { ARGON_BIND_RECORDS, argonBindBody } from "../fixtures/gemini-web/argonBindFixtures.js";

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

// The real executor encodes the thinking level; the only injected dependency is
// its external Google transport, exactly as the sibling precedence suite does.
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

const WIRE = { low: 1, medium: 4, high: 2 };

function discoveryBody() {
  return modelDiscoveryBody({
    tiers: [8],
    entries: MODELS.map((entry) => modelEntry(entry.modelId, entry.name, entry.name, entry.modelNumber)),
  });
}

/**
 * Minimal protobuf reader for the request record this test inspects. Only
 * length-delimited and varint fields are needed to reach the thinking enum.
 */
function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset: index };
    shift += 7;
  }
}

function readFields(buffer) {
  const fields = new Map();
  let index = 0;
  while (index < buffer.length) {
    const tag = readVarint(buffer, index);
    index = tag.offset;
    const number = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (wireType === 0) {
      const value = readVarint(buffer, index);
      index = value.offset;
      fields.set(number, value.value);
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(buffer, index);
      index = length.offset;
      fields.set(number, buffer.subarray(index, index + length.value));
      index += length.value;
      continue;
    }
    throw new Error(`unsupported wire type ${wireType} for field ${number}`);
  }
  return fields;
}

/** thinkingLevel as encoded in the ProcessSession request record. */
function channelThinkingOf(body) {
  const form = new URLSearchParams(String(body));
  const req0 = Buffer.from(form.get("req0___data__"), "base64");
  const body0 = readFields(readFields(req0).get(1));
  const payload = readFields(readFields(body0.get(8)).get(5));
  return readFields(payload.get(1)).get(81);
}

function createGeminiTransport() {
  const calls = [];
  const transport = vi.fn(async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    const parsed = new URL(call.url);
    if (parsed.origin === "https://www.google.com") return new Response("warm", { status: 200 });
    if (parsed.pathname === "/") return new Response("primed", { status: 200 });
    if (parsed.pathname.endsWith("/app")) return new Response(BOOTSTRAP_HTML, { status: 200 });
    if (parsed.searchParams.has("rpcids")) return new Response(discoveryBody(), { status: 200 });
    if (parsed.pathname === "/v1/processSession") {
      if (String(options.body || "").startsWith("count=0")) {
        return new Response('[[0,["c","synthetic-precedence-channel","0",8]]]', {
          status: 200,
          headers: { "x-http-session-id": "synthetic-precedence-gsession" },
        });
      }
      if (options.method === "GET") return new Response(argonBindBody([ARGON_BIND_RECORDS.find((r) => r.kind === "final-answer")]));
      return new Response("[[0,0,0]]", { status: 200 });
    }
    throw new Error(`unexpected Gemini Web request: ${call.url}`);
  });
  return { transport, calls };
}

function makeCredentials() {
  const now = new Date().toISOString();
  const record = {
    id: "session-precedence-channel",
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

function sentTurn(calls) {
  const sends = calls.filter(
    (call) => call.url.includes("processSession") && String(call.options.body || "").includes("req1___data__")
  );
  expect(sends, "one channel turn").toHaveLength(1);
  return channelThinkingOf(sends[0].options.body);
}

beforeEach(() => {
  geminiWeb.resetGeminiWebSessionCache?.();
});

afterEach(() => {
  harnessState.transport = null;
  vi.clearAllMocks();
});

describe("Gemini Web thinking precedence on the channel lane", () => {
  it.each([
    { client: "high", pinned: "low", expected: WIRE.high },
    { client: "medium", pinned: "high", expected: WIRE.medium },
  ])(
    "encodes the client's $client level, not the pinned $pinned default",
    async ({ client, pinned, expected }) => {
      const { result, calls } = await runCore({
        body: chatBody({ reasoning_effort: client }),
        providerThinking: { mode: pinned },
      });

      expect(result.success, result.error || "chat core returned an error").toBe(true);
      expect(result.response.status).toBe(200);
      expect(sentTurn(calls)).toBe(expected);
    }
  );

  it("encodes the low enum for an `on` default when the client expressed no intent", async () => {
    const { result, calls } = await runCore({ providerThinking: { mode: "on" } });

    expect(result.success, result.error || "chat core returned an error").toBe(true);
    expect(sentTurn(calls)).toBe(WIRE.low);
  });

  it("encodes a pinned high enum when the client expressed no intent", async () => {
    const { result, calls } = await runCore({ providerThinking: { mode: "high" } });

    expect(result.success, result.error || "chat core returned an error").toBe(true);
    expect(sentTurn(calls)).toBe(WIRE.high);
  });
});
