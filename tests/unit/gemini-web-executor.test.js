// Wave 2A Gemini Web executor behavior: native protocol execution, image
// input/output, thinking controls, streaming parity, cancellation and probing.
//
// Every case drives the production executor entry points with an injected
// transport. No Playwright, no real cookies, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pre-cutover executor reaches for Playwright here; the native executor
// never does. Failing the loader keeps the red run fast and browser-free.
vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: vi.fn(async () => {
    throw new Error("Gemini Web must not launch a browser");
  }),
}));

import * as geminiWeb from "../../open-sse/executors/gemini-web.js";
import { isNonReplayableResponse } from "../../open-sse/utils/replayPolicy.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { buildImagePrompt } from "../../open-sse/executors/gemini-web/imageGen.js";
import { GEMINI_WEB_LIMITS } from "../../open-sse/executors/gemini-web/config.js";
import { estimateUsage } from "../../open-sse/utils/usageTracking.js";
import { buildJSONModePrompt, repairJSONPrompt } from "../../open-sse/executors/gemini-web/jsonMode.js";
import {
  BOOTSTRAP_HTML,
  BOOTSTRAP_HTML_WITHOUT_CHANNEL_IDENTITY,
  SIGN_IN_HTML,
  SYNTHETIC_COOKIE,
  answerFrame,
  answerPayload,
  imageFrame,
  labelFrame,
  lengthPrefixedBody,
  modelDiscoveryBody,
  modelEntry,
  payloadFrame,
  policyGroup,
  streamFromText,
  usageFrame,
} from "../fixtures/gemini-web/wireFixtures.js";
import {
  HTML_BYTES,
  JPEG_DATA_URL,
  PNG_DATA_URL,
  TINY_JPEG,
  TINY_PNG,
  toDataUrl,
} from "../fixtures/gemini-web/imageFixtures.js";

const AUTO_ENTRY = Object.freeze({ modelId: "auto-model-id", name: "Auto", modelNumber: 1 });
const PRO_ENTRY = Object.freeze({ modelId: "pro-model-id", name: "Pro", modelNumber: 2 });
const PUBLIC_MODELS = Object.freeze([
  { id: "gemini-auto", name: "Auto" },
  { id: "gemini-pro", name: "Pro" },
]);
const GENERATED_URL = "https://lh3.googleusercontent.com/generated-1";

const freshTimestamp = () => new Date().toISOString();
const staleTimestamp = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

function createTransport(handler) {
  const calls = [];
  const transport = vi.fn(async (url, options = {}, proxyOptions = null) => {
    const call = { url: String(url), options, proxyOptions };
    calls.push(call);
    return handler(call);
  });
  return { transport, calls };
}

function modelDiscovery(entries = [AUTO_ENTRY, PRO_ENTRY]) {
  return modelDiscoveryBody({
    tiers: [8],
    entries: entries.map((entry) => modelEntry(entry.modelId, entry.name, entry.name, entry.modelNumber)),
  });
}

function bodyText(frames, sizes) {
  const text = lengthPrefixedBody(frames);
  return sizes ? streamFromText(text, sizes) : text;
}

function answerResponse(frames = [answerFrame("Hello")], sizes) {
  return new Response(bodyText(frames, sizes), { status: 200 });
}

/**
 * One local stand-in for every Google endpoint the executor may call.
 * Each handler can be overridden per test; counts prove what was dispatched.
 */
function googleTransport(options = {}) {
  const state = {
    bootstrap: 0,
    discovery: 0,
    generation: 0,
    upload: 0,
    download: 0,
    rotate: 0,
    session: 0,
  };
  let uploadId = 0;

  const { transport, calls } = createTransport(async (call) => {
    const url = new URL(call.url);

    if (url.origin === "https://www.google.com") {
      return new Response("warm", { status: 200 });
    }

    if (url.origin === "https://accounts.google.com") {
      state.rotate += 1;
      return options.rotate
        ? options.rotate(call, state)
        : new Response("{}", { status: 200 });
    }

    if (url.origin === "https://content-push.googleapis.com") {
      state.upload += 1;
      if (call.options.method === "OPTIONS") return new Response(null, { status: 200 });
      if (call.options.body instanceof Uint8Array) {
        return new Response(`upload-${++uploadId}`, { status: 200 });
      }
      return new Response(null, {
        status: 200,
        headers: {
          "x-goog-upload-url": "https://content-push.googleapis.com/upload/session-1",
        },
      });
    }

    if (
      url.hostname === "googleusercontent.com" ||
      url.hostname.endsWith(".googleusercontent.com") ||
      url.hostname === "usercontent.google.com" ||
      url.hostname.endsWith(".usercontent.google.com")
    ) {
      state.download += 1;
      return options.download
        ? options.download(call, state)
        : new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } });
    }

    if (url.pathname === "/") return new Response("primed", { status: 200 });

    if (url.pathname.endsWith("/app")) {
      state.bootstrap += 1;
      // One fixture, two accounts. A test that supplies a channel handler is
      // exercising the channel, so it gets the page whose bootstrap carries the
      // consumer key. Otherwise the account has no channel identity and text
      // chat stays on StreamGenerate, which is what the wire contracts describe.
      const page = options.session ? BOOTSTRAP_HTML : BOOTSTRAP_HTML_WITHOUT_CHANNEL_IDENTITY;
      return options.app
        ? options.app(call, state)
        : new Response(page, { status: 200 });
    }

    if (url.searchParams.has("rpcids")) {
      state.discovery += 1;
      return options.discover
        ? options.discover(call, state)
        : new Response(modelDiscovery(), { status: 200 });
    }

    if (url.pathname === "/v1/processSession") {
      state.session += 1;
      if (!options.session) throw new Error(`unexpected ProcessSession request: ${call.url}`);
      return options.session(call, state);
    }

    if (url.pathname.includes("StreamGenerate")) {
      state.generation += 1;
      return options.generate ? options.generate(call, state) : answerResponse();
    }

    throw new Error(`unexpected Gemini Web request: ${call.url}`);
  });

  return { transport, calls, state };
}

function makeCredentials({
  authUser = "",
  connectionId = "conn-alpha",
  sessionId = "session-alpha",
  revision = 1,
  lastRotatedAt = freshTimestamp(),
  cookieHeader = SYNTHETIC_COOKIE,
  recordModels = vi.fn(async () => {}),
} = {}) {
  let record = {
    id: sessionId,
    name: "Alpha",
    cookieHeader,
    fingerprint: "fingerprint-alpha",
    revision,
    source: "paste",
    createdAt: freshTimestamp(),
    updatedAt: freshTimestamp(),
    lastRotatedAt,
  };

  const read = vi.fn(async () => record);
  const commit = vi.fn(async (patch) => {
    record = {
      ...record,
      revision: record.revision + 1,
      cookieHeader: patch.cookieHeader ?? record.cookieHeader,
      lastRotatedAt: patch.lastRotatedAt ?? record.lastRotatedAt,
    };
    return record;
  });

  const credentials = {
    connectionId,
    apiKey: cookieHeader,
    providerSpecificData: { authUser },
    geminiWebSession: { id: sessionId, read, commit, recordModels },
  };

  return { credentials, read, commit, recordModels, record: () => record };
}

const chatBody = (messages, extra = {}) => ({
  model: "gemini-auto",
  stream: false,
  messages,
  ...extra,
});

function userText(text) {
  return { role: "user", content: text };
}

function userImage(url) {
  return { role: "user", content: [{ type: "image_url", image_url: { url } }] };
}

async function executeWith(harness, { credentials, model = "gemini-auto", body, stream = false, signal, log } = {}) {
  const executor = new geminiWeb.GeminiWebExecutor();
  const creds = credentials || makeCredentials().credentials;
  return executor.execute({
    model,
    body: body || chatBody([userText("Hi")]),
    stream,
    credentials: creds,
    signal,
    log,
    transport: harness.transport,
  });
}

function headerOf(call, name) {
  const headers = call.options.headers || {};
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function formOf(call) {
  return new URLSearchParams(String(call.options.body));
}

function innerOf(call) {
  const request = JSON.parse(formOf(call).get("f.req"));
  return JSON.parse(request[1]);
}

const generationCalls = (calls) => calls.filter((call) => call.url.includes("StreamGenerate"));
const uploadCalls = (calls) => calls.filter((call) => call.url.includes("content-push.googleapis.com"));

function thinkingEnumOf(calls) {
  const generation = generationCalls(calls).at(-1);
  const header = JSON.parse(headerOf(generation, "x-goog-ext-525001261-jspb"));
  return header[15];
}

function uploadedFileEntries(calls) {
  const generation = generationCalls(calls).at(-1);
  const inner = innerOf(generation);
  return inner[0][3].map((entry) => [entry[0][0], entry[1]]);
}

function uploadedBytes(calls) {
  return uploadCalls(calls)
    .filter((call) => call.options.body instanceof Uint8Array)
    .map((call) => Buffer.from(call.options.body));
}

async function jsonOf(result) {
  return result.response.json();
}

async function readSse(result) {
  const text = await result.response.text();
  const chunks = [];
  let done = false;
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    chunks.push(JSON.parse(data));
  }
  return { chunks, done };
}

