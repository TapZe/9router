// Gemini Web tool bridge: the prompt contract and reply parser that turn a
// plain Gemini Web answer into OpenAI tool calls. Cases are ported from
// gemini-web-to-api's openai_tool_bridge_test.go and openai_service_test.go.

import { describe, expect, it } from "vitest";

import {
  buildToolBridgePrompt,
  parseToolBridge,
  parseToolBridgeOutput,
  toolBridgeRetryPrompt,
} from "../../open-sse/executors/gemini-web/toolBridge.js";
import { checkGeminiWebUnsupportedControls } from "../../open-sse/executors/gemini-web/capabilities.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

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

  it("reads a missing body as no tools and trims a tool_choice string", () => {
    expect(parseToolBridge(null)).toBeNull();
    expect(parseToolBridge(undefined)).toBeNull();
    expect(bridgeOf({ tool_choice: " Required " }).mode).toBe("required");
    expect(bridgeOf({ tool_choice: ["required"] }).mode).toBe("auto");
    expect(bridgeOf({ tool_choice: { type: "bogus" } }).mode).toBe("auto");
  });

  it("rejects tools that are not objects or have no function", () => {
    const kinds = [
      null,
      "done",
      { type: "function" },
      { type: "FUNCTION", function: { name: "" } },
      { type: "retrieval", function: { name: "ping" } },
    ];
    for (const tool of kinds) {
      expect(() => parseToolBridge({ tools: [tool] })).toThrow(
        'Model provider "gemini-web" supports only named OpenAI function tools ({"type":"function",' +
          '"function":{"name":...}}). Remove other tool types.'
      );
    }
    expect(parseToolBridge({ tools: [{ type: "Function", function: { name: " ping " } }] }).tools).toEqual([
      { name: "ping", description: "", parameters: null },
    ]);
  });

  it("rejects a tool it cannot describe and a forced tool that was not declared", () => {
    expect(() => parseToolBridge({ tools: [DONE_TOOL, { type: "web_search" }] })).toThrow(/function tools/);
    expect(() => parseToolBridge({ tools: [{ type: "function", function: { name: " " } }] })).toThrow(/function tools/);
    expect(() =>
      parseToolBridge({ tools: [DONE_TOOL], tool_choice: { type: "function", function: { name: "finish" } } })
    ).toThrow(/"finish"/);
  });
});

describe("Gemini Web request guard", () => {
  // chatCore runs this guard on the client's own body before translation, so
  // Anthropic-shaped tools and tool_choice must pass it; the bridge judges the
  // translated OpenAI tools later.
  it("lets tools and every tool_choice through and still refuses legacy functions", () => {
    const claudeTool = { name: "lookup", input_schema: { type: "object" } };
    expect(checkGeminiWebUnsupportedControls({ tools: [claudeTool], tool_choice: { type: "any" } })).toBeNull();
    expect(checkGeminiWebUnsupportedControls({ tools: [DONE_TOOL], tool_choice: "required" })).toBeNull();
    expect(checkGeminiWebUnsupportedControls({ tool_choice: FORCED_DONE })).toBeNull();
    expect(checkGeminiWebUnsupportedControls({ functions: [DONE_TOOL.function] })).toMatchObject({ param: "functions" });
  });
});

