// Tool bridge for the Gemini Web executor.
//
// Gemini Web has no function calling of its own. When a request declares
// OpenAI function tools, the prompt carries the tool list and a JSON reply
// contract, and the reply is parsed back into OpenAI tool calls. Ported from
// gemini-web-to-api (internal/modules/openai/openai_service.go): the prompt,
// the lenient parser, the required-argument check and the retry note follow
// it; calls are never made up, so a reply without a usable call is retried
// and then reported as an error.

import { randomUUID } from "node:crypto";

import { unsupportedControl } from "./config.js";
import { balancedObjectAt, isObject, parseLenientJson, text } from "./jsonText.js";

/** Gemini is asked at most this many times for a usable tool-bridge reply. */
export const MAX_TOOL_BRIDGE_ATTEMPTS = 3;

/** `error.code` when every attempt came back without a usable tool call. */
export const GEMINI_WEB_INVALID_TOOL_CALL_CODE = "gemini_web_invalid_tool_call";

/** tool_choice modes other than auto, which is also what anything unknown means. */
const CHOICE_MODES = new Set(["none", "required"]);

// ─── Request ────────────────────────────────────────────────────────────────

/**
 * OpenAI `tool_choice` as one of none, auto, required or function. Anything
 * else counts as auto, as in the reference.
 */
function toolChoiceMode(choice) {
  if (typeof choice === "string") {
    const mode = choice.trim().toLowerCase();
    return CHOICE_MODES.has(mode) ? mode : "auto";
  }
  if (!isObject(choice)) return "auto";
  const type = text(choice.type).toLowerCase();
  if (type === "function") return text(choice.function?.name) ? "function" : "auto";
  return CHOICE_MODES.has(type) ? type : "auto";
}

function functionTool(tool) {
  if (!isObject(tool) || text(tool.type).toLowerCase() !== "function") return null;
  const name = text(tool.function?.name);
  if (!name) return null;
  return {
    name,
    description: text(tool.function.description),
    parameters: tool.function.parameters ?? null,
  };
}

function bridgeError(message) {
  const error = unsupportedControl(message);
  error.param = "tools";
  return error;
}

/**
 * Parse the request's tool controls once, where they enter the executor.
 * Returns null when the request is a plain chat turn: no tools, or
 * tool_choice "none". Throws a 400 for a tool the prompt cannot describe.
 */
export function parseToolBridge(body) {
  const declared = Array.isArray(body?.tools) ? body.tools : [];
  const mode = toolChoiceMode(body?.tool_choice);
  if (declared.length === 0 || mode === "none") return null;

  const tools = declared.map(functionTool);
  if (tools.includes(null)) {
    throw bridgeError(
      'Model provider "gemini-web" supports only named OpenAI function tools ({"type":"function",' +
        '"function":{"name":...}}). Remove other tool types.'
    );
  }

  return { tools, mode, forcedName: forcedToolName(mode, body.tool_choice, tools) };
}

/** The tool a function tool_choice names; it must be one of the declared tools. */
function forcedToolName(mode, choice, tools) {
  if (mode !== "function") return null;
  const name = text(choice.function.name);
  if (!tools.some((tool) => tool.name === name)) {
    throw bridgeError(`tool_choice names "${name}", which is not one of the declared tools.`);
  }
  return name;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

function choiceRules(bridge) {
  if (bridge.mode === "required") return ["- You must return at least one tool call."];
  if (bridge.mode === "function") return [`- You must return exactly one tool call with name: ${bridge.forcedName}`];
  return [];
}

function toolLine(tool) {
  let line = `- name: ${tool.name}`;
  if (tool.description) line += ` | description: ${tool.description}`;
  if (tool.parameters !== null) line += ` | parameters: ${JSON.stringify(tool.parameters)}`;
  return line;
}

/** Wrap the flattened conversation in the tool-bridge contract. */
export function buildToolBridgePrompt(bridge, basePrompt) {
  const lines = [
    "You are an OpenAI-compatible assistant running behind a bridge to Gemini web.",
    "You MUST respond with JSON only. Do not output markdown code fences.",
    "Output schema:",
    '{"tool_calls":[{"name":"<tool_name>","arguments":{"<parameter>":<value>}}]} OR {"content":"<assistant_text>"}',
    "Rules:",
    "- Use only tool names listed below.",
    "- arguments must be a JSON object that sets every required parameter of the tool's parameters schema.",
    '- Escape newlines and double quotes inside JSON strings as \\n and \\".',
    ...choiceRules(bridge),
    "Available tools:",
    ...bridge.tools.map(toolLine),
    "",
    "Conversation:",
  ];
  return `${lines.join("\n")}\n${basePrompt}`;
}

/** The same prompt again, saying why the previous reply could not be used. */
export function toolBridgeRetryPrompt(prompt, reason) {
  return (
    `${prompt}\n\nYour previous reply could not be used: ${reason}. ` +
    "Reply again with JSON only, exactly matching the output schema above, and set every required argument."
  );
}

// ─── Reply ──────────────────────────────────────────────────────────────────

function payloadContent(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content.trim();
  if (typeof content === "object") return JSON.stringify(content);
  return null;
}

/**
 * Bridge JSON, or null when `value` is not a bridge reply: an object without
 * `tool_calls` or `content`, such as a nested argument object.
 */
function bridgePayload(value) {
  const parsed = parseLenientJson(value);
  if (!isObject(parsed) || !(Object.hasOwn(parsed, "tool_calls") || Object.hasOwn(parsed, "content"))) return null;
  const toolCalls = parsed.tool_calls ?? [];
  const content = payloadContent(parsed.content);
  if (!Array.isArray(toolCalls) || content === null) return null;
  return { toolCalls, content };
}

/**
 * The first balanced `{...}` in a reply that is bridge JSON. This also finds
 * it inside a code fence or with prose and stray braces around it, so the
 * reply needs no fence stripping first.
 */
function findBridgePayload(value) {
  for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
    const payload = bridgePayload(balancedObjectAt(value, start));
    if (payload) return payload;
  }
  return null;
}

