// Gemini Web tool bridge: the prompt contract and reply parser that turn a
// plain Gemini Web answer into OpenAI tool calls. Cases are ported from
// gemini-web-to-api's openai_tool_bridge_test.go and openai_service_test.go.

import { describe, expect, it } from "vitest";

import {
  buildToolBridgePrompt,
  parseToolBridge,
  parseToolBridgeOutput,
} from "../../open-sse/executors/gemini-web/toolBridge.js";

const DONE_TOOL = {
  type: "function",
  function: {
    name: "done",
    description: "Finish with answer and document",
    parameters: {
      type: "object",
      properties: {
        answer: { type: "string" },
        document: {
          type: "object",
          properties: { title: { type: "string" }, body: { type: "string" } },
          required: ["title", "body"],
        },
      },
      required: ["answer", "document"],
    },
  },
};

const FORCED_DONE = { type: "function", function: { name: "done" } };
const WANT_DONE_ARGUMENTS = '{"answer":"Done.","document":{"title":"Test","body":"# Hello\\n\\nSome markdown body."}}';

const bridgeOf = (extra = {}) => parseToolBridge({ tools: [DONE_TOOL], ...extra });

describe("Gemini Web tool bridge request", () => {
  it("is off without tools or with tool_choice none", () => {
    expect(parseToolBridge({})).toBeNull();
    expect(parseToolBridge({ tools: [] })).toBeNull();
    expect(parseToolBridge({ tools: [DONE_TOOL], tool_choice: "none" })).toBeNull();
    expect(parseToolBridge({ tools: [DONE_TOOL], tool_choice: { type: "none" } })).toBeNull();
  });

  it("reads tool_choice modes the way OpenAI clients send them", () => {
    expect(bridgeOf().mode).toBe("auto");
    expect(bridgeOf({ tool_choice: "AUTO" }).mode).toBe("auto");
    expect(bridgeOf({ tool_choice: "required" }).mode).toBe("required");
    expect(bridgeOf({ tool_choice: { type: "required" } }).mode).toBe("required");
    expect(bridgeOf({ tool_choice: "something-else" }).mode).toBe("auto");
    expect(bridgeOf({ tool_choice: { type: "function" } }).mode).toBe("auto");
    const forced = bridgeOf({ tool_choice: FORCED_DONE });
    expect(forced.mode).toBe("function");
    expect(forced.forcedName).toBe("done");
  });

  it("rejects a tool it cannot describe and a forced tool that was not declared", () => {
    expect(() => parseToolBridge({ tools: [DONE_TOOL, { type: "web_search" }] })).toThrow(/function tools/);
    expect(() => parseToolBridge({ tools: [{ type: "function", function: { name: " " } }] })).toThrow(/function tools/);
    expect(() =>
      parseToolBridge({ tools: [DONE_TOOL], tool_choice: { type: "function", function: { name: "finish" } } })
    ).toThrow(/"finish"/);
  });
});

describe("Gemini Web tool bridge prompt", () => {
  it("states the JSON contract, the tools and then the conversation", () => {
    const prompt = buildToolBridgePrompt(bridgeOf(), "User: hi");
    expect(prompt.startsWith("You are an OpenAI-compatible assistant running behind a bridge to Gemini web.\n")).toBe(true);
    expect(prompt).toContain('{"tool_calls":[{"name":"<tool_name>","arguments":{"<parameter>":<value>}}]} OR {"content":"<assistant_text>"}\n');
    expect(prompt).toContain(
      `Available tools:\n- name: done | description: Finish with answer and document | parameters: ${JSON.stringify(DONE_TOOL.function.parameters)}\n\nConversation:\nUser: hi`
    );
    expect(prompt).not.toContain("You must return");
  });

  it("adds the rule that matches a forcing tool_choice", () => {
    expect(buildToolBridgePrompt(bridgeOf({ tool_choice: "required" }), "x")).toContain(
      "- You must return at least one tool call.\n"
    );
    expect(buildToolBridgePrompt(bridgeOf({ tool_choice: FORCED_DONE }), "x")).toContain(
      "- You must return exactly one tool call with name: done\n"
    );
  });

  it("leaves out an empty description and missing parameters", () => {
    const prompt = buildToolBridgePrompt(parseToolBridge({ tools: [{ type: "function", function: { name: "ping" } }] }), "x");
    expect(prompt).toContain("Available tools:\n- name: ping\n\nConversation:\nx");
  });
});

