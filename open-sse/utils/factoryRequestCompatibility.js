import { FACTORY_TOOL_ALIASES, OMP_GREETING_PREAMBLE } from "../config/factoryCompatibility.js";
import { FORMATS } from "../translator/formats.js";

/** Request-local provenance, excluded from JSON and read before structuredClone. */
export const FACTORY_COMPATIBILITY_CONTEXT = Symbol("factoryCompatibilityContext");
/** A local pre-fetch rejection handled only by the Factory executor. */
export class FactoryCompatibilityError extends Error {}

const alias = (name) => Object.hasOwn(FACTORY_TOOL_ALIASES, name) ? FACTORY_TOOL_ALIASES[name] : name;
const nativeFormat = (format) => ({
  anthropic: FORMATS.CLAUDE,
  google: FORMATS.GEMINI,
  "openai-completions": FORMATS.OPENAI,
  [FORMATS.GEMINI_CLI]: FORMATS.GEMINI,
  [FORMATS.ANTIGRAVITY]: FORMATS.GEMINI,
})[format] ?? format;
const effectiveBody = (format, body) => format === FORMATS.ANTIGRAVITY ? body.request || body : body;

function mapArray(items, fn) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const next = items.map((item, index) => {
    const mapped = fn(item, index);
    changed ||= mapped !== item;
    return mapped;
  });
  return changed ? next : items;
}

function field(object, key, value) {
  return object[key] === value ? object : { ...object, [key]: value };
}

function named(object, mapName) {
  if (!object || typeof object.name !== "string") return object;
  return field(object, "name", mapName(object.name));
}

/** Walk only declaration and replay positions owned by the selected protocol. */
function walkNames(body, format, mapName) {
  if (![FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, FORMATS.GEMINI].includes(format)) return body;
  const fn = (object) => named(object, mapName);
  const chatCall = (call) => call?.function ? field(call, "function", fn(call.function)) : call;
  const contentPart = (part) => {
    if (!part || typeof part !== "object") return part;
    if (part.type === "tool_use" || part.type === "tool_reference") return fn(part);
    return part;
  };
  let next = body;
  if (format === FORMATS.GEMINI) {
    next = field(next, "tools", mapArray(next.tools, (tool) => tool?.functionDeclarations
      ? field(tool, "functionDeclarations", mapArray(tool.functionDeclarations, fn)) : tool));
    next = field(next, "contents", mapArray(next.contents, (turn) => !turn?.parts ? turn : field(turn, "parts", mapArray(turn.parts, (part) => {
      if (part?.functionCall) return field(part, "functionCall", fn(part.functionCall));
      if (part?.functionResponse) return field(part, "functionResponse", fn(part.functionResponse));
      return part;
    }))));
  } else {
    next = field(next, "tools", mapArray(next.tools, (tool) => {
      if (!tool || typeof tool !== "object") return tool;
      if (format === FORMATS.OPENAI_RESPONSES && tool.type !== "function" && tool.type !== "custom") return tool;
      return tool.function ? field(tool, "function", fn(tool.function)) : fn(tool);
    }));
    if (format === FORMATS.OPENAI_RESPONSES) {
      next = field(next, "input", mapArray(next.input, (item) => item?.type === "function_call" || item?.type === "custom_tool_call" ? fn(item) : item));
    } else {
      next = field(next, "messages", mapArray(next.messages, (turn) => {
        if (!turn || typeof turn !== "object") return turn;
        if (format === FORMATS.CLAUDE) return field(turn, "content", mapArray(turn.content, contentPart));
        let mapped = turn.role === "tool" ? fn(turn) : turn;
        if (turn.role === "assistant") mapped = field(mapped, "tool_calls", mapArray(turn.tool_calls, chatCall));
        return mapped;
      }));
    }
  }
  return next;
}

const textOf = (block) => typeof block === "string" ? block : typeof block?.text === "string" ? block.text : null;
const withText = (block, text) => typeof block === "string" ? text : { ...block, text };

