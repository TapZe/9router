import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../translator/registerAll.js";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn(), appendOpenAIChunk: vi.fn() }) }));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { FactoryExecutor, FACTORY_DROID_SYSTEM_PROMPT } from "../../open-sse/executors/factory.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { FACTORY_TOOL_ALIASES, OMP_GREETING_PREAMBLE } from "../../open-sse/config/factoryCompatibility.js";
import { FACTORY_COMPATIBILITY_CONTEXT, captureFactoryCompatibility } from "../../open-sse/utils/factoryRequestCompatibility.js";
import { restoreToolNames, takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";

const models = { openai: "deepseek-v4.1-flash-1017", "openai-responses": "gpt-5.4", claude: "claude-opus-5", gemini: "gemini-3.8-flash" };
const args = '{"path":"literal read/write/edit/bash/inspect_file"}';
const values = JSON.parse(args);
const pairs = [...Object.entries(FACTORY_TOOL_ALIASES), ["unknown", "unknown"]];
const schema = { type: "object", properties: { path: { type: "string", description: "read/write/edit" } }, required: ["path"] };
const credentials = () => ({ accessToken: "tok", providerSpecificData: {} });
function request(format, stream, names = pairs.map(([name]) => name)) {
  const definitions = names.map((name) => ({ name, description: `Description ${name}`, parameters: schema }));
  if (format === "claude") return { stream, system: [{ type: "text", text: `${OMP_GREETING_PREAMBLE}Keep rules.\n` }, { type: "text", text: "Later project block.\n" }], messages: [{ role: "user", content: "Read one file." }], tools: definitions.map(({ parameters, ...tool }) => ({ ...tool, input_schema: parameters })) };
  if (format === "openai-responses") return { stream, instructions: `${OMP_GREETING_PREAMBLE}Keep rules.\n`, input: [{ role: "user", content: "Read one file." }], tools: definitions.map((tool) => ({ type: "function", ...tool })) };
  if (format === "gemini") return { stream, systemInstruction: { parts: [{ text: `${OMP_GREETING_PREAMBLE}Keep rules.\n` }, { text: "Later project block.\n" }] }, contents: [{ role: "user", parts: [{ text: "Read one file." }] }], tools: [{ functionDeclarations: definitions }] };
  return { stream, messages: [{ role: "system", content: `${OMP_GREETING_PREAMBLE}Keep rules.\n` }, { role: "user", content: "Read one file." }], tools: definitions.map((tool) => ({ type: "function", function: tool })) };
}
const sse = (chunks, done = false) => chunks.map((chunk) => `${chunk.type ? `event: ${chunk.type}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
function upstream(format, stream, wire = "inspect_file", id = "call_1", argumentString = args) {
  let json;
  let chunks;
  if (format === "openai") {
    json = { id: "chatcmpl-test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: wire, arguments: argumentString } }] }, finish_reason: "tool_calls" }] };
    chunks = [{ id: "chatcmpl-test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: wire.slice(0, 4), arguments: "" } }] }, finish_reason: null }] }, { id: "chatcmpl-test", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: wire.slice(4), arguments: argumentString } }] }, finish_reason: "tool_calls" }] }];
  } else if (format === "claude") {
    const call = { type: "tool_use", id, name: wire, input: JSON.parse(argumentString) };
    json = { id: "msg-test", type: "message", role: "assistant", content: [call], stop_reason: "tool_use", usage: { input_tokens: 4, output_tokens: 2 } };
    chunks = [{ type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", content: [], usage: { input_tokens: 4, output_tokens: 0 } } }, { type: "content_block_start", index: 0, content_block: { ...call, input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: argumentString } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }, { type: "message_stop" }];
  } else if (format === "gemini") {
    json = { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { id, name: wire, args: JSON.parse(argumentString) } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } };
    chunks = [json];
  } else {
    const item = { id: "fc_test", type: "function_call", call_id: id, name: wire, arguments: argumentString, status: "completed" };
    json = { id: "resp_test", object: "response", status: "completed", output: [item], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } };
    chunks = [{ type: "response.created", response: { id: "resp_test", object: "response", output: [], status: "in_progress" } }, { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }, { type: "response.function_call_arguments.delta", item_id: "fc_test", output_index: 0, delta: argumentString }, { type: "response.function_call_arguments.done", item_id: "fc_test", output_index: 0, arguments: argumentString }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: json }];
  }
  return new Response(stream ? sse(chunks, format === "openai") : JSON.stringify(json), { headers: { "content-type": stream ? "text/event-stream" : "application/json" } });
}
const events = (text) => text.split("\n\n").map((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n")).filter((payload) => payload && payload !== "[DONE]").map((payload) => JSON.parse(payload));
function returnedCall(format, stream, text) {
  const chunks = stream ? events(text) : [JSON.parse(text)];
  if (format === "openai") {
    const calls = chunks.flatMap((chunk) => chunk.choices ?? []).flatMap((choice) => (choice.delta ?? choice.message)?.tool_calls ?? []);
    return { id: calls.find((call) => call.id)?.id, name: calls.map((call) => call.function?.name ?? "").join(""), arguments: calls.map((call) => call.function?.arguments ?? "").join("") };
  }
  if (format === "claude") {
    const call = stream ? chunks.find((chunk) => chunk.type === "content_block_start" && chunk.content_block.type === "tool_use")?.content_block : chunks[0].content.find((block) => block.type === "tool_use");
    return { id: call?.id, name: call?.name, arguments: stream ? chunks.filter((chunk) => chunk.delta?.type === "input_json_delta").map((chunk) => chunk.delta.partial_json).join("") : JSON.stringify(call?.input) };
  }
  if (format === "gemini") {
    const call = chunks.flatMap((chunk) => (chunk.response ?? chunk).candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? []).find((part) => part.functionCall)?.functionCall;
    return { id: call?.id, name: call?.name, arguments: JSON.stringify(call?.args) };
  }
  const completed = stream ? chunks.find((chunk) => chunk.type === "response.completed")?.response : chunks[0];
  const call = completed?.output?.find((item) => item.type === "function_call" || item.type === "custom_tool_call");
  return { id: call?.call_id, name: call?.name, arguments: call?.arguments ?? call?.input, type: call?.type };
}
function continuation(body, format, call) {
  const next = structuredClone(body);
  if (format === "openai") next.messages.push({ role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] }, { role: "tool", tool_call_id: call.id, name: call.name, content: "contents" });
  else if (format === "claude") next.messages.push({ role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments) }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "contents" }] });
  else if (format === "gemini") next.contents.push({ role: "model", parts: [{ functionCall: { id: call.id, name: call.name, args: JSON.parse(call.arguments) } }] }, { role: "user", parts: [{ functionResponse: { id: call.id, name: call.name, response: { output: "contents" } } }] });
  else next.input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments }, { type: "function_call_output", call_id: call.id, output: "contents" });
  return next;
}
async function send(body, source, target, extra = {}) {
  const result = await handleChatCore({ body, modelInfo: { provider: "factory", model: models[target] }, credentials: credentials(), sourceFormatOverride: source, connectionId: "test-only", log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, customPromptEnabled: false, pxpipeEnabled: false, clientRawRequest: { endpoint: source === "openai-responses" ? "/v1/responses" : source === "claude" ? "/v1/messages" : "/v1/chat/completions", body, headers: { accept: body.stream ? "text/event-stream" : "application/json", "x-9router-token-saver": "off" } }, ...extra });
  return { ...result, text: await result.response.text() };
}
beforeEach(() => { proxyAwareFetch.mockReset(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Droid 1.18.0 Gemini effort across client formats", () => {
  it.each([
    ["openai", { reasoning_effort: "xhigh" }],
    ["openai-responses", { reasoning: { effort: "xhigh" } }],
    ["claude", { thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } }],
    ["gemini", { generationConfig: { thinkingConfig: { thinkingLevel: "XHIGH" } } }],
  ])("sends Neon XHIGH from %s", async (source, thinking) => {
    proxyAwareFetch.mockImplementation(async () => upstream("gemini", true));
    const result = await send({ ...request(source, true), ...thinking }, source, "gemini", {
      modelInfo: { provider: "factory", model: "gemini-4-neon" },
    });
    expect(result.response.status, result.text).toBe(200);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.factory.ai/api/llm/g/v1/generate");
    expect(JSON.parse(init.body).generationConfig).toMatchObject({
      maxOutputTokens: 65536,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "XHIGH" },
    });
    expect(returnedCall(source, true, result.text).name).toBe("read");
  });
});

