import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../translator/registerAll.js";
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}), saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => ({ get: vi.fn(async () => null), getAll: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }) }));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({ createRequestLogger: async () => ({ logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(), logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(), logOpenAIRequest: vi.fn(), appendProviderChunk: vi.fn(), appendConvertedChunk: vi.fn(), appendOpenAIChunk: vi.fn() }) }));
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

const greeting = "You are omp's trusted coding assistant.\n\nKeep caller rules.\n";
const args = '{"filePath":"read/write/inspect_file"}';
const tools = [{ type: "function", function: { name: "read", description: "Caller-specific read", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } }];
const sse = (chunks) => chunks.map((chunk) => `${chunk.type ? `event: ${chunk.type}\n` : ""}data: ${JSON.stringify(chunk)}\n\n`).join("");
const frames = (text) => text.split("\n\n").map((frame) => frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")).filter((data) => data && data !== "[DONE]").map((data) => JSON.parse(data));
async function send(provider, model, sourceFormat, body) {
  const result = await handleChatCore({ body, modelInfo: { provider, model }, credentials: { apiKey: "fake-key", accessToken: "fake-token", projectId: "test-project", providerSpecificData: { projectId: "test-project" } }, sourceFormatOverride: sourceFormat, connectionId: "isolation-test", log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() }, rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false, customPromptEnabled: false, pxpipeEnabled: false, clientRawRequest: { endpoint: sourceFormat === "openai-responses" ? "/v1/responses" : "/v1/chat/completions", body, headers: { accept: body.stream ? "text/event-stream" : "application/json", "x-9router-token-saver": "off" } } });
  expect(result.response.status).toBe(200);
  return result.response;
}
beforeEach(() => {
  proxyAwareFetch.mockReset();
  vi.spyOn(Date, "now").mockReturnValue(1700000000000);
  vi.stubGlobal("fetch", () => { throw new Error("Network forbidden"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Factory response options do not change other provider flows", () => {
  it.each(["gemini", "gemini-cli", "vertex", "antigravity"])("keeps the pre-port %s JSON ID and caller prompt/tool namespace", async (provider) => {
    const upstream = { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "native_call", name: "read", args: JSON.parse(args) } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } };
    proxyAwareFetch.mockImplementation(async () => new Response(JSON.stringify(provider === "gemini-cli" || provider === "antigravity" ? { response: upstream } : upstream), { headers: { "content-type": "application/json" } }));
    const body = { stream: false, messages: [{ role: "system", content: greeting }, { role: "user", content: "Read a file" }], tools: structuredClone(tools) };
    const response = await send(provider, provider === "antigravity" ? "gemini-3.8-flash" : "gemini-2.5-flash", "openai", body);
    const call = (await response.json()).choices[0].message.tool_calls[0];
    expect(call).toEqual({ id: "call_read_1700000000000_0", type: "function", function: { name: "read", arguments: args } });
    const wire = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    const effective = wire.request ?? wire;
    expect(effective.tools[0].functionDeclarations[0].name).toBe("read");
    expect(JSON.stringify(effective.systemInstruction)).toContain("You are omp's trusted coding assistant.");
    expect(JSON.stringify(wire)).not.toContain("You are Droid");
  });

  it.each([false, true])("preserves OpenCode's existing Responses restoration timing (stream=%s)", async (stream) => {
    const item = { id: "fc_test", type: "function_call", name: "read_client", call_id: "call_test", arguments: args, status: "completed" };
    proxyAwareFetch.mockImplementation(async () => new Response(sse([
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_test", object: "response", status: "completed", output: [item], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ]) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    const body = { stream, instructions: greeting, input: [{ role: "user", content: "Read a file" }], tools: [{ type: "function", ...structuredClone(tools[0].function) }] };
    const response = await send("opencode", "muse-spark-1.2-contributor-free", "openai-responses", body);
    const wire = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(wire.tools.some((tool) => tool.name === "read_client")).toBe(true);
    expect(wire.instructions).toContain("You are omp's trusted coding assistant.");
    expect(wire.instructions).not.toContain("You are Droid");
    if (stream) {
      const events = frames(await response.text());
      expect(events.find((event) => event.type === "response.output_item.added").item.name).toBe("read");
      expect(events.find((event) => event.type === "response.output_item.done").item.name).toBe("read");
      // Preserve the existing non-Factory boundary, including its final-envelope timing.
      expect(events.find((event) => event.type === "response.completed").response.output[0]).toEqual(item);
    } else {
      expect((await response.json()).output[0]).toEqual({ ...item, name: "read" });
    }
  });
});