/** Preserve source blocks; split only the delimiter this adapter itself owns. */
export function prepareFactoryPromptBlocks(blocks, droidPrompt, { stripGreeting = true, ensurePrefix = true } = {}) {
  let prepared = blocks;
  const first = blocks.findIndex((block) => textOf(block)?.length > 0);
  if (first >= 0) {
    const text = textOf(blocks[first]);
    if (text.startsWith(`${droidPrompt}\n\n`)) {
      prepared = [...blocks.slice(0, first), withText(blocks[first], droidPrompt), withText(blocks[first], text.slice(droidPrompt.length + 2)), ...blocks.slice(first + 1)];
    }
  }
  let main = prepared.findIndex((block) => textOf(block)?.length > 0);
  if (main >= 0 && textOf(prepared[main]) === droidPrompt) {
    main = prepared.findIndex((block, index) => index > main && textOf(block)?.length > 0);
  }
  if (stripGreeting && main >= 0 && textOf(prepared[main]).startsWith(OMP_GREETING_PREAMBLE)) {
    const suffix = textOf(prepared[main]).slice(OMP_GREETING_PREAMBLE.length);
    prepared = [...prepared.slice(0, main), ...(suffix ? [withText(prepared[main], suffix)] : []), ...prepared.slice(main + 1)];
  }
  if (ensurePrefix && !prepared.some((block) => textOf(block) === droidPrompt)) prepared = [droidPrompt, ...prepared];
  return prepared;
}

function prepareSourcePrompt(body, format, droidPrompt) {
  if (![FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, FORMATS.CLAUDE, FORMATS.GEMINI].includes(format)) return body;
  const prepare = (blocks) => prepareFactoryPromptBlocks(blocks, droidPrompt, { ensurePrefix: false });
  const contentBlocks = (value) => Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const restoreContent = (original, blocks) => typeof original === "string" ? blocks.map(textOf).join("\n\n") : blocks;
  if (format === FORMATS.CLAUDE) {
    if (body.system === undefined) return body;
    const blocks = contentBlocks(body.system);
    const result = prepare(blocks);
    return result === blocks ? body : field(body, "system", restoreContent(body.system, result));
  }
  if (format === FORMATS.GEMINI) {
    const instruction = body.systemInstruction;
    if (typeof instruction === "string") {
      const blocks = [instruction];
      const result = prepare(blocks);
      return result === blocks ? body : field(body, "systemInstruction", restoreContent(instruction, result));
    }
    if (!Array.isArray(instruction?.parts)) return body;
    return field(body, "systemInstruction", field(instruction, "parts", prepare(instruction.parts)));
  }
  if (format === FORMATS.OPENAI_RESPONSES && typeof body.instructions === "string" && body.instructions.length > 0) {
    const blocks = [body.instructions];
    const result = prepare(blocks);
    return result === blocks ? body : field(body, "instructions", restoreContent(body.instructions, result));
  }
  const key = format === FORMATS.OPENAI_RESPONSES ? "input" : "messages";
  if (!Array.isArray(body[key])) return body;
  const positions = [];
  const blocks = [];
  for (let i = 0; i < body[key].length; i++) {
    const turn = body[key][i];
    if (turn?.role !== "system" && turn?.role !== "developer") break;
    for (const block of contentBlocks(turn.content)) {
      positions.push(i);
      blocks.push(block);
    }
  }
  // Prepare the selected main block in place so removing an exhausted block
  // cannot move later instructions into a different source message.
  let main = blocks.findIndex((block) => textOf(block)?.length > 0);
  if (main < 0) return body;
  if (textOf(blocks[main]) === droidPrompt) main = blocks.findIndex((block, index) => index > main && textOf(block)?.length > 0);
  if (main < 0) return body;
  const turnIndex = positions[main];
  const turn = body[key][turnIndex];
  const turnBlocks = contentBlocks(turn.content);
  const offset = positions.slice(0, main).filter((position) => position === turnIndex).length;
  const text = textOf(turnBlocks[offset]);
  const prepared = prepare([turnBlocks[offset]]);
  if (prepared.length === 1 && textOf(prepared[0]) === text) return body;
  const nextBlocks = [...turnBlocks.slice(0, offset), ...prepared, ...turnBlocks.slice(offset + 1)];
  const turns = [...body[key]];
  turns[turnIndex] = { ...turn, content: restoreContent(turn.content, nextBlocks) };
  return { ...body, [key]: turns };
}