describe("Gemini Web published capabilities", () => {
  it("lists tool calling for chat models and not for the image task", () => {
    for (const provider of ["gemini-web", "gweb"]) {
      expect(getCapabilitiesForModel(provider, "gemini-auto").tools).toBe(true);
      expect(getCapabilitiesForModel(provider, "gemini-image").tools).toBe(false);
    }
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

  it("writes the reference's prompt word for word", () => {
    const bridge = parseToolBridge({
      tools: [{ type: "function", function: { name: "ping", description: " Ping it ", parameters: { type: "object" } } }],
    });
    expect(buildToolBridgePrompt(bridge, "User: hi")).toBe(
      [
        "You are an OpenAI-compatible assistant running behind a bridge to Gemini web.",
        "You MUST respond with JSON only. Do not output markdown code fences.",
        "Output schema:",
        '{"tool_calls":[{"name":"<tool_name>","arguments":{"<parameter>":<value>}}]} OR {"content":"<assistant_text>"}',
        "Rules:",
        "- Use only tool names listed below.",
        "- arguments must be a JSON object that sets every required parameter of the tool's parameters schema.",
        '- Escape newlines and double quotes inside JSON strings as \\n and \\".',
        "Available tools:",
        '- name: ping | description: Ping it | parameters: {"type":"object"}',
        "",
        "Conversation:",
        "User: hi",
      ].join("\n")
    );
  });

  it("writes the retry note after the prompt", () => {
    expect(toolBridgeRetryPrompt("P", "why")).toBe(
      "P\n\nYour previous reply could not be used: why. Reply again with JSON only, exactly matching the " +
        "output schema above, and set every required argument."
    );
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

  const lookup = parseToolBridge({
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", required: ["q"] } } }],
  });
  const lookupArgs = (reply) => {
    const { calls, error } = parseToolBridgeOutput(lookup, reply);
    return error ?? calls.map((call) => call.function.arguments);
  };

  it("does not end a JSON object at a brace or quote inside a string", () => {
    const reply = 'Using {"x":1} first: {"tool_calls":[{"name":"lookup","arguments":{"q":"a } \\"{ b"}}]} done }';
    expect(lookupArgs(reply)).toEqual(['{"q":"a } \\"{ b"}']);
  });

  it("escapes raw newlines only inside strings", () => {
    const reply = '{\n  "tool_calls": [\n    {"name": "lookup", "arguments": {"q": "line 1\nline 2 \\" \t end"}}\n  ]\n}';
    expect(lookupArgs(reply)).toEqual(['{"q":"line 1\\nline 2 \\" \\t end"}']);
  });

  it("reads arguments under parameters, input and a JSON string", () => {
    expect(lookupArgs('{"tool_calls":[{"name":"lookup","parameters":{"q":"p"}}]}')).toEqual(['{"q":"p"}']);
    expect(lookupArgs('{"tool_calls":[{"name":"lookup","input":{"q":"i"}}]}')).toEqual(['{"q":"i"}']);
    expect(lookupArgs('{"tool_calls":[{"name":"lookup","arguments":"  {\\"q\\":\\"s\\"}  "}]}')).toEqual(['{"q":"s"}']);
  });

  it("treats empty or null arguments as {} and other strings as errors", () => {
    const ping = parseToolBridge({ tools: [{ type: "function", function: { name: "ping" } }] });
    for (const args of ['""', '"  "', "null"]) {
      const { calls, error } = parseToolBridgeOutput(ping, `{"tool_calls":[{"name":"ping","arguments":${args}}]}`);
      expect(error).toBeNull();
      expect(calls[0].function.arguments).toBe("{}");
    }
    expect(lookupArgs('{"tool_calls":[{"name":"lookup","arguments":"[1]"}]}')).toBe(
      'tool "lookup": arguments must be a JSON object'
    );
    expect(lookupArgs('{"tool_calls":[{"name":"lookup","arguments":"q=x"}]}')).toBe(
      'tool "lookup": arguments are not valid JSON'
    );
  });

  it("reads a payload whose first string is empty", () => {
    expect(parseToolBridgeOutput(lookup, '{"":0,"content":"hi"}').content).toBe("hi");
    expect(parseToolBridgeOutput(lookup, '{"":0,"content":"a\nb"}').content).toBe("a\nb");
  });

  it("does not read calls from JSON whose content is not text or an object", () => {
    const reply = '{"tool_calls":[{"name":"lookup","arguments":{"q":"x"}}],"content":42}';
    expect(parseToolBridgeOutput(lookup, reply)).toEqual({ calls: [], content: reply, error: null });
  });

  it("skips calls that are not objects", () => {
    expect(lookupArgs('{"tool_calls":[null,"lookup",{"name":"lookup","arguments":{"q":"x"}}]}')).toEqual(['{"q":"x"}']);
  });

  it("keeps a reply that is not bridge JSON as trimmed text", () => {
    for (const reply of ['{"content":42}', '{"tool_calls":{"name":"lookup"}}', '{"other":true}']) {
      expect(parseToolBridgeOutput(lookup, `  ${reply}\n`)).toEqual({ calls: [], content: reply, error: null });
    }
  });

  it("reads an empty bridge reply as empty, not as its JSON text", () => {
    for (const reply of ['{"content":""}', '{"content":null}', '{"tool_calls":[]}', '{"tool_calls":null,"content":" "}']) {
      expect(parseToolBridgeOutput(lookup, reply)).toEqual({ calls: [], content: "", error: null });
    }
  });

  it("returns no calls and no content with an error", () => {
    expect(parseToolBridgeOutput(lookup, '{"tool_calls":[{"name":"lookup"}]}')).toEqual({
      calls: [],
      content: "",
      error: 'tool "lookup": missing required argument "q"',
    });
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
      expect(parseToolBridgeOutput(bridgeOf({ tool_choice }), "The answer is 42.")).toEqual({
        calls: [],
        content: "",
        error: "the reply contained no tool call",
      });
    }
  });
});
