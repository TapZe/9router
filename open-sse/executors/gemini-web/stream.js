// Gemini Web response decoder: XSSI guard, length records, cumulative frames.
//
// Ported from gemini-web-to-api (MIT). See LICENSE in this directory.
// Copyright (c) 2025 Nguyễn Tuấn Thành

import {
  GEMINI_WEB_LIMITS,
  abortError,
  upstreamError,
} from "./config.js";
import { isAllowedGeminiMediaUrl } from "./media.js";

const XSSI_GUARD = ")]}'";

const CITATION_MARKER = /\[cite:[ \t]*\d+(?:[ \t]*,[ \t]*\d+)*\]/g;
const CITE_START_MARKER = /\[cite_start\]/g;
const CODE_FENCE_ARTIFACT =
  /^([ \t]*```[^\s?]*)\?(?:code_reference|code_stdout)(?:&[A-Za-z0-9_.=&%~-]*)?[ \t\r]*$/;
const CLOSING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "…", "。", "、", "，", "．", "；", "：", "！", "？"]);
const CLOSING_BRACKETS = new Set([")", "]", "}", "」", "”", "»"]);
const CLOSING_DELIMITERS = new Set(["*", "_", "~", "`", '"', "'"]);

function closesPhrase(rest) {
  if (rest === "") return true;
  const first = rest[0];
  if (first === " " || first === "\n" || first === "\t" || first === "\r") return true;
  if (CLOSING_PUNCTUATION.has(first) || CLOSING_BRACKETS.has(first)) return true;
  if (CLOSING_DELIMITERS.has(first)) return closesPhrase(rest.replace(new RegExp(`^\\${first}+`), ""));
  return false;
}

function removeInlineMarkers(text, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags);
  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) return text;
  let out = "";
  let last = 0;
  for (const match of matches) {
    let start = match.index;
    const end = start + match[0].length;
    if (start > last && text[start - 1] === " " && closesPhrase(text.slice(end))) start -= 1;
    out += text.slice(last, start);
    last = end;
  }
  return out + text.slice(last);
}

/** Remove the citation markers and code-event fence suffixes Gemini injects. */
export function stripCitationArtifacts(text) {
  if (!text) return text;
  let out = text;
  if (out.includes("[cite")) {
    out = removeInlineMarkers(out, CITATION_MARKER);
    out = removeInlineMarkers(out, CITE_START_MARKER);
  }
  if (!out.includes("?code_")) return out;
  const lines = out.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = CODE_FENCE_ARTIFACT.exec(line);
    if (!match) continue;
    lines[index] = line.endsWith("\r") ? `${match[1]}\r` : match[1];
  }
  return lines.join("\n");
}

/**
 * Split the legacy `<ctrl94>thought ... <ctrl95>` trace. A marker that never
 * closes is not extracted: an unfinished block must stay ordinary text so a
 * streamed prefix is never retracted.
 */
function extractThinkingMarkers(raw) {
  const starts = ["<ctrl94>thought", "<ctrl94>"];
  let startIndex = -1;
  let startLength = 0;
  for (const marker of starts) {
    const index = raw.indexOf(marker);
    if (index !== -1) {
      startIndex = index;
      startLength = marker.length;
      break;
    }
  }
  if (startIndex === -1) return { text: raw, reasoning: "" };
  const endIndex = raw.indexOf("<ctrl95>", startIndex + startLength);
  if (endIndex === -1) return { text: raw, reasoning: "" };
  const reasoning = raw.slice(startIndex + startLength, endIndex).trim();
  const text = `${raw.slice(0, startIndex)}${raw.slice(endIndex + "<ctrl95>".length)}`.trim();
  return { text, reasoning };
}

function cleanAnswerText(raw) {
  const { text: withoutMarkers, reasoning } = extractThinkingMarkers(raw);
  return { text: stripCitationArtifacts(withoutMarkers), reasoning };
}