describe("Factory real chatCore compatibility roundtrip", () => {
  for (const target of Object.keys(models)) for (const source of new Set([target, "openai"])) for (const stream of [false, true]) {
    it(`${source} -> ${target}, ${stream ? "SSE" : "JSON"}: two requests preserve dispatch and replay`, async () => {
      proxyAwareFetch.mockImplementation(async () => upstream(target, stream));
      const original = request(source, stream);
      const before = JSON.stringify(original);
      const first = await send(original, source, target);
      expect(first.response.status, first.text).toBe(200);
      const call = returnedCall(source, stream, first.text);
      expect(call.name, first.text).toBe("read");
      expect(JSON.parse(call.arguments)).toEqual(values);
      if (target === "openai" || target === "openai-responses") expect(call.arguments).toBe(args);
      expect(call.id).toBeTruthy();
      expect(call.id).toBe("call_1");
      const followup = continuation(original, source, call);
      const followupBefore = JSON.stringify(followup);
      const second = await send(followup, source, target);
      expect(second.response.status, second.text).toBe(200);
      expect(returnedCall(source, stream, second.text).name).toBe("read");
      expect(JSON.stringify(original)).toBe(before);
      expect(JSON.stringify(followup)).toBe(followupBefore);
      const sent = proxyAwareFetch.mock.calls.map(([, options]) => JSON.parse(options.body));
      const tools = target === "gemini" ? sent[0].tools[0].functionDeclarations : sent[0].tools;
      expect(tools.map((tool) => tool.function?.name ?? tool.name)).toEqual(pairs.map(([, wire]) => wire));
      for (const [index, tool] of tools.entries()) {
        expect(tool.function?.description ?? tool.description).toBe(`Description ${pairs[index][0]}`);
        expect(tool.function?.parameters ?? tool.parameters ?? tool.input_schema).toEqual(schema);
      }
      expect(JSON.stringify(sent[0])).not.toContain("factoryCompatibilityContext");
      expect(JSON.stringify(sent[0])).not.toContain("_toolNameMap");
      expect(JSON.stringify(sent[0])).not.toContain("trusted coding assistant");
      const wireHistory = target === "openai" ? sent[1].messages : target === "openai-responses" ? sent[1].input : target === "claude" ? sent[1].messages : sent[1].contents;
      expect(JSON.stringify(wireHistory)).toContain("inspect_file");
      expect(JSON.stringify(wireHistory)).toContain(call.id);
      expect(JSON.stringify(wireHistory)).toContain("contents");
    });
  }
  for (const source of ["openai-responses", "claude"]) for (const target of source === "claude" ? ["openai", "openai-responses"] : ["openai", "claude", "gemini"]) {
    it(`${source} SSE client receives original names from ${target}`, async () => {
      proxyAwareFetch.mockImplementation(async () => upstream(target, true));
      const result = await send(request(source, true), source, target);
      const call = returnedCall(source, true, result.text);
      expect(call.name, result.text).toBe("read");
      expect(JSON.parse(call.arguments)).toEqual(values);
      if (source === "openai-responses") expect(call.type).toBe("function_call");
      else expect(call.id).toBe("call_1");
    });
  }
  it("handles a non-stream Responses client with an upstream Responses SSE", async () => {
    proxyAwareFetch.mockImplementation(async () => upstream("openai-responses", true));
    const result = await send(request("openai-responses", false), "openai-responses", "openai-responses");
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(returnedCall("openai-responses", false, result.text)).toMatchObject({ name: "read", id: "call_1", arguments: args });
  });
  it.each(Object.entries(FACTORY_TOOL_ALIASES))("restores %s through the real JSON pipeline", async (name, wire) => {
    proxyAwareFetch.mockImplementation(async () => upstream("openai", false, wire));
    const result = await send(request("openai", false), "openai", "openai");
    expect(returnedCall("openai", false, result.text)).toMatchObject({ name, arguments: args, id: "call_1" });
  });
  it.each(["inspect_file", "constructor", "toString", "Read"])("does not reinterpret a lone caller name %s", async (name) => {
    proxyAwareFetch.mockImplementation(async () => upstream("openai", false, name));
    const result = await send(request("openai", false, [name]), "openai", "openai");
    expect(returnedCall("openai", false, result.text).name).toBe(name);
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body).tools[0].function.name).toBe(name);
  });
  it.each([false, true])("rejects declaration/history collisions before fetch (history=%s)", async (history) => {
    const body = request("openai", false, history ? ["read"] : ["read", "inspect_file"]);
    if (history) body.messages.push({ role: "assistant", tool_calls: [{ id: "old", type: "function", function: { name: "inspect_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "old", name: "inspect_file", content: "old" });
    const result = await send(body, "openai", "openai");
    expect(result.response.status).toBe(400);
    expect(result.text).toContain("tool name collision between read and inspect_file");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
  it("uses history-only aliases and accepts empty tools/history", async () => {
    proxyAwareFetch.mockImplementation(async () => upstream("openai", false));
    const empty = { stream: false, messages: [{ role: "user", content: "hi" }] };
    expect((await send(empty, "openai", "openai")).response.status).toBe(200);
    const replay = continuation(empty, "openai", { id: "old", name: "read", arguments: args });
    const result = await send(replay, "openai", "openai");
    expect(returnedCall("openai", false, result.text).name).toBe("read");
    expect(JSON.parse(proxyAwareFetch.mock.calls[1][1].body).messages.at(-1)).toMatchObject({ name: "inspect_file", tool_call_id: "old", content: "contents" });
  });
  it("returns local 400 for an unrepresentable choice but leaves asynchronous fetch failures as 502", async () => {
    const body = request("gemini", false);
    body.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read", "bash"] } };
    const rejected = await send(body, "gemini", "openai");
    expect(rejected.response.status).toBe(400);
    expect(rejected.text).toContain("cannot preserve explicit tool choice");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    proxyAwareFetch.mockRejectedValue(new Error("offline fixture failure"));
    vi.useFakeTimers();
    const pendingFailure = send(request("openai", false), "openai", "openai");
    await vi.runAllTimersAsync();
    const failed = await pendingFailure;
    expect(failed.response.status).toBe(502);
    expect(failed.text).toContain("offline fixture failure");
  });
});

describe("Factory request metadata and native custom tools", () => {
  it("composes maps inside the executor and keeps retries and concurrent namespaces isolated", async () => {
    const executor = new FactoryExecutor();
    const input = request("claude", false, ["sanitized"]);
    const captured = captureFactoryCompatibility("claude", request("claude", false, ["read"]), FACTORY_DROID_SYSTEM_PROMPT);
    input[FACTORY_COMPATIBILITY_CONTEXT] = { ...captured.context, previousToolNameMap: new Map([["sanitized", "read"], ["read", "read"]]) };
    const before = JSON.stringify(input);
    proxyAwareFetch.mockImplementation(async () => upstream("claude", false));
    const results = await Promise.all([executor.execute({ model: models.claude, body: input, stream: false, credentials: credentials() }), executor.execute({ model: models.claude, body: request("claude", false, ["inspect_file"]), stream: false, credentials: credentials() })]);
    const retry = executor.transformRequest(models.claude, input, false, credentials());
    expect(results[0].transformedBody.tools[0].name).toBe("inspect_file");
    expect(results[1].transformedBody.tools[0].name).toBe("inspect_file");
    expect(retry.tools[0].name).toBe("inspect_file");
    const restored = restoreToolNames({ content: [{ type: "tool_use", name: "inspect_file", id: "id", input: values }] }, takeRenamedToolNames(input));
    expect(restored.content[0].name).toBe("read");
    expect(restoreToolNames(restored, takeRenamedToolNames(input)).content[0].name).toBe("read");
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(retry.system)).not.toContain(OMP_GREETING_PREAMBLE);
    expect(JSON.stringify(retry.system).split("You are Droid")).toHaveLength(2);
    expect(JSON.stringify(retry)).not.toContain("previousToolNameMap");
  });
  it("returns local errors for cyclic and conflicting maps before fetching", async () => {
    for (const map of [new Map([["a", "b"], ["b", "a"]]), new Map([["inspect_file", "other"]])]) {
      const body = request("claude", false, ["read"]);
      body[FACTORY_COMPATIBILITY_CONTEXT] = { ...captureFactoryCompatibility("claude", body, FACTORY_DROID_SYSTEM_PROMPT).context, previousToolNameMap: map };
      const result = await new FactoryExecutor().execute({ model: models.claude, body, stream: false, credentials: credentials() });
      expect(result.response.status).toBe(400);
      expect(proxyAwareFetch).not.toHaveBeenCalled();
    }
  });
  it("preserves native Responses custom declarations and raw input", async () => {
    const body = request("openai-responses", false, []);
    const custom = { type: "custom", name: "edit", description: "custom edit", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } };
    const rawInput = "edit_file/read\nRAW";
    body.tools = [custom, { type: "web_search", filters: { allowed_domains: ["example.test"] } }];
    body.input.push({ type: "custom_tool_call", name: "edit", call_id: "old", id: "fc_server", input: rawInput }, { type: "custom_tool_call_output", call_id: "old", output: "saved" });
    const before = JSON.stringify(body);
    const sent = new FactoryExecutor().transformRequest(models["openai-responses"], body, false, credentials());
    expect(sent.tools).toEqual([{ ...custom, name: "edit_file" }, body.tools[1]]);
    expect(sent.input[1]).toEqual({ type: "custom_tool_call", name: "edit_file", call_id: "old", input: rawInput });
    expect(JSON.stringify(body)).toBe(before);
    proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({ object: "response", output: [{ type: "custom_tool_call", name: "edit_file", input: rawInput, call_id: "new" }] }), { headers: { "content-type": "application/json" } }));
    const result = await send(body, "openai-responses", "openai-responses");
    expect(JSON.parse(result.text).output[0]).toEqual({ type: "custom_tool_call", name: "edit", input: rawInput, call_id: "new" });
  });
  it.each([false, true])("classifies restored Responses custom names before bridging Chat output (stream=%s)", async (stream) => {
    const body = request("openai-responses", stream, []);
    body.tools = [{ type: "custom", name: "edit", description: "raw edit", format: { type: "text" } }];
    const raw = "edit_file/read/write\nopaque input";
    proxyAwareFetch.mockImplementation(async () => upstream("openai", stream, "edit_file", "call_custom", JSON.stringify({ input: raw })));
    const result = await send(body, "openai-responses", "openai");
    expect(returnedCall("openai-responses", stream, result.text)).toMatchObject({ type: "custom_tool_call", name: "edit", id: "call_custom", arguments: raw });
    const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(sent.tools[0].function.name).toBe("edit_file");
  });
});

describe("Factory source intent survives translation and final templates", () => {
  for (const source of Object.keys(models)) for (const target of Object.keys(models)) {
    it(`${source} -> ${target}: absent, auto, none, required and named choices`, async () => {
      const native = (format, mode) => {
        if (mode === "named") return format === "gemini" ? { mode: "ANY", allowedFunctionNames: ["read"] } : format === "openai" ? { type: "function", function: { name: "read" } } : { type: format === "claude" ? "tool" : "function", name: "read" };
        return format === "gemini" ? { mode: { auto: "AUTO", none: "NONE", required: "ANY" }[mode] } : format === "claude" ? { type: mode === "required" ? "any" : mode } : mode;
      };
      proxyAwareFetch.mockImplementation(async () => upstream(target, false));
      for (const mode of [undefined, "auto", "none", "required", "named"]) {
        const body = request(source, false);
        if (mode !== undefined) {
          if (source === "gemini") body.toolConfig = { functionCallingConfig: native(source, mode) };
          else body.tool_choice = native(source, mode);
        }
        const result = await send(body, source, target);
        expect(result.response.status, result.text).toBe(200);
        const sent = JSON.parse(proxyAwareFetch.mock.calls.at(-1)[1].body);
        if (target === "gemini") expect(sent).not.toHaveProperty("tool_choice");
        if (mode !== undefined) {
          const expected = native(target, mode);
          if (mode === "named") {
            if (target === "gemini") expected.allowedFunctionNames = ["inspect_file"];
            else if (target === "openai") expected.function.name = "inspect_file";
            else expected.name = "inspect_file";
          }
          expect(target === "gemini" ? sent.toolConfig.functionCallingConfig : sent.tool_choice).toEqual(expected);
        } else if (target === "openai-responses") expect(sent.tool_choice).toBe("auto");
        else if (target === "openai") expect(sent).not.toHaveProperty("tool_choice");
      }
    });
  }
  it("preserves native Gemini VALIDATED/multiple names and ancillary native choices on the wire", async () => {
    proxyAwareFetch.mockImplementation(async () => upstream("gemini", false));
    const body = request("gemini", false);
    body.toolConfig = { functionCallingConfig: { mode: "VALIDATED", allowedFunctionNames: ["read", "bash"], future: { signed: "opaque" } } };
    expect((await send(body, "gemini", "gemini")).response.status).toBe(200);
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body).toolConfig.functionCallingConfig).toEqual({ mode: "VALIDATED", allowedFunctionNames: ["inspect_file", "tool_bash"], future: { signed: "opaque" } });
    const native = request("claude", false);
    native.tool_choice = { type: "tool", name: "read", disable_parallel_tool_use: true };
    proxyAwareFetch.mockImplementation(async () => upstream("claude", false));
    expect((await send(native, "claude", "claude")).response.status).toBe(200);
    expect(JSON.parse(proxyAwareFetch.mock.calls.at(-1)[1].body).tool_choice).toEqual({ type: "tool", name: "inspect_file", disable_parallel_tool_use: true });
  });
  it("preserves exact suffix bytes, later blocks and direct-executor prompt idempotence", () => {
    const executor = new FactoryExecutor();
    const suffix = "  Keep project rules.\n";
    for (const format of Object.keys(models)) {
      const body = request(format, false);
      if (format === "openai") body.messages[0].content = OMP_GREETING_PREAMBLE + suffix;
      else if (format === "claude") body.system[0].text = OMP_GREETING_PREAMBLE + suffix;
      else if (format === "gemini") body.systemInstruction.parts[0].text = OMP_GREETING_PREAMBLE + suffix;
      else body.instructions = OMP_GREETING_PREAMBLE + suffix;
      const before = JSON.stringify(body);
      const sent = executor.transformRequest(models[format], body, false, credentials());
      const prompt = format === "openai" ? sent.messages[0].content : format === "claude" ? sent.system : format === "gemini" ? sent.systemInstruction.parts : sent.instructions;
      expect(JSON.stringify(prompt)).toContain(JSON.stringify(suffix).slice(1, -1));
      expect(JSON.stringify(prompt)).not.toContain("trusted coding assistant");
      expect(JSON.stringify(body)).toBe(before);
      const repeated = executor.transformRequest(models[format], sent, false, credentials());
      const twice = format === "openai" ? repeated.messages[0].content : format === "claude" ? repeated.system : format === "gemini" ? repeated.systemInstruction.parts : repeated.instructions;
      expect(twice).toEqual(prompt);
    }
    for (const initial of ["Unknown.", "You are omp's trusted coding assistant.\nNo blank", "You are omp's trusted coding assistant.\r\n\r\nCRLF", "Quoted: " + FACTORY_DROID_SYSTEM_PROMPT]) {
      const original = { messages: [{ role: "system", content: initial }, { role: "system", content: OMP_GREETING_PREAMBLE + "later" }] };
      const sent = executor.transformRequest(models.openai, original, false, credentials());
      expect(sent.messages[0].content).toBe(FACTORY_DROID_SYSTEM_PROMPT + "\n\n" + initial);
      expect(sent.messages[1]).toEqual(original.messages[1]);
    }
  });
});