const streamedContent = (chunks) =>
  chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("");

const streamedReasoning = (chunks) =>
  chunks.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content || "").join("");

function hangingStream(frames) {
  const state = { cancelled: false };
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

beforeEach(() => {
  geminiWeb.resetGeminiWebSessionCache?.();
});

afterEach(() => {
  geminiWeb.resetGeminiWebSessionCache?.();
});

describe("Gemini Web prompt images", () => {
  it("accepts a user message whose only part is an image and uploads it", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([{ role: "user", content: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }] }]),
    });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(200);
    expect(payload.error).toBeUndefined();

    expect(uploadedBytes(harness.calls)).toHaveLength(1);
    expect(uploadedBytes(harness.calls)[0].equals(TINY_PNG)).toBe(true);
    expect(uploadedFileEntries(harness.calls)).toEqual([["upload-1", "image_1.png"]]);
    expect(innerOf(generationCalls(harness.calls).at(-1))[0][0]).toBe("[Image 1]");
  });

  it("keeps history and uploads two user images in prompt order", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([
        { role: "system", content: "You are terse." },
        {
          role: "user",
          content: [
            { type: "text", text: "First question" },
            { type: "image_url", image_url: { url: PNG_DATA_URL } },
          ],
        },
        { role: "assistant", content: "First answer" },
        {
          role: "user",
          content: [
            { type: "text", text: "Second question" },
            { type: "image_url", image_url: { url: JPEG_DATA_URL } },
          ],
        },
      ]),
    });

    expect(result.response.status).toBe(200);
    expect(uploadedBytes(harness.calls).map((bytes, index) => bytes.equals(index === 0 ? TINY_PNG : TINY_JPEG))).toEqual([
      true,
      true,
    ]);
    expect(uploadedFileEntries(harness.calls)).toEqual([
      ["upload-1", "image_1.png"],
      ["upload-2", "image_2.jpg"],
    ]);

    const prompt = innerOf(generationCalls(harness.calls).at(-1))[0][0];
    expect(prompt).toContain("System:\nYou are terse.");
    expect(prompt).toContain("Previous conversation:");
    expect(prompt).toContain("User: First question [Image 1]");
    expect(prompt).toContain("Assistant: First answer");
    expect(prompt).toContain("Current user message:\nSecond question [Image 2]");
    expect(prompt.indexOf("[Image 1]")).toBeLessThan(prompt.indexOf("[Image 2]"));
  });

  it("rejects a remote image URL without fetching it", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([userImage("https://example.com/cat.png")]),
    });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(400);
    expect(payload.error.code).toBe("unsupported_control_for_provider");
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects image bytes that do not match the declared type", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([userImage(toDataUrl("image/png", HTML_BYTES))]),
    });

    expect(result.response.status).toBe(400);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects image input above the aggregate budget with 413", async () => {
    const oversized = Buffer.alloc(GEMINI_WEB_LIMITS.inputImagesBytes + 1024);
    TINY_PNG.copy(oversized, 0);

    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([userImage(toDataUrl("image/png", oversized))]),
    });

    expect(result.response.status).toBe(413);
    expect(harness.calls).toHaveLength(0);
  });
});

describe("Gemini Web tool history", () => {
  const promptOf = (harness) => innerOf(generationCalls(harness.calls).at(-1))[0][0];
  const weatherCall = {
    id: "call_1",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"Hanoi"}' },
  };

  it("renders an earlier tool call and its result as text, the result as the current turn", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([
        { role: "system", content: "Use tools." },
        userText("Weather in Hanoi?"),
        { role: "assistant", content: null, tool_calls: [weatherCall] },
        { role: "tool", tool_call_id: "call_1", content: "30C, sunny" },
      ]),
    });

    expect(result.response.status).toBe(200);
    expect(promptOf(harness)).toBe(
      "System:\nUse tools.\n\nPrevious conversation:\nUser: Weather in Hanoi?\n\n" +
        'Assistant: [Call Tool: get_weather with ID call_1 and Input: {"city":"Hanoi"}]\n\n' +
        "Current user message:\n[Tool Result for ID call_1]: 30C, sunny"
    );
  });

  it("keeps assistant text before its tool calls and reads text-part tool results", async () => {
    const harness = googleTransport();
    await executeWith(harness, {
      body: chatBody([
        userText("Weather in Hanoi and Hue?"),
        {
          role: "assistant",
          content: "Checking both.",
          tool_calls: [
            weatherCall,
            { id: "call_2", type: "function", function: { name: "get_weather", arguments: { city: "Hue" } } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "30C" }] },
        { role: "tool", tool_call_id: "call_2", content: { temp: 25 } },
      ]),
    });

    const prompt = promptOf(harness);
    expect(prompt).toContain(
      "Assistant: Checking both.\n" +
        '[Call Tool: get_weather with ID call_1 and Input: {"city":"Hanoi"}]\n' +
        '[Call Tool: get_weather with ID call_2 and Input: {"city":"Hue"}]'
    );
    expect(prompt).toContain("User: [Tool Result for ID call_1]: 30C");
    expect(prompt).toContain('Current user message:\n[Tool Result for ID call_2]: {"temp":25}');
  });
});

describe("Gemini Web tool history edge cases", () => {
  const promptOf = (harness) => innerOf(generationCalls(harness.calls).at(-1))[0][0];

  it("writes calls and results with missing fields as empty text", async () => {
    const harness = googleTransport();
    await executeWith(harness, {
      body: chatBody([
        userText("Go"),
        { role: "assistant", content: "", tool_calls: [null, { id: "call_9" }] },
        { role: "tool", content: null },
        { role: "tool", tool_call_id: "call_9" },
      ]),
    });

    expect(promptOf(harness)).toBe(
      "Previous conversation:\nUser: Go\n\n" +
        "Assistant: [Call Tool:  with ID  and Input: {}]\n[Call Tool:  with ID call_9 and Input: {}]\n\n" +
        "User: [Tool Result for ID ]: \n\nCurrent user message:\n[Tool Result for ID call_9]: "
    );
  });

  it("uploads only user images, and reads tool_calls only on assistant turns", async () => {
    const harness = googleTransport();
    const image = { type: "image_url", image_url: { url: PNG_DATA_URL } };
    await executeWith(harness, {
      body: chatBody([
        { role: "user", content: [{ type: "text", text: "Look" }], tool_calls: [{ id: "x", function: { name: "f" } }] },
        { role: "assistant", content: [{ type: "text", text: "Seen" }, image] },
        { role: "tool", tool_call_id: "t1", content: [{ type: "text", text: "ok" }, image] },
        userText("And now?"),
      ]),
    });

    expect(harness.state.upload).toBe(0);
    expect(promptOf(harness)).toBe(
      "Previous conversation:\nUser: Look\n\nAssistant: Seen\n\nUser: [Tool Result for ID t1]: ok\n\n" +
        "Current user message:\nAnd now?"
    );
  });

  it("skips empty turns, so a trailing empty user message does not replace the last one", async () => {
    const harness = googleTransport();
    await executeWith(harness, { body: chatBody([userText("Hi"), { role: "assistant", content: "" }, userText("")]) });

    expect(promptOf(harness)).toBe("Hi");
  });

  it("needs a user turn with text, not only a tool result", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([userText(""), { role: "tool", tool_call_id: "t1", content: "ok" }]),
    });

    expect(result.response.status).toBe(400);
    expect((await jsonOf(result)).error.message).toBe("No user message found");
    expect(harness.state.generation).toBe(0);
  });
});