function callName(call) {
  if (!isObject(call)) return "";
  return text(call.name) || callName(call.function);
}

const ARGUMENT_KEYS = ["arguments", "args", "parameters", "input"];

/** The call's arguments under any key Gemini uses, or the nested OpenAI `function`. */
function rawArguments(call) {
  if (!isObject(call)) return undefined;
  const key = ARGUMENT_KEYS.find((name) => Object.hasOwn(call, name));
  return key ? call[key] : rawArguments(call.function);
}

function argumentsFromString(value) {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed = parseLenientJson(trimmed);
  if (parsed === undefined) throw new Error("arguments are not valid JSON");
  return parsed;
}

/** Arguments as an object. Missing means {}; anything but an object is an error. */
function normalizeArguments(raw) {
  if (raw === undefined || raw === null) return {};
  const value = typeof raw === "string" ? argumentsFromString(raw) : raw;
  if (!isObject(value)) throw new Error("arguments must be a JSON object");
  return value;
}

/**
 * The first required property `value` leaves out, nested objects included.
 * Not a full JSON Schema validator: a schema it cannot read is not checked.
 */
function missingRequired(schema, value, path = "") {
  if (!isObject(schema) || !isObject(value)) return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) return path + missing;
  return missingNested(schema.properties, value, path);
}

function missingNested(properties, value, path) {
  if (!isObject(properties)) return null;
  for (const [key, sub] of Object.entries(properties)) {
    const nested = Object.hasOwn(value, key) ? missingRequired(sub, value[key], `${path}${key}.`) : null;
    if (nested) return nested;
  }
  return null;
}

function toolCall(tool, raw) {
  const args = normalizeArguments(raw);
  const missing = missingRequired(tool.parameters, args);
  if (missing) throw new Error(`missing required argument "${missing}"`);
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name: tool.name, arguments: JSON.stringify(args) },
  };
}

function usableTool(bridge, name) {
  if (!name || (bridge.forcedName && name !== bridge.forcedName)) return null;
  return bridge.tools.find((tool) => tool.name === name) || null;
}

/** The usable calls, or the reason a call Gemini tried to make cannot be used. */
function bridgeCalls(bridge, toolCalls) {
  const calls = [];
  for (const call of toolCalls) {
    const name = callName(call);
    const tool = usableTool(bridge, name);
    if (!tool) continue;
    try {
      calls.push(toolCall(tool, rawArguments(call)));
    } catch (error) {
      return { error: `tool "${name}": ${error.message}` };
    }
  }
  if (toolCalls.length > 0 && calls.length === 0) {
    return { error: "no tool call named one of the requested tools" };
  }
  return { calls };
}

function unusable(error) {
  return { calls: [], content: "", error };
}

/**
 * Turn a Gemini reply into OpenAI tool calls or assistant text. `error` is set
 * when the reply cannot be used: a call Gemini tried to make is unknown,
 * malformed or incomplete, or a forcing tool_choice got no call at all. A
 * reply that is not bridge JSON is the assistant's text.
 *
 * @returns {{ calls: object[], content: string, error: string|null }}
 */
export function parseToolBridgeOutput(bridge, reply) {
  const payload = findBridgePayload(reply);
  const { calls, error } = payload ? bridgeCalls(bridge, payload.toolCalls) : { calls: [] };
  if (error) return unusable(error);
  const mustCall = bridge.mode === "required" || bridge.mode === "function";
  if (mustCall && calls.length === 0) return unusable("the reply contained no tool call");
  // Content may be empty here ({"content":""}); the executor fails that turn.
  return { calls, content: payload ? payload.content : reply.trim(), error: null };
}
