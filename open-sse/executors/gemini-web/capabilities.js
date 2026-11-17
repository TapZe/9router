// Request-contract guards for the Gemini Web executor.
//
// Gemini Web is not a generic OpenAI upstream: it drives one native
// StreamGenerate call per turn. Some client controls have no wire
// representation there, so they are rejected before any upstream request
// instead of being silently dropped:
//
//   • legacy `functions` — OpenAI function tools in `tools` go through the
//     prompt tool bridge (toolBridge.js), which validates them where the
//     executor reads them. This guard also runs on the client's own body
//     before translation, so it must not judge `tools` by OpenAI shape.
//   • thinking control — Google exposes exactly low/medium/high, and its
//     thought summaries are not a caller-controlled token budget.

import { extractThinking, parseSuffix } from "../../translator/concerns/thinkingUnified.js";

/** `error.code` on every compatibility rejection raised here. */
export const GEMINI_WEB_UNSUPPORTED_CONTROL_CODE = "unsupported_control_for_provider";

/** Effort levels Gemini Web can encode on the wire. */
const SUPPORTED_LEVELS = new Set(["low", "medium", "high"]);

/** Level names that mean "let Gemini choose", resolved to the low enum. */
const AUTOMATIC_LEVELS = new Set(["", "auto", "default", "automatic"]);

function normalizeString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function nonEmptyList(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const THINKING_DISABLED_MESSAGE =
  'Model provider "gemini-web" cannot disable thinking. Gemini Web always returns Google\'s ' +
  'thought summary, so "none"/"off"/disabled thinking cannot be honored. Use "low", "medium" or "high".';

const THINKING_BUDGET_MESSAGE =
  'Model provider "gemini-web" cannot honor a token budget. Gemini Web exposes only low, medium ' +
  "and high effort; remove the budget or select one of those levels.";

function unsupportedLevelMessage(level) {
  return (
    `Model provider "gemini-web" does not support thinking level "${level}". ` +
    'Use "low", "medium" or "high".'
  );
}

/**
 * The thinking intent carried by the model suffix wins over the body, mirroring
 * the rest of the translator pipeline. Both are rejected before normalization.
 */
function thinkingViolation(body, model) {
  const { override } = parseSuffix(typeof model === "string" ? model : null);
  if (override) {
    if (override.mode === "none") return { param: "model", message: THINKING_DISABLED_MESSAGE };
    if (override.mode === "budget") {
      return {
        param: "model",
        message: `Model provider "gemini-web" cannot honor the token budget in the model suffix. ${THINKING_BUDGET_MESSAGE}`,
      };
    }
    if (override.mode === "level" && !SUPPORTED_LEVELS.has(override.level)) {
      return { param: "model", message: unsupportedLevelMessage(override.level) };
    }
  }

  const intent = extractThinking(body);
  if (!intent) return null;
  if (intent.mode === "none") return { param: "reasoning_effort", message: THINKING_DISABLED_MESSAGE };
  if (intent.mode === "budget") return { param: "thinking", message: THINKING_BUDGET_MESSAGE };
  if (intent.mode === "level") {
    const level = normalizeString(intent.level);
    if (level === null) return null;
    if (AUTOMATIC_LEVELS.has(level) || SUPPORTED_LEVELS.has(level)) return null;
    return { param: "reasoning_effort", message: unsupportedLevelMessage(level) };
  }
  // mode "auto" means the caller left depth to the provider.
  return null;
}

/**
 * Inspect an OpenAI-shaped request body (plus the requested model suffix) for
 * controls Gemini Web cannot honor. Returns the first violation found, or
 * `null` when the request is servable.
 */
export function checkGeminiWebUnsupportedControls(body, model = null) {
  if (!body || typeof body !== "object") return null;

  if (nonEmptyList(body.functions)) {
    return {
      param: "functions",
      message:
        'Model provider "gemini-web" does not support the legacy "functions" field. Send the same ' +
        'definitions as "tools" ({"type":"function","function":{...}}) instead.',
    };
  }

  return thinkingViolation(body, model);
}