describe("Gemini Web tool calling", () => {
  const LOOKUP = {
    type: "function",
    function: {
      name: "lookup",
      description: "Look a word up",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
  };
  const CALL_REPLY = '{"tool_calls":[{"name":"lookup","arguments":{"q":"gemini"}}]}';
  const promptAt = (harness, index) => innerOf(generationCalls(harness.calls)[index])[0][0];

  function replies(...texts) {
    return (_call, state) => answerResponse([answerFrame(texts[Math.min(state.generation, texts.length) - 1])]);
  }
  replies.frames = (frames) => () => answerResponse(frames);

  it("returns a tool call from a bridged reply", async () => {
    const harness = googleTransport({ generate: replies(CALL_REPLY) });
    const result = await executeWith(harness, {
      body: chatBody([{ role: "system", content: "Be brief." }, userText("Define gemini")], { tools: [LOOKUP] }),
    });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(200);
    expect(payload.choices[0].finish_reason).toBe("tool_calls");
    expect(payload.choices[0].message.role).toBe("assistant");
    expect(payload.choices[0].message.content).toBeNull();
    expect(payload.choices[0].message.tool_calls).toEqual([
      { id: expect.stringMatching(/^call_/), type: "function", function: { name: "lookup", arguments: '{"q":"gemini"}' } },
    ]);
    expect(isNonReplayableResponse(result.response)).toBe(true);

    const prompt = promptAt(harness, 0);
    expect(prompt.startsWith("You are an OpenAI-compatible assistant running behind a bridge to Gemini web.")).toBe(true);
    expect(prompt).toContain("- name: lookup | description: Look a word up | parameters: ");
    expect(prompt.endsWith("\n\nConversation:\nSystem:\nBe brief.\n\nDefine gemini")).toBe(true);
  });

  it("keeps a plain answer under tool_choice auto with one turn", async () => {
    const harness = googleTransport({ generate: replies("Gemini is a constellation.") });
    const result = await executeWith(harness, { body: chatBody([userText("Define gemini")], { tools: [LOOKUP] }) });

    const payload = await jsonOf(result);
    expect(payload.choices[0].finish_reason).toBe("stop");
    expect(payload.choices[0].message).toEqual({ role: "assistant", content: "Gemini is a constellation." });
    expect(harness.state.generation).toBe(1);
  });

  it("sends a plain prompt when tool_choice is none", async () => {
    const harness = googleTransport({ generate: replies("Plain.") });
    const result = await executeWith(harness, {
      body: chatBody([userText("Define gemini")], { tools: [LOOKUP], tool_choice: "none" }),
    });

    expect((await jsonOf(result)).choices[0].message.content).toBe("Plain.");
    expect(promptAt(harness, 0)).toBe("Define gemini");
  });

  it("asks again with the reason when a forced call is unusable", async () => {
    const harness = googleTransport({
      generate: replies("Sure.", '{"tool_calls":[{"name":"lookup","arguments":{}}]}', CALL_REPLY),
    });
    const result = await executeWith(harness, {
      body: chatBody([userText("Define gemini")], { tools: [LOOKUP], tool_choice: "required" }),
    });

    const payload = await jsonOf(result);
    expect(payload.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"gemini"}');
    expect(harness.state.generation).toBe(3);
    expect(promptAt(harness, 1)).toContain(
      "Your previous reply could not be used: the reply contained no tool call. Reply again with JSON only"
    );
    expect(promptAt(harness, 2)).toContain('Your previous reply could not be used: tool "lookup": missing required argument "q".');
    expect(promptAt(harness, 2)).not.toContain("the reply contained no tool call");
  });

  it("fails with 502 instead of making up a call after three attempts", async () => {
    const harness = googleTransport({ generate: replies("I cannot call tools.") });
    const result = await executeWith(harness, {
      body: chatBody([userText("Define gemini")], {
        tools: [LOOKUP],
        tool_choice: { type: "function", function: { name: "lookup" } },
      }),
    });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(502);
    expect(payload.error.code).toBe("gemini_web_invalid_tool_call");
    expect(payload.error.message).toContain("after 3 attempts: the reply contained no tool call");
    expect(isNonReplayableResponse(result.response)).toBe(true);
    expect(harness.state.generation).toBe(3);
  });

  it("keeps a rejected first turn retryable", async () => {
    const harness = googleTransport({ generate: () => new Response("", { status: 429 }) });
    const result = await executeWith(harness, { body: chatBody([userText("Define gemini")], { tools: [LOOKUP] }) });

    expect(result.response.status).toBe(429);
    expect(isNonReplayableResponse(result.response)).toBe(false);
    expect(harness.state.generation).toBe(1);
  });

  it("streams a tool call as OpenAI tool_calls deltas after the whole reply", async () => {
    const harness = googleTransport({ generate: replies(CALL_REPLY) });
    const result = await executeWith(harness, {
      stream: true,
      body: chatBody([userText("Define gemini")], {
        stream: true,
        tools: [LOOKUP],
        stream_options: { include_usage: true },
      }),
    });

    const { chunks, done } = await readSse(result);
    expect(done).toBe(true);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[1].choices[0].delta.tool_calls).toEqual([
      { index: 0, id: expect.stringMatching(/^call_/), type: "function", function: { name: "lookup", arguments: '{"q":"gemini"}' } },
    ]);
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
    expect(chunks[3].choices).toEqual([]);
    expect(chunks[3].usage.total_tokens).toBeGreaterThan(0);
    expect(streamedContent(chunks)).toBe("");
  });

  it("streams the bridged text, not the raw JSON, for a text reply", async () => {
    const harness = googleTransport({ generate: replies('{"content":"A constellation."}') });
    const result = await executeWith(harness, {
      stream: true,
      body: chatBody([userText("Define gemini")], { stream: true, tools: [LOOKUP] }),
    });

    const { chunks, done } = await readSse(result);
    expect(done).toBe(true);
    expect(streamedContent(chunks)).toBe("A constellation.");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("shapes a bridged answer like a plain one, with Google's thoughts and estimated usage", async () => {
    const harness = googleTransport({
      generate: replies.frames([labelFrame("Weighing it"), answerFrame(CALL_REPLY)]),
    });
    const body = chatBody([userText("Define gemini")], { tools: [LOOKUP] });
    const before = Math.floor(Date.now() / 1000);
    const result = await executeWith(harness, { body });

    expect(result.response.headers.get("content-type")).toBe("application/json");
    const payload = await jsonOf(result);
    expect(payload.id).toMatch(/^chatcmpl-gw-[0-9a-f-]{24}$/);
    expect(payload.object).toBe("chat.completion");
    expect(payload.created).toBeGreaterThanOrEqual(before);
    expect(payload.created).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.choices[0].message.reasoning_content).toBe("Weighing it");
    const calls = payload.choices[0].message.tool_calls;
    expect(payload.usage).toEqual(
      estimateUsage(body, JSON.stringify(calls).length + "Weighing it".length, "openai")
    );
  });

  it("estimates text usage from the bridged text and streams thoughts first", async () => {
    const harness = googleTransport({
      generate: replies.frames([labelFrame("Weighing it"), answerFrame('{"content":"Plain."}')]),
    });
    const body = chatBody([userText("Define gemini")], {
      stream: true,
      tools: [LOOKUP],
      stream_options: { include_usage: true },
    });
    const result = await executeWith(harness, { stream: true, body });

    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const { chunks } = await readSse(result);
    expect(chunks.map((chunk) => chunk.choices[0]?.delta)).toEqual([
      { role: "assistant", content: "" },
      { reasoning_content: "Weighing it" },
      { content: "Plain." },
      {},
      undefined,
    ]);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(chunks[0].id).toMatch(/^chatcmpl-gw-[0-9a-f-]{24}$/);
    expect(chunks[0].created).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(chunks[0].created).toBeGreaterThan(Math.floor(Date.now() / 1000) - 60);
    expect(chunks.at(-1).usage).toEqual(estimateUsage(body, "Plain.".length + "Weighing it".length, "openai"));
  });

  it("fails with 502 when a bridged reply is empty", async () => {
    const harness = googleTransport({ generate: replies('{"content":""}') });
    const result = await executeWith(harness, { body: chatBody([userText("Define gemini")], { tools: [LOOKUP] }) });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(502);
    expect(payload.error.message).toBe("Gemini Web did not return an answer");
    expect(harness.state.generation).toBe(1);
  });

  it("stops when a bridged reply comes from another model", async () => {
    const payload = answerPayload(CALL_REPLY);
    payload[3] = { model: PRO_ENTRY.modelId };
    const harness = googleTransport({ generate: () => answerResponse([payloadFrame(payload)]) });
    const result = await executeWith(harness, { body: chatBody([userText("Define gemini")], { tools: [LOOKUP] }) });

    expect(result.response.status).toBe(502);
    expect((await jsonOf(result)).error.code).toBe("upstream_model_mismatch");
    expect(isNonReplayableResponse(result.response)).toBe(true);
    expect(harness.state.generation).toBe(1);
  });

  it("reports a cancellation during a bridged turn as 499", async () => {
    const body = chatBody([userText("Define gemini")], { tools: [LOOKUP] });
    const thrown = await executeWith(
      googleTransport({
        generate: () => {
          throw new DOMException("aborted", "AbortError");
        },
      }),
      { body }
    );
    const controller = new AbortController();
    const aborted = await executeWith(
      googleTransport({
        generate: () => {
          controller.abort();
          throw new Error("socket closed");
        },
      }),
      { body, signal: controller.signal }
    );

    for (const result of [thrown, aborted]) {
      expect(result.response.status).toBe(499);
      expect((await jsonOf(result)).error.message).toBe("The Gemini Web request was aborted");
    }
  });

  it("does not replay once Google accepted an earlier attempt, even if a retry is rejected", async () => {
    const harness = googleTransport({
      generate: (_call, state) =>
        state.generation === 1 ? answerResponse([answerFrame("No call.")]) : new Response("", { status: 429 }),
    });
    const debug = vi.fn();
    const result = await executeWith(harness, {
      body: chatBody([userText("Define gemini")], { tools: [LOOKUP], tool_choice: "required" }),
      log: { debug, info() {}, warn() {}, error() {} },
    });

    expect(result.response.status).toBe(429);
    expect(isNonReplayableResponse(result.response)).toBe(true);
    expect(harness.state.generation).toBe(2);
    expect(debug).toHaveBeenCalledWith(
      "GEMINI-WEB",
      "Unusable tool-bridge reply (attempt 1): the reply contained no tool call"
    );
  });
});

describe("Gemini Web JSON mode", () => {
  const PERSON_SCHEMA = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  };
  const PERSON_JSON = '{"name":"Ada","age":36}';
  const PERSON_FORMAT = { type: "json_schema", json_schema: { name: "person", strict: true, schema: PERSON_SCHEMA } };
  const DONE = {
    type: "function",
    function: { name: "done", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
  };
  const promptAt = (harness, index) => innerOf(generationCalls(harness.calls)[index])[0][0];
  const replies = (...texts) => (_call, state) =>
    answerResponse([answerFrame(texts[Math.min(state.generation, texts.length) - 1])]);
  const quietLog = () => ({ debug: vi.fn(), info() {}, warn: vi.fn(), error() {} });
  const ask = (harness, extra, options = {}) =>
    executeWith(harness, { body: chatBody([userText("Invent a person.")], extra), ...options });

  it("asks for JSON and returns the JSON without its fence", async () => {
    const harness = googleTransport({ generate: replies("Invented:\n```json\n" + PERSON_JSON + "\n```") });
    const result = await ask(harness, { response_format: PERSON_FORMAT });

    const payload = await jsonOf(result);
    expect(payload.choices[0].message).toEqual({ role: "assistant", content: PERSON_JSON });
    expect(payload.choices[0].finish_reason).toBe("stop");
    expect(harness.state.generation).toBe(1);
    expect(promptAt(harness, 0)).toBe(buildJSONModePrompt("Invent a person.", { schema: PERSON_SCHEMA }));
    expect(isNonReplayableResponse(result.response)).toBe(true);
  });

  it("repairs an unusable reply once, with the reason", async () => {
    const harness = googleTransport({
      generate: replies('Here is the person: {"name":"Ada"}', "```json\n" + PERSON_JSON + "\n```"),
    });
    const log = quietLog();
    const result = await ask(harness, { response_format: PERSON_FORMAT }, { log });

    expect((await jsonOf(result)).choices[0].message.content).toBe(PERSON_JSON);
    expect(harness.state.generation).toBe(2);
    expect(promptAt(harness, 1)).toBe(
      repairJSONPrompt(promptAt(harness, 0), { schema: PERSON_SCHEMA }, 'the reply is missing required key "age"')
    );
    expect(log.debug).toHaveBeenCalledWith(
      "GEMINI-WEB",
      'response_format reply was not usable: the reply is missing required key "age"'
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns the raw first reply when the repair is still unusable", async () => {
    const harness = googleTransport({ generate: replies("Sure! Here is the person you asked for.", "Still not JSON.") });
    const log = quietLog();
    const result = await ask(harness, { response_format: { type: "json_object" } }, { log });

    expect(result.response.status).toBe(200);
    expect((await jsonOf(result)).choices[0].message.content).toBe("Sure! Here is the person you asked for.");
    expect(harness.state.generation).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      "GEMINI-WEB",
      "Gemini reply still does not match response_format after one repair attempt; returning the raw reply: " +
        "the reply is not valid JSON"
    );
  });

  it("returns the raw first reply when the repair request fails", async () => {
    const harness = googleTransport({
      generate: (_call, state) =>
        state.generation === 1 ? answerResponse([answerFrame("Not JSON.")]) : new Response("", { status: 429 }),
    });
    const log = quietLog();
    const result = await ask(harness, { response_format: { type: "json_object" } }, { log });

    expect(result.response.status).toBe(200);
    expect((await jsonOf(result)).choices[0].message.content).toBe("Not JSON.");
    expect(log.warn.mock.calls[0][1]).toMatch(/^response_format repair request failed; returning the raw reply: /);
  });

  it("reports a cancellation during the repair as 499, not as the raw reply", async () => {
    const controller = new AbortController();
    const harness = googleTransport({
      generate: (_call, state) => {
        if (state.generation === 1) return answerResponse([answerFrame("Not JSON.")]);
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    const result = await ask(harness, { response_format: { type: "json_object" } }, { signal: controller.signal });

    expect(result.response.status).toBe(499);
  });

  it("ignores text, unknown and missing response_format types", async () => {
    for (const response_format of [{ type: "text" }, { type: "xml" }, "json_object", null]) {
      const harness = googleTransport({ generate: replies("The answer is 42.") });
      const result = await ask(harness, { response_format });

      expect((await jsonOf(result)).choices[0].message.content).toBe("The answer is 42.");
      expect(promptAt(harness, 0)).toBe("Invent a person.");
      expect(harness.state.generation).toBe(1);
    }
  });

  it("keeps images out of a JSON reply but returns them when there is no text", async () => {
    const withText = googleTransport({
      generate: () => answerResponse([imageFrame({ url: GENERATED_URL, text: PERSON_JSON })]),
    });
    expect((await jsonOf(await ask(withText, { response_format: { type: "json_object" } }))).choices[0].message.content).toBe(
      PERSON_JSON
    );

    const imageOnly = googleTransport({ generate: () => answerResponse([imageFrame({ url: GENERATED_URL })]) });
    const content = (await jsonOf(await ask(imageOnly, { response_format: { type: "json_object" } }))).choices[0].message
      .content;
    expect(content).toBe(`![Generated image 1](<${GENERATED_URL}>)`);
    expect(imageOnly.state.generation).toBe(1);
  });

  it("uses the JSON-mode prompt, not the bridge, when tool_choice is none", async () => {
    const harness = googleTransport({ generate: replies(PERSON_JSON) });
    await ask(harness, { response_format: { type: "json_object" }, tools: [DONE], tool_choice: "none" });

    expect(promptAt(harness, 0)).toBe(buildJSONModePrompt("Invent a person.", { schema: null }));
  });

  it("does not ask for JSON again after a tool call", async () => {
    const harness = googleTransport({ generate: replies('{"tool_calls":[{"name":"done","arguments":{"answer":"x"}}]}') });
    const result = await ask(harness, {
      response_format: { type: "json_object" },
      tools: [DONE],
      tool_choice: { type: "function", function: { name: "done" } },
    });

    const payload = await jsonOf(result);
    expect(payload.choices[0].finish_reason).toBe("tool_calls");
    expect(payload.choices[0].message.content).toBeNull();
    expect(harness.state.generation).toBe(1);
    expect(promptAt(harness, 0)).toContain('"content" must be the reply itself as a JSON object (not a string)');
  });

  it("unwraps a JSON object given as the bridge content", async () => {
    for (const response_format of [{ type: "json_object" }, PERSON_FORMAT]) {
      const harness = googleTransport({ generate: replies(`{"content":${PERSON_JSON}}`) });
      const result = await ask(harness, { response_format, tools: [DONE] });

      expect((await jsonOf(result)).choices[0].message.content).toBe(PERSON_JSON);
      expect(harness.state.generation).toBe(1);
    }
  });

  it("repairs bridge content with one more turn", async () => {
    const harness = googleTransport({ generate: replies('{"content":"Sure, here you go."}', '{"content":"{\\"ok\\":true}"}') });
    const result = await ask(harness, { response_format: { type: "json_object" }, tools: [DONE] });

    expect((await jsonOf(result)).choices[0].message.content).toBe('{"ok":true}');
    expect(harness.state.generation).toBe(2);
    expect(promptAt(harness, 1).startsWith(promptAt(harness, 0))).toBe(true);
    expect(promptAt(harness, 1)).toContain("Your previous reply could not be used: the reply is not valid JSON.");
  });

  it("spends one turn on a bridge repair, even when that reply is an unusable call", async () => {
    const harness = googleTransport({
      generate: replies('{"content":"Sure, here you go."}', '{"tool_calls":[{"name":"done","arguments":{}}]}'),
    });
    const result = await ask(harness, { response_format: { type: "json_object" }, tools: [DONE] });

    expect((await jsonOf(result)).choices[0].message.content).toBe("Sure, here you go.");
    expect(harness.state.generation).toBe(2);
  });

  it("streams the clean JSON as one content delta", async () => {
    const harness = googleTransport({ generate: replies("Here you go:\n```json\n" + PERSON_JSON + "\n```") });
    const result = await executeWith(harness, {
      stream: true,
      body: chatBody([userText("Invent a person.")], { stream: true, response_format: PERSON_FORMAT }),
    });

    const { chunks, done } = await readSse(result);
    expect(done).toBe(true);
    expect(streamedContent(chunks)).toBe(PERSON_JSON);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });
});

describe("Gemini Web buffered stream heartbeat", () => {
  const LOOKUP = {
    type: "function",
    function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
  };
  const CALL_REPLY = '{"tool_calls":[{"name":"lookup","arguments":{"q":"gemini"}}]}';
  const HEARTBEAT = ": keep-alive\n\n";

  /** A Google answer body the test finishes by hand. */
  function heldAnswer() {
    const held = { cancelled: false };
    held.response = new Response(
      new ReadableStream({
        start(controller) {
          held.controller = controller;
        },
        cancel() {
          held.cancelled = true;
        },
      }),
      { status: 200 }
    );
    held.finish = (text) => {
      held.controller.enqueue(new TextEncoder().encode(bodyText([answerFrame(text)])));
      held.controller.close();
    };
    return held;
  }

  /** Reads the raw SSE text as it arrives. */
  function sseReader(result) {
    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    return {
      reader,
      next: async () => {
        const { value, done } = await reader.read();
        if (!done) seen += decoder.decode(value, { stream: true });
        return done ? null : decoder.decode(value);
      },
      rest: async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return seen;
          seen += decoder.decode(value, { stream: true });
        }
      },
    };
  }

  const toolStream = (harness, extra = {}) =>
    executeWith(harness, {
      stream: true,
      body: chatBody([userText("Define gemini")], { stream: true, tools: [LOOKUP], ...extra }),
    });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends an SSE comment every 15 seconds while the reply is buffered, then the reply", async () => {
    const held = heldAnswer();
    const harness = googleTransport({ generate: () => held.response });
    const result = await toolStream(harness);
    expect(result.response.status).toBe(200);
    expect(isNonReplayableResponse(result.response)).toBe(true);

    const sse = sseReader(result);
    expect(JSON.parse((await sse.next()).slice(6)).choices[0].delta).toEqual({ role: "assistant", content: "" });
    vi.advanceTimersByTime(14999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(await sse.next()).toBe(HEARTBEAT);
    vi.advanceTimersByTime(15000);
    expect(await sse.next()).toBe(HEARTBEAT);

    held.finish(CALL_REPLY);
    const text = await sse.rest();
    const data = text.split("\n\n").filter((line) => line.startsWith("data: "));
    expect(data.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(data.at(-3).slice(6)).choices[0].delta.tool_calls[0].function.arguments).toBe('{"q":"gemini"}');
    expect(JSON.parse(data.at(-2).slice(6)).choices[0].finish_reason).toBe("tool_calls");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the heartbeat when the reply fails", async () => {
    const held = heldAnswer();
    const harness = googleTransport({ generate: () => held.response });
    const sse = sseReader(await toolStream(harness));

    await sse.next();
    vi.advanceTimersByTime(15000);
    expect(await sse.next()).toBe(HEARTBEAT);
    held.controller.error(new Error("socket reset"));

    const text = await sse.rest();
    expect(text).not.toContain("[DONE]");
    expect(JSON.parse(text.trim().split("\n\n").at(-1).slice(6)).error.type).toBe("upstream_error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the heartbeat and Google's stream when the client cancels", async () => {
    const held = heldAnswer();
    const harness = googleTransport({ generate: () => held.response });
    const sse = sseReader(await toolStream(harness));

    await sse.next();
    vi.advanceTimersByTime(15000);
    expect(await sse.next()).toBe(HEARTBEAT);
    await sse.reader.cancel("client went away");
    await vi.waitFor(() => expect(held.cancelled).toBe(true));

    expect(vi.getTimerCount()).toBe(0);
    expect(harness.state.generation).toBe(1);
  });

  it("ends the stream with the invalid tool call error after three attempts", async () => {
    const harness = googleTransport({ generate: () => answerResponse([answerFrame("No call.")]) });
    const result = await toolStream(harness, { tool_choice: "required" });

    const { chunks, done } = await readSse(result);
    expect(result.response.status).toBe(200);
    expect(done).toBe(false);
    expect(chunks.at(-1).error).toMatchObject({ code: "gemini_web_invalid_tool_call", type: "upstream_error" });
    expect(harness.state.generation).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a rejected first turn as an HTTP error, before any stream starts", async () => {
    const harness = googleTransport({ generate: () => new Response("", { status: 429 }) });
    const result = await toolStream(harness);

    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(isNonReplayableResponse(result.response)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends no heartbeat on a plain stream", async () => {
    const held = heldAnswer();
    const harness = googleTransport({ generate: () => held.response });
    const result = await executeWith(harness, { stream: true, body: chatBody([userText("Hi")], { stream: true }) });
    const sse = sseReader(result);

    await sse.next();
    vi.advanceTimersByTime(60000);
    expect(vi.getTimerCount()).toBe(0);
    held.finish("Hello");

    const text = await sse.rest();
    expect(text).not.toContain(": keep-alive");
    expect(text).toContain('"content":"Hello"');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

describe("Gemini Web request contract", () => {
  it("rejects legacy functions and non-function tools before any upstream call", async () => {
    const harness = googleTransport();
    const fn = { name: "lookup", parameters: { type: "object", properties: {} } };

    const withFunctions = await executeWith(harness, {
      body: chatBody([userText("Hi")], { functions: [fn] }),
    });
    const withBuiltInTool = await executeWith(harness, {
      body: chatBody([userText("Hi")], { tools: [{ type: "function", function: fn }, { type: "web_search" }] }),
    });
    const withUndeclaredForcedTool = await executeWith(harness, {
      body: chatBody([userText("Hi")], {
        tools: [{ type: "function", function: fn }],
        tool_choice: { type: "function", function: { name: "other" } },
      }),
    });

    const params = [];
    for (const result of [withFunctions, withBuiltInTool, withUndeclaredForcedTool]) {
      const payload = await jsonOf(result);
      expect(result.response.status).toBe(400);
      expect(payload.error.code).toBe("unsupported_control_for_provider");
      params.push(payload.error.param);
    }
    expect(params).toEqual(["functions", "tools", "tools"]);
    expect(harness.calls).toHaveLength(0);
  });

  it("accepts low, medium, high and automatic thinking with the matching wire enum", async () => {
    const cases = [
      { body: { reasoning_effort: "low" }, expected: 1 },
      { body: { reasoning_effort: "medium" }, expected: 4 },
      { body: { reasoning_effort: "high" }, expected: 2 },
      { body: { reasoning_effort: "auto" }, expected: 1 },
      { body: {}, expected: 1 },
      { body: { reasoning_effort: "high" }, model: "gemini-auto(low)", expected: 1 },
    ];

    for (const testCase of cases) {
      const harness = googleTransport();
      const result = await executeWith(harness, {
        body: chatBody([userText("Hi")], testCase.body),
        model: testCase.model || "gemini-auto",
      });

      expect(result.response.status).toBe(200);
      expect(thinkingEnumOf(harness.calls)).toBe(testCase.expected);
    }
  });

  it("rejects disabled thinking, token budgets and numeric model suffixes", async () => {
    const cases = [
      { body: { reasoning_effort: "none" } },
      { body: { reasoning_effort: "minimal" } },
      { body: { thinking: { type: "disabled" } } },
      { body: { thinking: { type: "enabled", budget_tokens: 10000 } } },
      { body: { thinkingConfig: { thinkingBudget: 8192 } } },
      { body: { reasoning_effort: "xhigh" } },
      { body: { reasoning_effort: "low" }, model: "gemini-auto(8192)" },
      { body: { reasoning_effort: "low" }, model: "gemini-auto(none)" },
      { body: { reasoning_effort: "low" }, model: "gemini-auto(max)" },
    ];

    for (const testCase of cases) {
      const harness = googleTransport();
      const result = await executeWith(harness, {
        body: chatBody([userText("Hi")], testCase.body),
        model: testCase.model || "gemini-auto",
      });

      const payload = await jsonOf(result);
      expect(result.response.status).toBe(400);
      expect(payload.error.code).toBe("unsupported_control_for_provider");
      expect(harness.calls).toHaveLength(0);
    }
  });

  it("answers 404 model_not_found for a model this slot does not advertise", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      model: "gemini-mystery",
      body: chatBody([userText("Hi")]),
    });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(404);
    expect(payload.error.code).toBe("model_not_found");
    expect(harness.state.generation).toBe(0);
  });
});

describe("Gemini Web responses", () => {
  it("streams the same answer as the non-stream response without duplicating prefixes", async () => {
    const frames = [
      answerFrame("Hel"),
      answerFrame("Hello"),
      answerFrame("Hello"),
      answerFrame("Hel"),
      answerFrame("Hello world"),
    ];

    const harness = googleTransport({ generate: () => answerResponse(frames, [5, 3, 1]) });
    const streamed = await executeWith(harness, { stream: true });
    const { chunks, done } = await readSse(streamed);

    expect(streamed.response.status).toBe(200);
    expect(done).toBe(true);
    expect(streamedContent(chunks)).toBe("Hello world");

    const nonStreamHarness = googleTransport({ generate: () => answerResponse(frames) });
    const nonStream = await executeWith(nonStreamHarness, { stream: false });
    const payload = await jsonOf(nonStream);

    expect(payload.choices[0].message.content).toBe("Hello world");
    expect(streamedContent(chunks)).toBe(payload.choices[0].message.content);

    const ids = new Set(chunks.map((chunk) => chunk.id));
    expect(ids.size).toBe(1);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("emits Gemini thought summaries as reasoning_content", async () => {
    const frames = [
      labelFrame("Thinking about it"),
      labelFrame("Thinking about it"),
      labelFrame("Checking the details"),
      answerFrame("Final answer"),
    ];

    const streamHarness = googleTransport({ generate: () => answerResponse(frames, [9, 4]) });
    const streamed = await executeWith(streamHarness, { stream: true });
    const { chunks } = await readSse(streamed);

    expect(streamedReasoning(chunks)).toBe("Thinking about it\nChecking the details");
    expect(streamedContent(chunks)).toBe("Final answer");

    const nonStreamHarness = googleTransport({ generate: () => answerResponse(frames) });
    const nonStream = await executeWith(nonStreamHarness, { stream: false });
    const payload = await jsonOf(nonStream);

    expect(payload.choices[0].message.reasoning_content).toBe("Thinking about it\nChecking the details");
    expect(payload.choices[0].message.content).toBe("Final answer");
  });

  it("treats thought progress labels alone as an upstream error, never an empty success", async () => {
    const harness = googleTransport({ generate: () => answerResponse([labelFrame("Thinking")]) });
    const result = await executeWith(harness, { stream: false });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(502);
    expect(payload.error.code).toBe("gemini_web_upstream_error");
    expect(isNonReplayableResponse(result.response)).toBe(true);
  });

  it("streams Google's own usage when the client asks for it", async () => {
    const usage = { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 };
    const harness = googleTransport({ generate: () => answerResponse([usageFrame("Counted", usage)]) });
    const result = await executeWith(harness, {
      stream: true,
      body: chatBody([userText("Hi")], { stream: true, stream_options: { include_usage: true } }),
    });

    const { chunks, done } = await readSse(result);
    expect(done).toBe(true);
    expect(streamedContent(chunks)).toBe("Counted");
    expect(chunks.at(-2).choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1)).toMatchObject({
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    });
  });

  it("ends a stream with an error when Google answers with a different model", async () => {
    const payload = answerPayload("Wrong model");
    payload[3] = { model: PRO_ENTRY.modelId };
    const harness = googleTransport({ generate: () => answerResponse([payloadFrame(payload)]) });
    const result = await executeWith(harness, { stream: true, body: chatBody([userText("Hi")], { stream: true }) });

    const { chunks, done } = await readSse(result);
    expect(done).toBe(false);
    expect(chunks.at(-1).error.code).toBe("upstream_model_mismatch");
    expect(isNonReplayableResponse(result.response)).toBe(true);
  });

  it("does not send a consumed mismatched generation to the fallback account", async () => {
    const payload = answerPayload("Already generated on the wrong model");
    payload[3] = { model: PRO_ENTRY.modelId };
    const harness = googleTransport({ generate: () => answerResponse([payloadFrame(payload)]) });
    const attempts = [];
    const response = await handleComboChat({
      body: chatBody([userText("Hi")]),
      models: ["gemini-web/gemini-auto", "other/fallback"],
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        if (model === "gemini-web/gemini-auto") return (await executeWith(harness)).response;
        return new Response(JSON.stringify({ choices: [{ message: { content: "Fallback answer" } }] }));
      },
      log: { info() {}, warn() {}, debug() {} },
      comboName: "mismatch",
      comboStrategy: "fallback",
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("upstream_model_mismatch");
    expect(attempts).toEqual(["gemini-web/gemini-auto"]);
    expect(harness.state.generation).toBe(1);
  });


  it("appends generated-image links after the answer in both modes", async () => {
    const frames = [answerFrame("Here you go"), imageFrame({ url: GENERATED_URL })];
    const expectedLink = `![Generated image 1](<${GENERATED_URL}>)`;

    const nonStreamHarness = googleTransport({ generate: () => answerResponse(frames) });
    const nonStream = await executeWith(nonStreamHarness, { stream: false });
    const payload = await jsonOf(nonStream);
    expect(payload.choices[0].message.content).toContain("Here you go");
    expect(payload.choices[0].message.content.endsWith(expectedLink)).toBe(true);

    const streamHarness = googleTransport({ generate: () => answerResponse(frames, [11, 3]) });
    const streamed = await executeWith(streamHarness, { stream: true });
    const { chunks } = await readSse(streamed);
    expect(streamedContent(chunks)).toBe(payload.choices[0].message.content);
    const contentDeltas = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.content);
    expect(contentDeltas.at(-1).choices[0].delta.content).toContain(expectedLink);
    expect(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
  });

  it("returns an image-only result as a link instead of an empty success", async () => {
    const harness = googleTransport({ generate: () => answerResponse([imageFrame({ url: GENERATED_URL })]) });
    const result = await executeWith(harness, { stream: false });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(200);
    expect(payload.choices[0].message.content).toBe(`![Generated image 1](<${GENERATED_URL}>)`);
  });

  it("returns a sanitized OpenAI-shaped request and no upstream headers", async () => {
    const harness = googleTransport();
    const result = await executeWith(harness, {
      body: chatBody([userText("Hi")]),
    });

    expect(new URL(result.url).search).toBe("");
    expect(result.response.headers.get("set-cookie")).toBeNull();
    expect(result.response.headers.get("location")).toBeNull();
    expect(result.headers).toMatchObject({ "x-gemini-web-slot": "default" });

    const serialized = JSON.stringify(result.transformedBody);
    expect(serialized).toContain("gemini-auto");
    expect(serialized).not.toContain("synthetic-psid");
    expect(serialized).not.toContain("synthetic-at-token");
    expect(result.transformedBody).not.toHaveProperty("f.req");
  });
});

describe("Gemini Web generation ownership", () => {
  function policyDiscovery() {
    return modelDiscoveryBody({
      tiers: [8],
      entries: [],
      policy: [
        "carbon_multi_ultra_pro_policy",
        [
          policyGroup("", "4 Hydrogen", "Everyday help", 1),
          policyGroup("argon", "Argon", "Code & analysis", 8),
        ],
      ],
    });
  }

  function policyHarness(session) {
    return googleTransport({
      discover: () =>
        new Response(policyDiscovery(), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      session,
    });
  }

  const openOk = () =>
    new Response('[[0,["c","synthetic-sid","0",8]]]', {
      status: 200,
      headers: { "x-http-session-id": "synthetic-gsession" },
    });

  const sentTurn = (calls) =>
    calls.some((call) => String(call.options.body || "").includes("req1___data__"));

  it("does not mark a failed Bind open as consumed and never sends the turn", async () => {
    const harness = policyHarness(() => new Response("upstream broke", { status: 500 }));
    const result = await executeWith(harness, { model: "gemini-code-analysis" });

    expect(result.response.status).toBe(500);
    expect(isNonReplayableResponse(result.response)).toBe(false);
    expect(harness.state.session).toBe(1);
    expect(harness.state.generation).toBe(0);
    expect(sentTurn(harness.calls)).toBe(false);
  });

  it("marks the turn consumed once the Bind send was issued and the answer was lost", async () => {
    const harness = policyHarness((call) => {
      if (String(call.options.body || "").startsWith("count=0")) return openOk();
      if (call.options.method === "GET") return new Response(")]}'\n", { status: 200 });
      return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
    });
    const result = await executeWith(harness, { model: "gemini-code-analysis" });

    expect(result.response.status).toBe(502);
    expect(isNonReplayableResponse(result.response)).toBe(true);
    expect(sentTurn(harness.calls)).toBe(true);
  });

  it("keeps a rejected Bind open retryable with its Retry-After", async () => {
    const harness = policyHarness(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
    );
    const result = await executeWith(harness, { model: "gemini-code-analysis" });

    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("retry-after")).toBe("7");
    expect(isNonReplayableResponse(result.response)).toBe(false);
    expect(sentTurn(harness.calls)).toBe(false);
  });

  it.each([401, 403, 429])(
    "marks a channel read rejected after an accepted send with %s",
    async (status) => {
      const harness = policyHarness((call) => {
        const body = String(call.options.body || "");
        if (body.startsWith("count=0")) return openOk();
        if (call.options.method === "GET") {
          return new Response("rejected", { status, headers: { "retry-after": "3" } });
        }
        return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
      });
      const result = await executeWith(harness, { model: "gemini-code-analysis" });

      expect(result.response.status).toBe(status);
      expect(isNonReplayableResponse(result.response)).toBe(true);
      expect(sentTurn(harness.calls)).toBe(true);
      expect(harness.state.generation).toBe(0);
    }
  );

  it.each([401, 403, 429])(
    "keeps a rejected inference send with %s retryable",
    async (status) => {
      const harness = policyHarness((call) => {
        const body = String(call.options.body || "");
        if (body.startsWith("count=0")) return openOk();
        return new Response("rejected", { status });
      });
      const result = await executeWith(harness, { model: "gemini-code-analysis" });

      expect(result.response.status).toBe(status);
      expect(isNonReplayableResponse(result.response)).toBe(false);
      expect(sentTurn(harness.calls)).toBe(true);
    }
  );

  it("keeps a rejected StreamGenerate send retryable", async () => {
    const harness = googleTransport({
      generate: () => new Response("rejected", { status: 401 }),
    });
    const result = await executeWith(harness, {});

    expect(result.response.status).toBe(401);
    expect(isNonReplayableResponse(result.response)).toBe(false);
    expect(harness.state.generation).toBe(1);
  });

  it("does not fall back to another account when the channel read is rejected after the send", async () => {
    const harness = policyHarness((call) => {
      const body = String(call.options.body || "");
      if (body.startsWith("count=0")) return openOk();
      if (call.options.method === "GET") return new Response("rejected", { status: 401 });
      return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
    });

    const attempts = [];
    const response = await handleComboChat({
      body: chatBody([userText("Hi")]),
      models: ["gemini-web/gemini-code-analysis", "other/fallback"],
      handleSingleModel: async (_body, model) => {
        attempts.push(model);
        if (model === "gemini-web/gemini-code-analysis") {
          return (
            await executeWith(harness, {
              model: "gemini-code-analysis",
              body: chatBody([userText("Hi")]),
            })
          ).response;
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "Fallback answer" } }] }));
      },
      log: { info() {}, warn() {}, debug() {} },
      comboName: "post-send-rejection",
      comboStrategy: "fallback",
    });

    expect(response.status).toBe(401);
    expect(attempts).toEqual(["gemini-web/gemini-code-analysis"]);
  });

  it("surfaces a channel service error with its upstream status and never replays it", async () => {
    // Literal body of the live rejected Argon poll: the service names the
    // missing API consumer identity, then the channel closes.
    const serviceError =
      '[[1,{"__sm__":{"status":[[{"error":{"code":403,"message":"Method doesn\'t allow ' +
      'unregistered callers (callers without established identity). Please use API Key or ' +
      'other form of API consumer identity to call this API.","status":"PERMISSION_DENIED"}}]]}}],' +
      '[2,["close"]]]';
    const harness = policyHarness((call) => {
      const body = String(call.options.body || "");
      if (body.startsWith("count=0")) return openOk();
      if (call.options.method === "GET") return new Response(serviceError, { status: 200 });
      return new Response(")]}'\n[[1,[]]]\n", { status: 200 });
    });

    const result = await executeWith(harness, { model: "gemini-code-analysis" });
    const payload = await jsonOf(result);

    expect(result.response.status).toBe(403);
    expect(payload.error.code).toBe("gemini_web_upstream_error");
    expect(payload.error.message).toContain("unregistered callers");
    expect(isNonReplayableResponse(result.response)).toBe(true);
    expect(sentTurn(harness.calls)).toBe(true);
  });

  it("refuses an upload on a channel-only policy code instead of dropping it", async () => {
    // Code & analysis is published only inside the channel's model group, and
    // the channel's request records carry no uploaded-file slot. A turn that
    // carried an image would answer without it, so it must be refused before an
    // upload is spent and before any turn is sent.
    const harness = policyHarness(openOk);
    const result = await executeWith(harness, {
      model: "gemini-code-analysis",
      body: chatBody([
        { role: "user", content: [{ type: "image_url", image_url: { url: PNG_DATA_URL } }] },
      ]),
    });

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(400);
    expect(payload.error.code).toBe("unsupported_control_for_provider");
    expect(harness.state.upload).toBe(0);
    expect(harness.state.session).toBe(0);
    expect(sentTurn(harness.calls)).toBe(false);
  });

  it("keeps a rejected image send retryable on another account", async () => {
    // Image generation must reach the media-capable surface even when the
    // catalog offers only a policy code, which the image task then picks.
    const harness = googleTransport({
      discover: () => new Response(policyDiscovery(), { status: 200 }),
      generate: () => new Response("rejected", { status: 401 }),
    });
    const executor = new geminiWeb.GeminiWebExecutor();
    const { credentials } = makeCredentials();

    const error = await executor
      .generateMedia({ prompt: "a teal square", n: 1, credentials, transport: harness.transport })
      .catch((caught) => caught);

    expect(harness.state.session).toBe(0);
    expect(harness.state.generation).toBe(1);
    expect(error.status).toBe(401);
    expect(error.nonReplayable).toBeUndefined();
  });

  it("keeps a failed image preparation before dispatch retryable on another account", async () => {
    const harness = googleTransport({ discover: () => new Response("discovery broke", { status: 500 }) });
    const executor = new geminiWeb.GeminiWebExecutor();
    const { credentials } = makeCredentials();

    const error = await executor
      .generateMedia({ prompt: "a teal square", n: 1, credentials, transport: harness.transport })
      .catch((caught) => caught);

    expect(error.status).toBe(502);
    expect(error.nonReplayable).toBeUndefined();
    expect(harness.state.session).toBe(0);
    expect(harness.state.generation).toBe(0);
  });
});

describe("Gemini Web image task", () => {
  it("generates one PNG through the image task", async () => {
    const harness = googleTransport({
      generate: () =>
        new Response(lengthPrefixedBody([imageFrame({ url: GENERATED_URL, mime: "image/png" })]), { status: 200 }),
    });
    const executor = new geminiWeb.GeminiWebExecutor();
    const { credentials } = makeCredentials();

    const images = await executor.generateMedia({
      prompt: "a teal square",
      size: "1:1",
      n: 1,
      credentials,
      transport: harness.transport,
    });

    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/png");
    expect(Buffer.from(images[0].b64, "base64").equals(TINY_PNG)).toBe(true);
    expect(harness.state.generation).toBe(1);
    expect(harness.state.download).toBe(1);

    const generation = generationCalls(harness.calls).at(-1);
    expect(innerOf(generation)[0][0]).toBe(buildImagePrompt("a teal square", "1:1"));
  });

  it("collects two distinct images, reusing multiple images from one generation", async () => {
    const harness = googleTransport({
      generate: () =>
        new Response(
          lengthPrefixedBody([
            imageFrame({ url: `${GENERATED_URL}-one`, mime: "image/png" }),
            imageFrame({ url: `${GENERATED_URL}-two`, mime: "image/jpeg" }),
          ]),
          { status: 200 }
        ),
      download: (call) =>
        new URL(call.url).pathname.includes("-two")
          ? new Response(TINY_JPEG, { status: 200, headers: { "content-type": "image/jpeg" } })
          : new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } }),
    });
    const executor = new geminiWeb.GeminiWebExecutor();
    const { credentials } = makeCredentials();

    const images = await executor.generateMedia({
      prompt: "two squares",
      n: 2,
      credentials,
      transport: harness.transport,
    });

    expect(harness.state.generation).toBe(1);
    expect(harness.state.download).toBe(2);
    expect(images.map((image) => image.mime)).toEqual(["image/png", "image/jpeg"]);
    expect(images[0].b64).not.toBe(images[1].b64);
  });

  it("passes the account slot to generated-image downloads", async () => {
    const harness = googleTransport({
      generate: () =>
        new Response(lengthPrefixedBody([imageFrame({ url: GENERATED_URL })]), { status: 200 }),
    });
    const executor = new geminiWeb.GeminiWebExecutor();
    const { credentials } = makeCredentials({ authUser: "2" });

    await executor.generateMedia({ prompt: "slot image", n: 1, credentials, transport: harness.transport });

    const download = harness.calls.find((call) => call.url.includes("googleusercontent"));
    expect(new URL(download.url).searchParams.get("authuser")).toBe("2");
    const appCall = harness.calls.find((call) => new URL(call.url).pathname === "/u/2/app");
    expect(appCall).toBeDefined();
  });

  it("fails with gemini_web_no_image instead of retrying a generation that returned no image", async () => {
    const harness = googleTransport({ generate: () => answerResponse([answerFrame("No picture for you")]) });
    const executor = new geminiWeb.GeminiWebExecutor();
    const { credentials } = makeCredentials();

    await expect(
      executor.generateMedia({ prompt: "nothing", n: 2, credentials, transport: harness.transport })
    ).rejects.toMatchObject({ status: 502, code: "gemini_web_no_image", nonReplayable: true });
    expect(harness.state.generation).toBe(1);
  });
});