describe("Gemini Web tool bridge reply parser", () => {
  const weather = parseToolBridge({ tools: [{ type: "function", function: { name: "get_current_weather" } }] });

  it("parses a fenced tool_use reply", () => {
    const reply = '```json\n{"status":"tool_use","tool_calls":[{"name":"get_current_weather","arguments":{"location":"Hanoi"}}]}\n```';
    const { calls, content, error } = parseToolBridgeOutput(weather, reply);
    expect(error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: "function", function: { name: "get_current_weather", arguments: '{"location":"Hanoi"}' } });
    expect(calls[0].id).toMatch(/^call_[0-9a-f]{24}$/);
    expect(content).toBe("");
  });

  it("parses a tool call with prose around it", () => {
    const reply =
      "I'll check the weather for Hanoi right now.\n" +
      '{"status":"tool_use","tool_calls":[{"name":"get_current_weather","arguments":{"location":"Hanoi"}}]}\nDone.';
    const { calls, error } = parseToolBridgeOutput(weather, reply);
    expect(error).toBeNull();
    expect(calls.map((call) => call.function.name)).toEqual(["get_current_weather"]);
  });

  it("returns plain text as the reply", () => {
    const reply = "The weather in Hanoi is nice and sunny today.";
    expect(parseToolBridgeOutput(weather, reply)).toEqual({ calls: [], content: reply, error: null });
  });

  it("returns the content of a text reply and keeps a JSON content value as JSON text", () => {
    expect(parseToolBridgeOutput(weather, '{"content":"  Sunny.  "}').content).toBe("Sunny.");
    expect(parseToolBridgeOutput(weather, '{"status":"text","content":{"temp":30}}').content).toBe('{"temp":30}');
  });

  it("gives back no content for an empty reply", () => {
    expect(parseToolBridgeOutput(weather, "  \n")).toEqual({ calls: [], content: "", error: null });
  });

  it.each([
    [
      "raw newlines inside argument strings",
      '{"tool_calls":[{"name":"done","arguments":{"answer":"Done.","document":{"title":"Test","body":"# Hello\n\nSome markdown body."}}}]}',
    ],
    [
      "OpenAI-style nested function with string arguments",
      '{"tool_calls":[{"type":"function","function":{"name":"done","arguments":"{\\"answer\\":\\"Done.\\",\\"document\\":{\\"title\\":\\"Test\\",\\"body\\":\\"# Hello\\\\n\\\\nSome markdown body.\\"}}"}}]}',
    ],
    [
      "args instead of arguments",
      '{"tool_calls":[{"name":"done","args":{"answer":"Done.","document":{"title":"Test","body":"# Hello\n\nSome markdown body."}}}]}',
    ],
    [
      "prose with braces before the JSON",
      'Calling done with {answer, document}:\n{"tool_calls":[{"name":"done","arguments":{"answer":"Done.","document":{"title":"Test","body":"# Hello\n\nSome markdown body."}}}]}',
    ],
  ])("accepts a lenient reply: %s", (_name, reply) => {
    const { calls, error } = parseToolBridgeOutput(bridgeOf({ tool_choice: FORCED_DONE }), reply);
    expect(error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].function).toEqual({ name: "done", arguments: WANT_DONE_ARGUMENTS });
  });

  it.each([
    ["empty arguments", '{"tool_calls":[{"name":"done","arguments":{}}]}', 'missing required argument "answer"'],
    [
      "missing nested argument",
      '{"tool_calls":[{"name":"done","arguments":{"answer":"Done.","document":{"title":"Test"}}}]}',
      'missing required argument "document.body"',
    ],
    ["arguments string that is not JSON", '{"tool_calls":[{"name":"done","arguments":"{answer: Done."}]}', "not valid JSON"],
    ["arguments that are not an object", '{"tool_calls":[{"name":"done","arguments":["Done."]}]}', "must be a JSON object"],
    ["only an unknown tool", '{"tool_calls":[{"name":"finish","arguments":{"answer":"Done."}}]}', "no tool call named"],
  ])("rejects an unusable call: %s", (_name, reply, wanted) => {
    const { calls, error } = parseToolBridgeOutput(bridgeOf({ tool_choice: FORCED_DONE }), reply);
    expect(calls).toEqual([]);
    expect(error).toContain(wanted);
  });

  it("drops calls to undeclared tools and to tools other than the forced one", () => {
    const bridge = parseToolBridge({
      tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }],
      tool_choice: { type: "function", function: { name: "b" } },
    });
    const reply = '{"tool_calls":[{"name":"zzz"},{"name":"a"},{"name":"b","arguments":{"x":1}}]}';
    const { calls, error } = parseToolBridgeOutput(bridge, reply);
    expect(error).toBeNull();
    expect(calls.map((call) => [call.function.name, call.function.arguments])).toEqual([["b", '{"x":1}']]);
  });

  it("allows empty arguments when the tool requires none", () => {
    const bridge = parseToolBridge({
      tools: [{ type: "function", function: { name: "ping", parameters: { type: "object", properties: {} } } }],
    });
    const { calls, error } = parseToolBridgeOutput(bridge, '{"tool_calls":[{"name":"ping"}]}');
    expect(error).toBeNull();
    expect(calls.map((call) => call.function.arguments)).toEqual(["{}"]);
  });

  it("asks for a call when tool_choice forces one and the reply is text", () => {
    for (const tool_choice of ["required", FORCED_DONE]) {
      const { calls, error } = parseToolBridgeOutput(bridgeOf({ tool_choice }), "The answer is 42.");
      expect(calls).toEqual([]);
      expect(error).toBe("the reply contained no tool call");
    }
  });
});