it("keeps native Responses SSE custom names and raw input through chatCore", async () => {
  const raw = "raw edit_file/read\nkeep bytes";
  const item = { id: "ctc_1", type: "custom_tool_call", call_id: "call_custom", name: "edit_file", input: raw, status: "completed" };
  const body = request("openai-responses", true, []);
  body.tools = [{ type: "custom", name: "edit", format: { type: "text" } }];
  proxyAwareFetch.mockResolvedValue(new Response(sse([
    { type: "response.output_item.added", output_index: 0, item: { ...item, input: "", status: "in_progress" } },
    { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "ctc_1", delta: raw },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { object: "response", output: [item], status: "completed" } },
  ]), { headers: { "content-type": "text/event-stream" } }));
  const result = await send(body, "openai-responses", "openai-responses");
  const chunks = events(result.text);
  expect(chunks.find((chunk) => chunk.type === "response.output_item.added").item.name).toBe("edit");
  expect(chunks.find((chunk) => chunk.type === "response.custom_tool_call_input.delta").delta).toBe(raw);
  expect(chunks.find((chunk) => chunk.type === "response.completed").response.output[0]).toEqual({ ...item, name: "edit" });
  expect(chunks.filter((chunk) => chunk.type === "response.completed")).toHaveLength(1);
});

