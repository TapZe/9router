import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
import "../translator/registerAll.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { createFactoryToolNameStream } from "../../open-sse/utils/factoryToolNameStream.js";
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("Network forbidden"); }); });
afterEach(() => { vi.unstubAllGlobals(); });
const map = new Map([["inspect_file", "read"], ["tool_bash", "bash"]]);
const event = (calls, extra = {}, choice = 0) => ({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: choice, delta: { tool_calls: calls }, finish_reason: null, ...extra }] });
const call = (name, args, index = 0, extra = {}) => ({ index, ...extra, function: { ...(name === undefined ? {} : { name }), ...(args === undefined ? {} : { arguments: args }) } });
const encode = (chunks, done = true) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
async function run(text, options = {}, splitBytes = false) {
  const bytes = new TextEncoder().encode(text);
  const input = new ReadableStream({ start(controller) {
    if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } });
  return new Response(input.pipeThrough(createSSEStream({ provider: "factory", mode: "passthrough", toolNameMap: map, ...options }))).text();
}
const chatCalls = (text) => data(text).flatMap((chunk) => chunk.choices ?? []).flatMap((choice) => choice.delta?.tool_calls ?? []);
const data = (text) => text.split("\n\n").map((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n")).filter((payload) => payload && payload !== "[DONE]").map((payload) => JSON.parse(payload));
describe("Factory name fragment stream", () => {
  it("holds id-only headers, byte-split UTF-8 and empty arguments until real argument bytes", async () => {
    const args = '{"path":"é/read/inspect_file"}';
    const text = await run(encode([event([{ index: 0, id: "call_1", type: "function" }], { delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function" }] } }), event([call("inspect_", "")]), event([call("file", "")]), event([call(undefined, args)]), event([], { finish_reason: "tool_calls" })]), {}, true);
    const calls = chatCalls(text);
    expect(calls.filter((tc) => tc.function?.name).map((tc) => tc.function.name)).toEqual(["read"]);
    expect(calls[0].id).toBe("call_1");
    expect(calls.map((tc) => tc.function?.arguments ?? "").join("")).toBe(args);
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
  it("does not prematurely resolve an exact alias extended to an unrelated tool", async () => {
    const text = await run(encode([event([call("inspect_file", "", 0, { id: "call_extra" })]), event([call("_extra", "")]), event([call(undefined, "{}")]), event([], { finish_reason: "tool_calls" })]));
    expect(chatCalls(text).filter((tc) => tc.function?.name).map((tc) => tc.function.name)).toEqual(["inspect_file_extra"]);
    expect(chatCalls(text).map((tc) => tc.function?.arguments ?? "").join("")).toBe("{}");
  });
  it("keeps interleaved choices and indices independent and preserves text and usage", async () => {
    const chunks = [event([call("inspect_", undefined, 2, { id: "call_a" })]), event([call("tool_", undefined, 2, { id: "call_b" })], {}, 1), event([call("tool_", undefined, 3, { id: "call_c" })]), event([call("file", "{\"a\":1}", 2)], { delta: { content: "text", reasoning_content: "think", tool_calls: [call("file", "{\"a\":1}", 2)] } }), event([call("bash", "{\"b\":2}", 2)], { finish_reason: "tool_calls" }, 1), event([call("bash", "{\"c\":3}", 3)], { finish_reason: "tool_calls" }), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }];
    const text = await run(encode(chunks));
    const calls = chatCalls(text);
    expect(calls.filter((tc) => tc.function?.name).map((tc) => [tc.id, tc.function.name])).toEqual([["call_a", "read"], ["call_b", "bash"], ["call_c", "bash"]]);
    expect(text).toContain('"content":"text"');
    expect(text).toContain('"reasoning_content":"think"');
    expect(data(text).at(-1).usage.total_tokens).toBe(14);
    for (const [index, letter] of [[2, "a"], [3, "c"]]) expect(calls.filter((tc) => tc.index === index).map((tc) => tc.function?.arguments ?? "").join("")).toContain(letter);
  });
  it.each(["", "\n\n", "\n\ndata: [DONE]"])("flushes a final unterminated line and clean EOF (%j)", async (suffix) => {
    const text = await run(`data: ${JSON.stringify(event([call("inspect_file", "", 0, { id: "call_tail" })]))}${suffix}`);
    expect(chatCalls(text)[0]).toMatchObject({ id: "call_tail", function: { name: "read" } });
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
  it.each(["claude", "openai-responses"])("restores a complete name before the %s consumer opens a tool", async (sourceFormat) => {
    const args = '{"input":"read/write/inspect_file"}';
    const chunks = [event([{ index: 0, id: "call_bridge", type: "function" }]), event([call("inspect_", "")]), event([call("file", args)]), event([], { finish_reason: "tool_calls" })];
    const text = await run(encode(chunks), { mode: "translate", targetFormat: "openai", sourceFormat, customToolNames: new Set(["read"]) });
    if (sourceFormat === "claude") {
      expect(data(text).find((chunk) => chunk.type === "content_block_start").content_block).toMatchObject({ type: "tool_use", id: "call_bridge", name: "read" });
      expect(data(text).filter((chunk) => chunk.type === "content_block_delta").map((chunk) => chunk.delta.partial_json ?? "").join("")).toBe(args);
    } else {
      expect(data(text).find((chunk) => chunk.type === "response.output_item.added").item).toMatchObject({ type: "custom_tool_call", name: "read", call_id: "call_bridge" });
      expect(data(text).filter((chunk) => chunk.type === "response.completed")).toHaveLength(1);
    }
  });
  it("restores native Gemini and native Responses custom names before forwarding", async () => {
    for (const [targetFormat, chunk, name] of [
      ["gemini", { candidates: [{ content: { parts: [{ functionCall: { name: "inspect_file", args: { path: "read" }, id: "g1" } }] } }] }, (b) => b.candidates[0].content.parts[0].functionCall.name],
      ["openai-responses", { type: "response.output_item.added", item: { type: "custom_tool_call", name: "inspect_file", input: "raw read", call_id: "r1" } }, (b) => b.item.name],
    ]) {
      const text = await run(encode([chunk], false), { mode: "translate", sourceFormat: targetFormat, targetFormat });
      expect(name(data(text)[0])).toBe("read");
    }
  });
  it("discards unresolved headers on explicit upstream error", async () => {
    const text = await run(encode([event([call("inspect_", "", 0, { id: "call_error" })]), { error: { message: "upstream failed" } }], false));
    expect(text).toContain("upstream failed");
    expect(chatCalls(text)).toEqual([]);
  });
  it("does not flush a canceled or failed upstream into a successful call", async () => {
    const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(encode([event([call("inspect_", "", 0, { id: "call_abort" })])], false))); }, cancel: vi.fn() });
    const reader = source.pipeThrough(createSSEStream({ provider: "factory", mode: "passthrough", toolNameMap: map })).getReader();
    const read = reader.read();
    await reader.cancel("stop");
    expect(await read).toEqual({ done: true, value: undefined });
    const failed = new ReadableStream({ start(controller) { controller.error(new Error("upstream broke")); } });
    await expect(new Response(failed.pipeThrough(createSSEStream({ provider: "factory", mode: "passthrough", toolNameMap: map }))).text()).rejects.toThrow("upstream broke");
  });
  it("keeps no-map and unrelated provider behavior separate", () => {
    const helper = createFactoryToolNameStream(map);
    const unknown = event([call("custom", "{}", 0, { id: "call_unknown" })]);
    expect(helper.push(unknown)).toEqual([unknown]);
    expect(helper.flush()).toEqual([]);
  });
});

it("keeps per-choice call IDs on later argument fragments", async () => {
  const text = await run(encode([
    event([call("inspect_file", "{", 0, { id: "call_a" })]),
    event([call("tool_bash", "{}", 0, { id: "call_b" })], {}, 1),
    event([call(undefined, "}", 0)], { finish_reason: "tool_calls" }),
    event([], { finish_reason: "tool_calls" }, 1),
  ]));
  for (const chunk of data(text)) for (const choice of chunk.choices ?? []) {
    for (const call of choice.delta?.tool_calls ?? []) expect(call.id).toBe(choice.index === 0 ? "call_a" : "call_b");
  }
});

it("resolves headers by fallback position without merging parallel choices", () => {
  const helper = createFactoryToolNameStream(map);
  const chunk = (names) => ({ choices: names.map((name, index) => ({ delta: { tool_calls: [{ id: `call_${index}`, function: { name } }] } })) });
  expect(helper.push(chunk(["inspect_", "tool_"]))).toEqual([]);
  expect(helper.push(chunk(["file", "bash"]))).toEqual([]);
  const headers = helper.flush();
  expect(headers.map((event) => [event.choices[0].index, event.choices[0].delta.tool_calls[0].id, event.choices[0].delta.tool_calls[0].function.name])).toEqual([[0, "call_0", "read"], [1, "call_1", "bash"]]);
});