function extractText(payload) {
  if (!Array.isArray(payload)) return "";
  if (payload.length > 2 && payload.length < 5 && payload[2] && typeof payload[2] === "object") {
    const parts = payload[2]["7"];
    if (Array.isArray(parts) && typeof parts[0] === "string" && parts[0] !== "") {
      return parts[0];
    }
  }
  if (payload.length > 4 && Array.isArray(payload[4]) && payload[4].length > 0) {
    const candidate = payload[4][0];
    if (
      Array.isArray(candidate) &&
      Array.isArray(candidate[1]) &&
      typeof candidate[1][0] === "string"
    ) {
      return candidate[1][0];
    }
  }
  return "";
}

/** Thinking status label at payload[2]["7"][5][0], with an empty reply slot. */
function extractReasoningLabel(payload) {
  if (!Array.isArray(payload) || payload.length < 3) return "";
  const fields = payload[2];
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return "";
  const parts = fields["7"];
  if (!Array.isArray(parts) || parts.length < 6) return "";
  if (typeof parts[0] === "string" && parts[0] !== "") return "";
  const labels = parts[5];
  if (!Array.isArray(labels) || labels.length === 0) return "";
  return typeof labels[0] === "string" ? labels[0].trim() : "";
}

function findUsageMetadata(value) {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findUsageMetadata(child);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    if (value.usageMetadata && typeof value.usageMetadata === "object") {
      return value.usageMetadata;
    }
    for (const child of Object.values(value)) {
      const found = findUsageMetadata(child);
      if (found) return found;
    }
  }
  return null;
}

function usageNumber(metadata, key) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Generated images live only in the dedicated media slot at
 * candidate[12][7][0][i][0][3]; URL-shaped strings in the answer are never
 * treated as generated media.
 */
function extractGeneratedImages(payload) {
  if (!Array.isArray(payload) || payload.length <= 4) return [];
  const candidate = payload[4]?.[0];
  if (!Array.isArray(candidate) || candidate.length <= 12) return [];
  const media = candidate[12];
  if (!Array.isArray(media) || media.length <= 7) return [];
  const groups = media[7];
  if (!Array.isArray(groups) || groups.length === 0) return [];
  const generated = groups[0];
  if (!Array.isArray(generated)) return [];

  const images = [];
  for (const raw of generated) {
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const wrapper = raw[0];
    if (!Array.isArray(wrapper) || wrapper.length <= 3) continue;
    const metadata = wrapper[3];
    if (!Array.isArray(metadata) || metadata.length <= 3) continue;
    const url = metadata[3];
    if (typeof url !== "string" || !isAllowedGeminiMediaUrl(url)) continue;

    let mime = "image/png";
    for (const field of metadata) {
      if (typeof field === "string" && field.startsWith("image/")) mime = field;
    }
    let width;
    let height;
    for (const field of metadata) {
      if (!Array.isArray(field) || field.length < 2) continue;
      if (typeof field[0] === "number") width = field[0];
      if (typeof field[1] === "number") height = field[1];
    }
    const image = { url, mime };
    if (width !== undefined) image.width = width;
    if (height !== undefined) image.height = height;
    images.push(image);
  }
  return images;
}

function collectBardError(item) {
  for (const element of item) {
    const codes = [];
    const walk = (value) => {
      if (Array.isArray(value)) {
        let hit = false;
        for (const child of value) hit = walk(child) || hit;
        return hit;
      }
      if (typeof value === "string") return value.includes("BardErrorInfo");
      if (typeof value === "number") {
        codes.push(value);
        return false;
      }
      return false;
    };
    if (walk(element)) return codes;
  }
  return null;
}