it.each(Object.keys(models))("strips an exhausted %s source greeting once, before joining later blocks", async (source) => {
  const body = request(source, false);
  const later = OMP_GREETING_PREAMBLE + "Later project rules.\n";
  if (source === "openai" || source === "openai-responses") {
    const key = source === "openai" ? "messages" : "input";
    delete body.instructions;
    body[key] = [{ role: "system", content: OMP_GREETING_PREAMBLE }, { role: "developer", content: later }, { role: "user", content: "hi" }];
  } else if (source === "claude") body.system = [{ type: "text", text: OMP_GREETING_PREAMBLE }, { type: "text", text: later }];
  else body.systemInstruction.parts = [{ text: OMP_GREETING_PREAMBLE }, { text: later }];
  const before = JSON.stringify(body);
  proxyAwareFetch.mockImplementation(async () => upstream("openai-responses", false));
  const result = await send(body, source, "openai-responses");
  expect(result.response.status).toBe(200);
  const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
  expect(sent.instructions).toContain(later);
  expect(sent.instructions.split(OMP_GREETING_PREAMBLE)).toHaveLength(2);
  expect(JSON.stringify(body)).toBe(before);
});

it.each(Object.keys(models))("preserves explicit none without tools on %s", async (target) => {
  const body = request("openai", false, []);
  body.tool_choice = "none";
  proxyAwareFetch.mockImplementation(async () => upstream(target, false));
  expect((await send(body, "openai", target)).response.status).toBe(200);
  const sent = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
  expect(target === "gemini" ? sent.toolConfig.functionCallingConfig : sent.tool_choice).toEqual(target === "gemini" ? { mode: "NONE" } : target === "claude" ? { type: "none" } : "none");
});

