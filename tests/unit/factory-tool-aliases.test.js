import { describe, it, expect } from "vitest";
import { FACTORY_TOOL_ALIASES } from "../../open-sse/config/factoryCompatibility.js";
import { FACTORY_COMPATIBILITY_CONTEXT, captureFactoryCompatibility, applyFactoryToolAliases, composeFactoryToolNameMaps } from "../../open-sse/utils/factoryRequestCompatibility.js";

const pairs = Object.entries(FACTORY_TOOL_ALIASES);
describe("Factory structural aliases", () => {
  it.each(pairs)("roundtrips %s without touching payload bytes", (name, wire) => {
    const schema = { type: "object", properties: { name: { const: name } } };
    const args = `{"name":"${name}/inspect_file"}`;
    const original = { tools: [{ type: "function", function: { name, description: name, parameters: schema, strict: true } }], messages: [{ role: "assistant", tool_calls: [{ id: "call", function: { name, arguments: args } }] }, { role: "tool", name, tool_call_id: "call", content: args }], opaque: { name, signature: "signed" } };
    const before = JSON.stringify(original);
    const { body, toolNameMap } = applyFactoryToolAliases(original, "openai-completions");
    expect(body.tools[0].function).toEqual({ name: wire, description: name, parameters: schema, strict: true });
    expect(body.tools[0].function.parameters).toBe(schema);
    expect(body.messages[0].tool_calls[0]).toEqual({ id: "call", function: { name: wire, arguments: args } });
    expect(body.messages[1]).toEqual({ role: "tool", name: wire, tool_call_id: "call", content: args });
    expect(body.opaque).toBe(original.opaque);
    expect(toolNameMap.get(wire)).toBe(name);
    expect(JSON.stringify(original)).toBe(before);
  });
  it.each(["constructor", "toString", "Read", "inspect_file", "unknown"])("leaves %s alone", (name) => {
    const original = { tools: [{ type: "function", function: { name } }] };
    const result = applyFactoryToolAliases(original, "openai-completions");
    expect(result.body).toBe(original);
    expect(result.toolNameMap.size).toBe(0);
  });
  it("handles native declarations and retained history only", () => {
    const fixtures = [
      ["anthropic", { tools: [{ name: "read", input_schema: {} }], messages: [{ role: "assistant", content: [{ type: "tool_use", id: "id", name: "read", input: { name: "read" } }, { type: "tool_reference", name: "read" }, { type: "thinking", signature: "read", thinking: "read" }] }] }, (b) => [b.tools[0].name, b.messages[0].content[0].name, b.messages[0].content[1].name]],
      ["openai-responses", { tools: [{ type: "custom", name: "read", format: { type: "grammar", definition: "read" } }, { type: "web_search", name: "read" }], input: [{ type: "custom_tool_call", name: "read", input: "read", call_id: "id" }] }, (b) => [b.tools[0].name, b.input[0].name]],
      ["google", { tools: [{ functionDeclarations: [{ name: "read", parameters: {} }] }], contents: [{ parts: [{ functionCall: { name: "read", args: { name: "read" }, id: "id" } }, { functionResponse: { name: "read", response: { name: "read" } } }] }] }, (b) => [b.tools[0].functionDeclarations[0].name, b.contents[0].parts[0].functionCall.name, b.contents[0].parts[1].functionResponse.name]],
    ];
    for (const [gateway, original, names] of fixtures) {
      const before = JSON.stringify(original);
      const { body } = applyFactoryToolAliases(original, gateway);
      expect(names(body).every((name) => name === "inspect_file")).toBe(true);
      expect(JSON.stringify(original)).toBe(before);
    }
    expect(applyFactoryToolAliases({ input: [{ type: "function_call", name: "read", arguments: "{}" }] }, "openai-responses").toolNameMap.get("inspect_file")).toBe("read");
    const empty = {};
    expect(applyFactoryToolAliases(empty, "google").body).toBe(empty);
  });
  it("rejects declaration/history ownership collisions, including captured source conflicts", () => {
    for (const messages of [[], [{ role: "tool", name: "inspect_file", content: "old" }]]) {
      const tools = [{ function: { name: "read" } }, ...(messages.length ? [] : [{ function: { name: "inspect_file" } }])];
      expect(() => applyFactoryToolAliases({ tools, messages }, "openai-completions")).toThrow("factory: tool name collision between read and inspect_file");
    }
    const capture = captureFactoryCompatibility("openai", { tools: [{ name: "read" }, { name: "inspect_file" }] }, "Droid");
    const target = { tools: [{ name: "read" }], [FACTORY_COMPATIBILITY_CONTEXT]: capture.context };
    expect(() => applyFactoryToolAliases(target, "anthropic")).toThrow("collision");
  });
  it("resolves translator names and composes directly to clients", () => {
    const previous = new Map([["sanitized", "read"], ["other", "client"], ["read", "read"]]);
    const result = applyFactoryToolAliases({ tools: [{ name: "sanitized" }] }, "anthropic", previous);
    expect(result.body.tools[0].name).toBe("inspect_file");
    expect(composeFactoryToolNameMaps(previous, result.toolNameMap).get("inspect_file")).toBe("read");
    expect(composeFactoryToolNameMaps(previous, result.toolNameMap).get("other")).toBe("client");
    expect(() => composeFactoryToolNameMaps(new Map([["a", "b"], ["b", "a"]]), null)).toThrow("cyclic");
    expect(() => composeFactoryToolNameMaps(new Map([["inspect_file", "other"]]), new Map([["inspect_file", "read"]]))).toThrow("collision");
  });
});