/** Capture caller provenance before translators or tool deduplication lose it. */
export function captureFactoryCompatibility(sourceFormat, body, droidPrompt) {
  const effective = effectiveBody(sourceFormat, body);
  const format = nativeFormat(sourceFormat);
  const sourceToolNames = new Set();
  const sourceCustomToolNames = format === FORMATS.OPENAI_RESPONSES
    ? new Set((Array.isArray(effective.tools) ? effective.tools : []).filter((tool) => tool?.type === "custom" && typeof tool.name === "string").map((tool) => tool.name)) : null;
  walkNames(effective, format, (name) => { sourceToolNames.add(name); return name; });
  const rawChoice = format === FORMATS.GEMINI ? effective.toolConfig?.functionCallingConfig : effective.tool_choice;
  const context = { sourceFormat, sourceToolNames, sourceCustomToolNames, explicitToolChoice: rawChoice, toolChoicePresent: rawChoice !== undefined, promptPrepared: true };
  const prepared = prepareSourcePrompt(effective, format, droidPrompt);
  return { body: effective === body ? prepared : field(body, "request", prepared), context };
}

function resolveName(map, name) {
  const seen = new Set();
  while (map?.has(name)) {
    const next = map.get(name);
    if (next === name) break;
    if (seen.has(name)) throw new FactoryCompatibilityError("factory: cyclic tool name map");
    seen.add(name);
    name = next;
  }
  return name;
}

/** Compose only Factory maps; values are direct client names, never a rename chain. */
export function composeFactoryToolNameMaps(previous, factory) {
  const result = new Map();
  for (const [wire, name] of previous ?? []) result.set(wire, resolveName(previous, name));
  for (const [wire, target] of factory ?? []) {
    const client = resolveName(previous, target);
    if (result.has(wire) && result.get(wire) !== client) throw new FactoryCompatibilityError(`factory: tool name collision between ${result.get(wire)} and ${client}`);
    result.set(wire, client);
  }
  return result;
}

/** Alias structural names without changing schemas, arguments or opaque data. */
export function applyFactoryToolAliases(body, gateway, previousToolNameMap = null) {
  const context = body[FACTORY_COMPATIBILITY_CONTEXT];
  const names = new Set(context?.sourceToolNames ?? []);
  const targetNames = new Set();
  walkNames(body, nativeFormat(gateway), (name) => { targetNames.add(name); names.add(resolveName(previousToolNameMap, name)); return name; });
  const owners = new Map();
  const claim = (wire, owner) => {
    if (owners.has(wire) && owners.get(wire) !== owner) throw new FactoryCompatibilityError(`factory: tool name collision between ${owners.get(wire)} and ${owner}`);
    owners.set(wire, owner);
  };
  for (const name of names) claim(alias(name), name);
  const toolNameMap = new Map();
  const mapName = (name) => {
    const source = resolveName(previousToolNameMap, name);
    const wire = Object.hasOwn(FACTORY_TOOL_ALIASES, source) ? alias(source) : name;
    claim(wire, source);
    if (wire !== name) toolNameMap.set(wire, name);
    return wire;
  };
  for (const name of targetNames) mapName(name);
  return { body: walkNames(body, nativeFormat(gateway), mapName), toolNameMap };
}

function choiceMeaning(choice, format, allowNativeAdjuncts = false) {
  if (format === FORMATS.GEMINI) {
    if (!choice || typeof choice !== "object") return null;
    if (Object.keys(choice).some((key) => key !== "mode" && key !== "allowedFunctionNames")) return null;
    const names = choice.allowedFunctionNames ?? [];
    if (!Array.isArray(names)) return null;
    if (choice.mode === "ANY") return names.length === 0 ? { mode: "required" } : names.length === 1 ? { name: names[0] } : null;
    if (names.length > 0) return null;
    return ({ AUTO: { mode: "auto" }, NONE: { mode: "none" } })[choice.mode] ?? null;
  }
  if (typeof choice === "string") return ["auto", "none", "required"].includes(choice) ? { mode: choice } : null;
  if (!choice || typeof choice !== "object") return null;
  const allowed = format === FORMATS.CLAUDE ? ["type", "name"] : ["type", "name", "function"];
  if (!allowNativeAdjuncts && Object.keys(choice).some((key) => !allowed.includes(key))) return null;
  if (!allowNativeAdjuncts && choice.function && Object.keys(choice.function).some((key) => key !== "name")) return null;
  if (choice.type === "tool" || choice.type === "function") {
    const name = choice.function?.name ?? choice.name;
    return typeof name === "string" ? { name } : null;
  }
  return ["auto", "none", "required", "any"].includes(choice.type) ? { mode: choice.type === "any" ? "required" : choice.type } : null;
}