it("keeps whitespace-only native Responses instructions instead of choosing a later project block", () => {
  const body = { instructions: " \n", input: [{ role: "system", content: OMP_GREETING_PREAMBLE + "Later project." }] };
  const sent = new FactoryExecutor().transformRequest(models["openai-responses"], body, false, credentials());
  expect(sent.instructions).toBe(FACTORY_DROID_SYSTEM_PROMPT + "\n\n \n");
  expect(sent.input[0]).toEqual(body.input[0]);
});

describe("Factory Anthropic exhausted system blocks", () => {
  it.each([
    ["user-only", { stream: false, messages: [{ role: "user", content: "Hi" }] }],
    ["greeting-only", { stream: false, messages: [{ role: "system", content: OMP_GREETING_PREAMBLE }, { role: "user", content: "Hi" }] }],
    ["Claude Code identity-only", { stream: false, messages: [{ role: "system", content: "You are Claude Code." }, { role: "user", content: "Hi" }] }],
  ])("accepts %s OpenAI input through the real Haiku JSON path", async (_scenario, body) => {
    const before = JSON.stringify(body);
    proxyAwareFetch.mockImplementation(async (_url, options) => {
      const wire = JSON.parse(options.body);
      const invalid = wire.system.some((block) => block.type === "text" && block.text === "");
      if (invalid) return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "system.1: cache_control cannot be set for empty text blocks" } }), { status: 400, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ id: "msg_haiku", type: "message", role: "assistant", content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 1 } }), { headers: { "content-type": "application/json" } });
    });
    const result = await send(body, "openai", "claude", { modelInfo: { provider: "factory", model: "claude-haiku-5-5" } });
    expect(result.response.status, result.text).toBe(200);
    expect(JSON.parse(result.text).choices[0].message.content).toBe("Hello");
    const wire = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(wire.system.every((block) => block.type !== "text" || block.text.length > 0)).toBe(true);
    expect(wire.system.some((block) => block.text === FACTORY_DROID_SYSTEM_PROMPT)).toBe(true);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("drops native empty cached text without trimming or changing surviving blocks", () => {
    const rule = { type: "text", text: "  Keep these rules.\n", cache_control: { type: "ephemeral", ttl: "1h" } };
    const opaque = { type: "provider_owned", signature: "signed", text: "" };
    const body = { system: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }, rule, opaque], messages: [{ role: "user", content: "Hi" }] };
    const before = JSON.stringify(body);
    const wire = new FactoryExecutor().transformRequest("claude-haiku-5-5", body, false, credentials());
    expect(wire.system).toEqual([{ type: "text", text: FACTORY_DROID_SYSTEM_PROMPT }, rule, opaque]);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("Factory Claude-to-Chat stream termination", () => {
  it.each([false, true])("emits one Chat sentinel after clean Claude EOF (tools=%s)", async (withTools) => {
    const body = request("openai", true, withTools ? ["read"] : []);
    proxyAwareFetch.mockImplementation(async () => withTools ? upstream("claude", true) : new Response(sse([
      { type: "message_start", message: { id: "msg_text", role: "assistant", content: [], usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Complete answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]), { headers: { "content-type": "text/event-stream" } }));
    const result = await send(body, "openai", "claude");
    expect(result.response.status).toBe(200);
    expect(result.text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(result.text.endsWith("data: [DONE]\n\n")).toBe(true);
    if (withTools) expect(returnedCall("openai", true, result.text)).toMatchObject({ id: "call_1", name: "read", arguments: args });
    else expect(events(result.text).map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("")).toBe("Complete answer");
  });

  it("does not duplicate an explicit upstream sentinel", async () => {
    proxyAwareFetch.mockImplementation(async () => new Response((await upstream("claude", true).text()) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    const result = await send(request("openai", true, ["read"]), "openai", "claude");
    expect(result.text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(returnedCall("openai", true, result.text)).toMatchObject({ name: "read", arguments: args });
  });
});