function collectKnownModelIds(value, known, found) {
  if (typeof value === "string") {
    if (known.has(value)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectKnownModelIds(item, known, found);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectKnownModelIds(item, known, found);
  }
}

/**
 * Model identity is routing evidence only when it comes from protocol metadata
 * (the record envelope or a dedicated metadata slot), never from answer text.
 */
function collectModelEvidence(item, payload, known) {
  const found = new Set();
  collectKnownModelIds(item[3], known, found);
  collectKnownModelIds(payload?.[3], known, found);
  return found;
}

function parseFrame(value, context) {
  const events = [];
  const items = Array.isArray(value) ? value : [];

  for (const item of items) {
    if (!Array.isArray(item)) continue;

    const errorCodes = collectBardError(item);
    if (errorCodes !== null) {
      const suffix = errorCodes.length > 0 ? `code ${errorCodes.join(", ")}` : "block";
      throw upstreamError(`Google Gemini Web returned an error (BardErrorInfo ${suffix}).`);
    }

    const payloadRaw = item[2];
    let payload = null;
    if (typeof payloadRaw === "string") {
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        continue;
      }
    }

    if (payload && context.known.size > 0) {
      const evidence = collectModelEvidence(item, payload, context.known);
      if (evidence.size > 0) {
        const next = evidence.size === 1 ? [...evidence][0] : null;
        if (next !== context.lastModel) {
          context.lastModel = next;
          events.push({ type: "model", modelId: next });
        }
      }
    }

    if (!Array.isArray(payload)) continue;

    const label = extractReasoningLabel(payload);
    if (label) {
      const labels = context.labels;
      if (labels.length === 0 || labels[labels.length - 1] !== label) {
        labels.push(label);
        events.push({ type: "reasoning", text: labels.join("\n") });
      }
    }

    const usage = findUsageMetadata(payload);
    if (usage) {
      const normalized = {
        promptTokens: usageNumber(usage, "promptTokenCount"),
        completionTokens: usageNumber(usage, "candidatesTokenCount"),
        totalTokens: usageNumber(usage, "totalTokenCount"),
      };
      const serialized = JSON.stringify(normalized);
      if (serialized !== context.lastUsage) {
        context.lastUsage = serialized;
        events.push({ type: "usage", usage: normalized });
      }
    }

    for (const image of extractGeneratedImages(payload)) {
      if (context.seenImages.has(image.url)) continue;
      context.seenImages.add(image.url);
      context.imageCount += 1;
      events.push({ type: "images", images: [image] });
    }

    const rawText = extractText(payload);
    if (!rawText || rawText === context.lastRawText) continue;

    if (context.lastRawText !== null) {
      if (!rawText.startsWith(context.lastRawText)) {
        // A strictly shorter prefix is a repeated frame, not a revision.
        if (context.lastRawText.startsWith(rawText)) continue;
        throw upstreamError(
          "Gemini Web streamed a divergent revision of the answer; refusing to emit corrupted output"
        );
      }
    }
    context.lastRawText = rawText;

    const cleaned = cleanAnswerText(rawText);
    if (!label && context.labels.length === 0 && cleaned.reasoning) {
      if (cleaned.reasoning !== context.markerReasoning) {
        context.markerReasoning = cleaned.reasoning;
        events.push({ type: "reasoning", text: cleaned.reasoning });
      }
    }
    if (cleaned.text && cleaned.text !== context.lastCleanText) {
      context.lastCleanText = cleaned.text;
      context.hasAnswer = true;
      events.push({ type: "text", text: cleaned.text });
    }
  }

  return events;
}

export function isJsonWhitespace(char) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

/** Return the exclusive end of one balanced JSON value, or -1 when incomplete. */
export function scanJsonValue(text, start) {
  const first = text[start];
  if (first === '"') {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') return index + 1;
      index += 1;
    }
    return -1;
  }
  if (first === "[" || first === "{") {
    let depth = 0;
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index = scanJsonValue(text, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return -1;
  }
  let index = start;
  while (index < text.length && !isJsonWhitespace(text[index]) && text[index] !== "," && text[index] !== "]" && text[index] !== "}") {
    index += 1;
  }
  return index > start ? index : -1;
}

/**
 * Decode cumulative Gemini Web frames into provider-neutral events.
 *
 * Frames arrive XSSI-guarded with standalone numeric length records, may be
 * split at any UTF-8 boundary, and each accepted revision replaces the prior
 * cumulative answer. A shorter prefix is ignored; a divergent revision is an
 * error rather than silently duplicated or corrupted output.
 */