describe("Gemini Web cancellation", () => {
  it("cancels an in-flight stream without emitting a successful stop", async () => {
    const hang = hangingStream([lengthPrefixedBody([answerFrame("partial")])]);
    const harness = googleTransport({
      generate: () => new Response(hang.stream, { status: 200 }),
    });
    const controller = new AbortController();

    const result = await executeWith(harness, { stream: true, signal: controller.signal });
    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!buffer.includes("partial")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    controller.abort(new Error("client cancelled"));

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    const chunks = buffer
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("data:"))
      .map((block) => block.slice(5).trim())
      .filter((data) => data !== "[DONE]")
      .map((data) => JSON.parse(data));

    expect(hang.state.cancelled).toBe(true);
    expect(chunks.some((chunk) => chunk.error?.code === "request_aborted")).toBe(true);
    expect(chunks.every((chunk) => chunk.choices?.[0]?.finish_reason !== "stop")).toBe(true);
  });

  it("returns 499 for an already-aborted request before dispatch", async () => {
    const harness = googleTransport();
    const controller = new AbortController();
    controller.abort(new Error("client went away"));

    const result = await executeWith(harness, { signal: controller.signal });
    const payload = await jsonOf(result);

    expect(result.response.status).toBe(499);
    expect(payload.error.code).toBe("request_aborted");
    expect(harness.calls).toHaveLength(0);
  });
});

