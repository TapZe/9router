// JSON text helpers shared by the Gemini Web reply parsers (tool bridge and
// response_format). Gemini writes JSON inside prose or code fences and often
// leaves raw newlines inside strings, so replies are scanned, not parsed whole.
//
// Ported from gemini-web-to-api (internal/commons/utils). MIT.

/** Trimmed text, or "" for anything that is not a string. */
export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A plain JSON object: not null and not an array. */
export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Scan state for JSON string literals: inside a string, and after a backslash. */
function stepString(state, ch) {
  if (state.escaped) state.escaped = false;
  else if (ch === "\\") state.escaped = true;
  else if (ch === '"') state.inString = false;
}

/** The balanced `{...}` that starts at `start`, or "" when it never closes. */
export function balancedObjectAt(value, start) {
  const state = { inString: false, escaped: false };
  let depth = 0;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (state.inString) stepString(state, ch);
    else if (ch === '"') state.inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return value.slice(start, i + 1);
  }
  return "";
}

/** A \uXXXX escape parses to the same character as \n, \r or \t would. */
function escapeControl(ch) {
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/** Escape raw control characters inside JSON string literals. */
export function escapeStringControlChars(value) {
  const state = { inString: false, escaped: false };
  let out = "";
  for (const ch of value) {
    if (!state.inString) {
      if (ch === '"') state.inString = true;
      out += ch;
    } else if (!state.escaped && ch < " ") {
      out += escapeControl(ch);
    } else {
      stepString(state, ch);
      out += ch;
    }
  }
  return out;
}

export function parseLenientJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(escapeStringControlChars(value));
    } catch {
      return undefined;
    }
  }
}