export async function* decodeGeminiWebStream(body, { signal, knownModelIds } = {}) {
  if (signal?.aborted) throw abortError(signal.reason);

  let reader = null;
  let iterator = null;
  if (body && typeof body.getReader === "function") {
    reader = body.getReader();
  } else if (body && typeof body[Symbol.asyncIterator] === "function") {
    iterator = body[Symbol.asyncIterator]();
  } else {
    throw upstreamError("Gemini Web decoder requires a readable response body");
  }

  const onAbort = () => {
    try {
      reader?.cancel().catch?.(() => {});
    } catch {
      // Cancellation is best-effort; the abort error below is authoritative.
    }
  };
  signal?.addEventListener?.("abort", onAbort, { once: true });

  const context = {
    known: knownModelIds instanceof Set ? knownModelIds : new Set(),
    labels: [],
    lastModel: null,
    lastUsage: null,
    lastRawText: null,
    lastCleanText: "",
    markerReasoning: "",
    seenImages: new Set(),
    imageCount: 0,
    hasAnswer: false,
  };

  const decoder = new TextDecoder();
  let buffer = "";
  let guardHandled = false;

  const drain = (final) => {
    const events = [];
    for (;;) {
      let index = 0;
      while (index < buffer.length && isJsonWhitespace(buffer[index])) index += 1;
      if (index >= buffer.length) {
        buffer = "";
        return events;
      }
      const start = index;
      const end = scanJsonValue(buffer, start);
      if (end < 0) {
        if (final) {
          throw upstreamError("Gemini Web response ended inside a frame");
        }
        if (buffer.length - start > GEMINI_WEB_LIMITS.maxFrameBytes) {
          throw upstreamError("Gemini Web frame exceeds the allowed size");
        }
        buffer = buffer.slice(start);
        return events;
      }
      const frame = buffer.slice(start, end);
      buffer = buffer.slice(end);
      if (frame.length > GEMINI_WEB_LIMITS.maxFrameBytes) {
        throw upstreamError("Gemini Web frame exceeds the allowed size");
      }
      if (/^-?\d+$/.test(frame)) continue;
      let value;
      try {
        value = JSON.parse(frame);
      } catch {
        throw upstreamError("Gemini Web response contains an invalid frame");
      }
      events.push(...parseFrame(value, context));
    }
  };

  const handleGuard = () => {
    if (guardHandled) return false;
    const trimmed = buffer.replace(/^\s+/, "");
    if (trimmed.length === 0) return true;
    if (trimmed.startsWith(XSSI_GUARD)) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) return true;
      buffer = buffer.slice(newline + 1);
      guardHandled = true;
      return false;
    }
    if (XSSI_GUARD.startsWith(trimmed)) return true;
    guardHandled = true;
    return false;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason);
      let result;
      if (reader) {
        result = await reader.read();
      } else {
        result = await iterator.next();
      }
      if (result.done) break;
      const chunk = reader ? result.value : result.value;
      if (!chunk) continue;
      buffer += decoder.decode(chunk, { stream: true });
      if (handleGuard()) continue;
      for (const event of drain(false)) yield event;
    }

    if (signal?.aborted) throw abortError(signal.reason);
    buffer += decoder.decode();
    if (handleGuard()) {
      if (buffer.trim()) throw upstreamError("Gemini Web response ended inside a frame");
    } else {
      for (const event of drain(true)) yield event;
    }

    if (!context.hasAnswer && context.imageCount === 0) {
      throw upstreamError("Gemini Web response completed without an answer");
    }
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    try {
      await reader?.cancel();
    } catch {
      // The reader may already be closed.
    }
    try {
      reader?.releaseLock?.();
    } catch {
      // Pending reads release the lock on cancel.
    }
    try {
      await iterator?.return?.();
    } catch {
      // Async iterables may not implement return().
    }
  }
}