describe("Gemini Web bootstrap lifecycle", () => {
  it("does not rotate a fresh session and rotates a stale one with the slot preserved", async () => {
    const freshHarness = googleTransport();
    await executeWith(freshHarness, { credentials: makeCredentials({ lastRotatedAt: freshTimestamp() }).credentials });
    expect(freshHarness.state.rotate).toBe(0);

    const staleHarness = googleTransport({
      rotate: () =>
        new Response("{}", {
          status: 200,
          headers: [
            [
              "set-cookie",
              "__Secure-1PSIDTS=rotated-value; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; Domain=.google.com; Secure; HttpOnly",
            ],
          ],
        }),
    });
    const stale = makeCredentials({ lastRotatedAt: staleTimestamp() });

    await executeWith(staleHarness, { credentials: stale.credentials });

    expect(staleHarness.state.rotate).toBe(1);
    expect(stale.commit).toHaveBeenCalledTimes(1);
    expect(stale.commit.mock.calls[0][0]).toMatchObject({
      source: "rotation",
      expectedRevision: 1,
    });
    expect(stale.commit.mock.calls[0][0].cookieHeader).toContain("__Secure-1PSIDTS=rotated-value");
    expect(stale.commit.mock.calls[0][0].cookieHeader).toContain("__Secure-1PSID=synthetic-psid-value");
    expect(stale.commit.mock.calls[0][0].cookieHeader.startsWith("__Secure-1PSID=")).toBe(true);

    const appCall = staleHarness.calls.find((call) => new URL(call.url).pathname.endsWith("/app"));
    expect(headerOf(appCall, "cookie")).toContain("__Secure-1PSIDTS=rotated-value");

    const rotateCall = staleHarness.calls.find((call) => call.url.includes("RotateCookies"));
    expect(headerOf(rotateCall, "cookie")).toBe(
      "__Secure-1PSID=synthetic-psid-value; __Secure-1PSIDTS=synthetic-psidts-value"
    );
  });

  it("returns the bootstrap failure without generating", async () => {
    const harness = googleTransport({ app: () => new Response(SIGN_IN_HTML, { status: 200 }) });
    const result = await executeWith(harness);

    const payload = await jsonOf(result);
    expect(result.response.status).toBe(401);
    expect(payload.error.message).toBe("Gemini Web session is not signed in");
    expect(isNonReplayableResponse(result.response)).toBe(false);
    expect(harness.state.generation).toBe(0);
  });

  it("reports a cancellation during bootstrap as 499", async () => {
    const controller = new AbortController();
    const harness = googleTransport({
      app: () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    const result = await executeWith(harness, { signal: controller.signal });

    expect(result.response.status).toBe(499);
    expect((await jsonOf(result)).error.code).toBe("request_aborted");
    expect(harness.state.generation).toBe(0);
  });

  it("keeps working when rotation fails and does not retry it on every request", async () => {
    const harness = googleTransport({
      rotate: () => new Response("nope", { status: 500 }),
    });
    const credentials = makeCredentials({ lastRotatedAt: staleTimestamp() }).credentials;

    const first = await geminiWeb.resolveGeminiWebModels(credentials, { transport: harness.transport });
    expect(first).toEqual(PUBLIC_MODELS);

    const second = await geminiWeb.resolveGeminiWebModels(credentials, {
      transport: harness.transport,
      forceRefresh: true,
    });
    expect(second).toEqual(PUBLIC_MODELS);
    expect(harness.state.rotate).toBe(1);
  });
});

describe("Gemini Web probe and catalog", () => {
  it("probes valid, invalid and unknown states", async () => {
    const validHarness = googleTransport();
    const valid = await geminiWeb.probeGeminiWebConnection(makeCredentials().credentials, {
      transport: validHarness.transport,
    });
    expect(valid).toEqual({ status: "valid" });

    const invalidHarness = googleTransport({ app: () => new Response(SIGN_IN_HTML, { status: 200 }) });
    const invalid = await geminiWeb.probeGeminiWebConnection(makeCredentials().credentials, {
      transport: invalidHarness.transport,
    });
    expect(invalid.status).toBe("invalid");
    expect(typeof invalid.error).toBe("string");

    const unknownHarness = googleTransport({
      app: () => {
        throw new Error("socket hang up");
      },
    });
    const unknown = await geminiWeb.probeGeminiWebConnection(makeCredentials().credentials, {
      transport: unknownHarness.transport,
    });
    expect(unknown.status).toBe("unknown");
    expect(typeof unknown.error).toBe("string");

    const limitedHarness = googleTransport({ app: () => new Response("slow down", { status: 429 }) });
    const limited = await geminiWeb.probeGeminiWebConnection(makeCredentials().credentials, {
      transport: limitedHarness.transport,
    });
    expect(limited.status).toBe("unknown");
  });

  it("answers testConnection only for definitive results", async () => {
    const executor = new geminiWeb.GeminiWebExecutor();

    const validHarness = googleTransport();
    await expect(
      executor.testConnection(makeCredentials().credentials, { transport: validHarness.transport })
    ).resolves.toBe(true);

    const invalidHarness = googleTransport({ app: () => new Response(SIGN_IN_HTML, { status: 200 }) });
    await expect(
      executor.testConnection(makeCredentials().credentials, { transport: invalidHarness.transport })
    ).resolves.toBe(false);

    const unknownHarness = googleTransport({
      app: () => {
        throw new Error("socket hang up");
      },
    });
    await expect(
      executor.testConnection(makeCredentials().credentials, { transport: unknownHarness.transport })
    ).rejects.toMatchObject({ code: "GEMINI_WEB_VERIFICATION_UNKNOWN" });
  });

  it("resolves the public catalog, records it, and reuses the bootstrap cache", async () => {
    const harness = googleTransport();
    const { credentials, recordModels } = makeCredentials();

    const models = await geminiWeb.resolveGeminiWebModels(credentials, { transport: harness.transport });

    expect(models).toEqual(PUBLIC_MODELS);
    expect(models[0]).not.toHaveProperty("modelId");
    expect(models[0]).not.toHaveProperty("modelNumber");
    expect(recordModels).toHaveBeenCalledTimes(1);
    expect(recordModels.mock.calls[0][0]).toMatchObject({
      authUser: "",
      cookieRevision: 1,
      models: PUBLIC_MODELS,
    });

    await geminiWeb.resolveGeminiWebModels(credentials, { transport: harness.transport });
    expect(harness.state.bootstrap).toBe(1);
    expect(recordModels).toHaveBeenCalledTimes(1);
  });

  it("re-bootstraps when the cookie revision or the account slot changes", async () => {
    const harness = googleTransport();
    const first = makeCredentials();
    await geminiWeb.resolveGeminiWebModels(first.credentials, { transport: harness.transport });
    expect(harness.state.bootstrap).toBe(1);

    const second = makeCredentials({ revision: 2 });
    await geminiWeb.resolveGeminiWebModels(second.credentials, { transport: harness.transport });
    expect(harness.state.bootstrap).toBe(2);

    const third = makeCredentials({ authUser: "2", connectionId: "conn-beta", sessionId: "session-beta" });
    await geminiWeb.resolveGeminiWebModels(third.credentials, { transport: harness.transport });
    expect(harness.state.bootstrap).toBe(3);

    const appCall = harness.calls.filter((call) => new URL(call.url).pathname === "/u/2/app").at(-1);
    expect(appCall).toBeDefined();
  });
});

describe("Gemini Web image prompt helper", () => {
  it("keeps the requested aspect ratio in the prompt", () => {
    expect(buildImagePrompt("a teal square", "16:9")).toContain("a teal square");
    expect(buildImagePrompt("a teal square", "16:9")).toContain("16:9");
    expect(buildImagePrompt("a teal square", null)).toContain("a teal square");
  });
});