function aliasChoice(choice, format) {
  if (!choice || typeof choice !== "object") return choice;
  if (format === FORMATS.GEMINI) return choice.allowedFunctionNames ? field(choice, "allowedFunctionNames", mapArray(choice.allowedFunctionNames, alias)) : choice;
  if (choice.function) return field(choice, "function", named(choice.function, alias));
  return ["tool", "function", "custom"].includes(choice.type) ? named(choice, alias) : choice;
}

/** Emit caller intent after Droid defaults; never relax an unrepresentable restriction. */
export function applyExplicitFactoryToolChoice(body, gateway, context) {
  if (!context?.toolChoicePresent) return body;
  const source = nativeFormat(context.sourceFormat);
  const target = nativeFormat(gateway);
  const raw = context.explicitToolChoice;
  let choice;
  if (source === target && raw && typeof raw === "object") {
    // Ancillary native restrictions stay upstream-owned, including VALIDATED.
    choice = aliasChoice(raw, target);
    const meaning = choiceMeaning(raw, source, true);
    if (meaning && source !== FORMATS.GEMINI) {
      if (meaning.name !== undefined) {
        choice = target === FORMATS.OPENAI ? { ...raw, type: "function", function: { ...raw.function, name: alias(meaning.name) } }
          : { ...raw, type: target === FORMATS.CLAUDE ? "tool" : "function", name: alias(meaning.name) };
        if (target === FORMATS.OPENAI) delete choice.name;
        else delete choice.function;
      } else choice = target === FORMATS.CLAUDE
        ? { ...raw, type: meaning.mode === "required" ? "any" : meaning.mode }
        : Object.keys(raw).some((key) => key !== "type") ? { ...raw, type: meaning.mode } : meaning.mode;
    }
  } else {
    const meaning = choiceMeaning(raw, source);
    if (!meaning) {
      if (source !== target) throw new FactoryCompatibilityError(`factory: cannot preserve explicit tool choice for ${context.sourceFormat} -> ${gateway}`);
      choice = raw;
    } else if (target === FORMATS.GEMINI) {
      choice = meaning.name !== undefined ? { mode: "ANY", allowedFunctionNames: [alias(meaning.name)] } : { mode: ({ auto: "AUTO", none: "NONE", required: "ANY" })[meaning.mode] };
    } else if (meaning.name !== undefined) {
      const name = alias(meaning.name);
      choice = target === FORMATS.OPENAI ? { type: "function", function: { name } } : { type: target === FORMATS.CLAUDE ? "tool" : "function", name };
    } else choice = target === FORMATS.CLAUDE ? { type: meaning.mode === "required" ? "any" : meaning.mode } : meaning.mode;
  }
  if (target === FORMATS.GEMINI) {
    const next = { ...body, toolConfig: { ...body.toolConfig, functionCallingConfig: choice } };
    delete next.tool_choice;
    return next;
  }
  return { ...body, tool_choice: choice };
}

/** Undo the Responses bridge's edge trimming only when the source text matches. */
export function preserveFactoryResponsesPrompt(sourceFormat, sourceBody, translatedBody) {
  const source = effectiveBody(sourceFormat, sourceBody);
  const format = nativeFormat(sourceFormat);
  const text = (value, delimiter) => typeof value === "string" ? value
    : Array.isArray(value) ? value.map(textOf).filter((part) => part !== null && part !== "").join(delimiter) : "";
  let groups;
  if (format === FORMATS.OPENAI) {
    groups = (source.messages ?? []).filter((turn) => turn?.role === "system" || turn?.role === "developer").map((turn) => text(turn.content, "\n"));
  } else if (format === FORMATS.CLAUDE) groups = [text(source.system, "\n")];
  else if (format === FORMATS.GEMINI) groups = [text(typeof source.systemInstruction === "string" ? source.systemInstruction : source.systemInstruction?.parts, "")];
  else return translatedBody;
  const normalized = groups.map((group) => group.trim()).filter(Boolean).join("\n\n");
  if (translatedBody.instructions !== normalized) return translatedBody;
  return field(translatedBody, "instructions", groups.filter(Boolean).join("\n\n"));
}
