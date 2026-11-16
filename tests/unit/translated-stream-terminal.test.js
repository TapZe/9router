// Terminal framing for translated SSE streams.
//
// A Claude upstream ends with message_stop, but an OpenAI Chat Completions
// client waits for the OpenAI sentinel, not EOF. Translate mode swallowed the
// upstream's data: [DONE] (it is not an event a translator should see) and
// never emitted one downstream, so a real Claude reply produced content and
// finish_reason but no `data: [DONE]`. Strict clients (openai-python, OpenClaw)
// then hang or report a truncated turn.
//
// The sentinel belongs to the translation sink that writes client bytes, and
// only for OpenAI Chat Completions clients: Claude, Responses, Gemini and
// Ollama clients terminate in their own native formats.
import { describe, it, expect } from "vitest";
import http from "node:http";

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";

const ANSWER = "Hello from Claude";
const TOOL_NAME = "lookup_weather";
const TOOL_ARGS = '{"city":"Paris"}';
const SENTINEL = "data: [DONE]\n\n";

function claudeEvents({ text = ANSWER, inputTokens = 12, outputTokens = 4, tool = null } = {}) {
  const events = [{
    type: "message_start",
    message: {
      id: "msg_terminal",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  }];

  if (tool) {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: tool.name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: tool.arguments } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: outputTokens } },
    );
  } else {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } },
    );
  }

  events.push({ type: "message_stop" });
  return events;
}

function claudeSSE(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function openaiSSE(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + SENTINEL;
}

async function run(input, {
  targetFormat = FORMATS.CLAUDE,
  sourceFormat = FORMATS.OPENAI,
  provider = "claude",
  model = "claude-sonnet-4-5",
  onStreamComplete = null,
} = {}) {
  const encoder = new TextEncoder();
  const inputStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });

  const output = inputStream.pipeThrough(
    createSSEStream({
      mode: "translate",
      targetFormat,
      sourceFormat,
      provider,
      model,
      onStreamComplete,
    }),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function dataPayloads(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.slice(6).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

function doneCount(text) {
  return (text.match(/data: \[DONE\]\n\n/g) || []).length;
}

describe("Claude upstream translated for an OpenAI Chat Completions client", () => {
  it("closes a complete message with exactly one framed [DONE]", async () => {
    const out = await run(claudeSSE(claudeEvents()));

    expect(doneCount(out)).toBe(1);
    expect(out.endsWith(SENTINEL)).toBe(true);

    const chunks = dataPayloads(out);
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("")).toBe(ANSWER);
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage.completion_tokens).toBe(4);
    expect(finish.usage.prompt_tokens).toBeGreaterThanOrEqual(12);
  });

  it("frames the sentinel at EOF when the final event has no trailing newline", async () => {
    // Body ends right after message_delta, mid-line: the finish chunk only exists
    // in the flush buffer, and the sentinel must still be the last framed frame.
    const events = claudeEvents().filter((event) => event.type !== "message_stop");
    const out = await run(claudeSSE(events).trimEnd());

    expect(doneCount(out)).toBe(1);
    expect(out.endsWith(SENTINEL)).toBe(true);

    const chunks = dataPayloads(out);
    expect(chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || "").join("")).toBe(ANSWER);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
  });

  it("deduplicates an upstream sentinel left unterminated at EOF", async () => {
    const out = await run(`${claudeSSE(claudeEvents()).trimEnd()}\n\ndata: [DONE]`);

    expect(doneCount(out)).toBe(1);
    expect(out.endsWith(SENTINEL)).toBe(true);
    expect(out).not.toContain("[DONE]data:");
  });

  it("does not repeat a terminated upstream sentinel", async () => {
    const out = await run(`${claudeSSE(claudeEvents())}${SENTINEL}`);

    expect(doneCount(out)).toBe(1);
    expect(out.endsWith(SENTINEL)).toBe(true);
  });

  it("keeps tool calls intact before the sentinel", async () => {
    const out = await run(claudeSSE(claudeEvents({ tool: { name: TOOL_NAME, arguments: TOOL_ARGS } })));

    expect(doneCount(out)).toBe(1);
    expect(out.endsWith(SENTINEL)).toBe(true);

    const chunks = dataPayloads(out);
    const call = chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls || [])[0];
    expect(call.function.name).toBe(TOOL_NAME);
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
  });

  it("reports the turn once to the success accountant after the sentinel", async () => {
    const completions = [];
    const onStreamComplete = (...args) => completions.push(args);

    const out = await run(claudeSSE(claudeEvents()), { onStreamComplete });

    expect(out.endsWith(SENTINEL)).toBe(true);
    expect(completions).toHaveLength(1);
    expect(completions[0][0].content).toBe(ANSWER);
    expect(completions[0][1]).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
  });
});

describe("real chatCore loopback path", () => {
  it("gives an OpenAI client the sentinel after a Claude upstream ends at EOF", async () => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) bodyText += chunk;
      requests.push({ url: req.url, body: JSON.parse(bodyText) });

      const events = claudeEvents();
      const stop = events.pop();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(claudeSSE(events));
      // Upstream closes mid-line after message_stop: no trailing newline.
      res.end(`event: ${stop.type}\ndata: ${JSON.stringify(stop)}`);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const log = { debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {} };

    try {
      const result = await handleChatCore({
        body: {
          model: "claude-sonnet-4-5",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
        modelInfo: { provider: "anthropic-compatible-sse-terminal", model: "claude-sonnet-4-5" },
        credentials: { apiKey: "sk-synthetic", providerSpecificData: { baseUrl } },
        log,
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: {},
          headers: { accept: "text/event-stream" },
        },
        connectionId: "sse-terminal-loopback",
        clientSignal: new AbortController().signal,
      });

      expect(result.success).toBe(true);
      const wire = await result.response.text();

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/messages");
      expect(requests[0].body.stream).toBe(true);
      expect(doneCount(wire)).toBe(1);
      expect(wire.endsWith(SENTINEL)).toBe(true);
      expect(wire).toContain(ANSWER);
      expect(dataPayloads(wire).some((chunk) => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("non-OpenAI clients keep their native terminal semantics", () => {
  it("an Anthropic Messages client ends on message_stop, never [DONE]", async () => {
    const upstream = openaiSSE([
      { id: "chatcmpl-terminal", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] },
      { id: "chatcmpl-terminal", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);

    const out = await run(upstream, {
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.CLAUDE,
      provider: "openai",
      model: "gpt-4o",
    });

    expect(out).toContain('"type":"message_stop"');
    expect(out).not.toContain("[DONE]");
  });

  it("an OpenAI Responses client ends on response.completed, never the chat sentinel", async () => {
    const out = await run(claudeSSE(claudeEvents()), {
      targetFormat: FORMATS.CLAUDE,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
    });

    expect(out.match(/"type":"response\.completed"/g)).toHaveLength(1);
    expect(out).not.toContain("[DONE]");
  });
});
