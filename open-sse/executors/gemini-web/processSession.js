// Argon / policy-code generate uses Gemini Web ProcessSession (BrowserChannel
// Bind), not StreamGenerate. Field numbers are pinned from a live Argon capture
// (req0 envelope + req1 prompt) plus BardChatUi's jspb mapping (proto field N
// is JSON array index N-1).

import { createHash } from "node:crypto";

import {
  GEMINI_WEB_DEFAULT_LANGUAGE,
  GEMINI_WEB_ENDPOINTS,
  GEMINI_WEB_ORIGIN,
  abortError,
  normalizeAuthUser,
  upstreamError,
} from "./config.js";
import { isJsonWhitespace, scanJsonValue } from "./stream.js";

const TEXT_ENC = new TextEncoder();
const XSSI_GUARD = ")]}'\n";

export const GEMINI_WEB_PROCESS_SESSION_PATH = "/v1/processSession";

function concatBytes(parts) {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeVarint(value) {
  const bytes = [];
  let rest = Number(value) >>> 0;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest & 0x7f);
  return Uint8Array.from(bytes);
}

function encodeVarintField(field, value) {
  return concatBytes([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function encodeLenField(field, payload) {
  const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  return concatBytes([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function encodeStringField(field, value) {
  return encodeLenField(field, TEXT_ENC.encode(String(value)));
}

function encodeEmptyBytesField(field) {
  return encodeLenField(field, new Uint8Array(0));
}

export function encodeProcessSessionReq1(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const inner = concatBytes([encodeVarintField(1, 1), encodeLenField(9, encodeStringField(1, text))]);
  return encodeLenField(2, inner);
}

function encodeLanguage(language) {
  return encodeLenField(2, encodeStringField(1, language));
}

function encodeEmptyPromptSlot() {
  return encodeLenField(
    1,
    concatBytes([encodeEmptyBytesField(1), encodeVarintField(2, 0), encodeVarintField(7, 0)])
  );
}

function encodePackedInt(field, value) {
  return encodeLenField(field, encodeVarint(value));
}

function encodeInner({
  language,
  requestId,
  modelNumber,
  thinkingLevel,
  botguardToken,
  botguardHash,
}) {
  const parts = [
    encodeEmptyPromptSlot(),
    encodeLanguage(language),
  ];
  if (botguardToken) parts.push(encodeStringField(4, botguardToken));
  if (botguardHash) parts.push(encodeStringField(5, botguardHash));
  parts.push(
    encodeLenField(7, encodeVarintField(1, 1)),
    encodeVarintField(8, 1),
    encodeVarintField(11, 1),
    encodeVarintField(12, 0),
    encodeLenField(18, encodeLenField(1, encodeVarintField(1, 1))),
    encodeVarintField(19, 0),
    encodeVarintField(28, 1),
    encodePackedInt(31, 4),
    encodeLenField(42, encodeVarintField(1, 1)),
    encodeVarintField(50, 0),
    encodeVarintField(54, 0),
    encodeStringField(60, requestId),
    encodeEmptyBytesField(62),
    encodeVarintField(68, 0),
    encodeVarintField(69, 2),
    encodeVarintField(80, modelNumber),
    encodeVarintField(81, thinkingLevel),
    encodeVarintField(92, 1),
    encodeVarintField(97, 0),
    encodeVarintField(99, 1)
  );
  return concatBytes(parts);
}

export function encodeProcessSessionReq0({
  modelId,
  language = GEMINI_WEB_DEFAULT_LANGUAGE,
  generationId,
  requestId,
  modelNumber,
  thinkingLevel,
  botguardToken,
  botguardHash,
} = {}) {
  const header = concatBytes([
    encodeVarintField(1, 1),
    encodeStringField(2, modelId),
    encodeStringField(3, language),
    encodeStringField(4, generationId),
  ]);
  const inner = encodeInner({
    language,
    requestId: requestId || generationId,
    modelNumber,
    thinkingLevel,
    botguardToken,
    botguardHash,
  });
  const payload = concatBytes([
    encodeLenField(1, inner),
    encodeVarintField(4, 1),
  ]);
  const body = concatBytes([
    encodeLenField(1, header),
    encodeVarintField(2, 0),
    encodeLenField(8, encodeLenField(5, payload)),
  ]);
  return encodeLenField(1, body);
}

export function protoToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function parseCookieMap(header) {
  const map = new Map();
  if (!header || typeof header !== "string") return map;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

export function buildSapiSidHash(cookieHeader, origin = GEMINI_WEB_ORIGIN, nowSec = Math.floor(Date.now() / 1000)) {
  const cookies = parseCookieMap(cookieHeader);
  const sapisid =
    cookies.get("SAPISID") ||
    cookies.get("__Secure-1PSAPISID") ||
    cookies.get("__Secure-3PAPISID") ||
    cookies.get("APISID");
  if (!sapisid) return null;
  const digest = createHash("sha1").update(`${nowSec} ${sapisid} ${origin}`).digest("hex");
  return `SAPISIDHASH ${nowSec}_${digest}`;
}

export function randomBindRid() {
  return Math.floor(Math.random() * 90000) + 10000;
}

export function processSessionUrl({
  authUser,
  rid,
  sid,
  gsessionid,
  cookieHeader,
  mode = "open",
}) {
  const slot = normalizeAuthUser(authUser);
  const query = new URLSearchParams({
    VER: "8",
    CVER: "22",
    RID: String(rid),
  });
  if (slot !== "") query.set("authuser", slot);
  if (mode === "open") {
    query.set("X-HTTP-Session-Id", "gsessionid");
    const auth = buildSapiSidHash(cookieHeader);
    if (auth) query.set("$httpHeaders", `Authorization:${auth}`);
  } else {
    if (gsessionid) query.set("gsessionid", gsessionid);
    if (sid) query.set("SID", sid);
    query.set("AID", "0");
  }
  if (mode === "rpc") {
    query.set("TYPE", "xmlhttp");
    query.set("CI", "0");
    query.set("t", "1");
  }
  return `${GEMINI_WEB_ENDPOINTS.processSession}?${query.toString()}`;
}

function stripXssi(text) {
  const trimmed = String(text || "").replace(/^\s+/, "");
  if (trimmed.startsWith(")]}'")) {
    const newline = trimmed.indexOf("\n");
    return newline === -1 ? "" : trimmed.slice(newline + 1);
  }
  return trimmed;
}

export function parseBrowserChannelOpen(bodyText) {
  const text = stripXssi(bodyText).trim();
  if (!text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const match = text.match(/\["c","([^"]+)"/);
    if (!match) return null;
    return { sid: match[1] };
  }
  const walk = (node) => {
    if (!Array.isArray(node)) return null;
    if (node[0] === "c" && typeof node[1] === "string") {
      return { sid: node[1] };
    }
    for (const child of node) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(value);
}

function looksLikeStreamGenerate(text) {
  const body = String(text || "");
  return body.includes("wrb.fr") || body.includes(")]}'");
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buf.length) {
    const byte = buf[index++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
    if (shift > 35) break;
  }
  return { value, next: buf.length, error: true };
}

/**
 * Decode one protobuf message into `[field, wire, value]` tuples. Length
 * fields keep their bytes; a malformed tail stops decoding instead of
 * guessing. Bind frames carry protobuf wrapped in base64 inside a JSON array.
 */
function readProtoFields(buf) {
  const found = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (tag.error) break;
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const value = readVarint(buf, offset);
      if (value.error) break;
      offset = value.next;
      found.push([field, wire, value.value]);
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      if (len.error) break;
      offset = len.next;
      const end = offset + len.value;
      if (end > buf.length) break;
      found.push([field, wire, buf.subarray(offset, end)]);
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) break;
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) break;
      offset += 8;
    } else {
      break;
    }
  }
  return found;
}

function protoAll(fields, no) {
  return fields.filter(([field]) => field === no).map(([, , value]) => value);
}

function protoBytes(fields, no) {
  const value = protoAll(fields, no)[0];
  return value instanceof Uint8Array ? value : null;
}

function protoNumber(fields, no) {
  const value = protoAll(fields, no)[0];
  return typeof value === "number" ? value : null;
}

function protoText(fields, no) {
  const bytes = protoBytes(fields, no);
  return bytes ? Buffer.from(bytes).toString("utf8") : "";
}

/**
 * Read the turn and candidate slots verified from a captured Argon Bind
 * response:
 *   payload.2 -> envelope.7 -> turn { 1: turn complete,
 *     4 -> { 4: candidate { 11: progress label, 15: candidate complete,
 *          27 -> 1 -> 2 -> 3: answer text } } }
 * Captured partial turns carry turn.1 = 0 and candidate.15 = 0; the completed
 * turn carries 1 in both. Records after completion carry field 11 labels and
 * no turn.
 */
function readBindMessage(bytes) {
  const result = { present: false, final: false, labels: [], text: "" };
  for (const envelopeBytes of protoAll(readProtoFields(bytes), 2)) {
    for (const listBytes of protoAll(readProtoFields(envelopeBytes), 7)) {
      for (const turnBytes of protoAll(readProtoFields(listBytes), 1)) {
        const turn = readProtoFields(turnBytes);
        // Only a parsed turn marks the record as a turn payload; a heartbeat
        // or session-metadata record is not evidence of a generation.
        result.present = true;
        const turnFinal = protoNumber(turn, 1) === 1;
        for (const holderBytes of protoAll(turn, 4)) {
          for (const candidateBytes of protoAll(readProtoFields(holderBytes), 4)) {
            const candidate = readProtoFields(candidateBytes);
            const candidateFinal = protoNumber(candidate, 15) === 1;
            const label = protoText(candidate, 11).trim();
            if (label && !result.labels.includes(label)) result.labels.push(label);
            const block = protoBytes(candidate, 27);
            if (!block) continue;
            const level1 = protoBytes(readProtoFields(block), 1);
            const level2 = level1 ? protoBytes(readProtoFields(level1), 2) : null;
            if (!level2) continue;
            const answer = protoText(readProtoFields(level2), 3);
            if (!answer) continue;
            result.text = answer;
            // Completion needs the turn flag, the candidate flag and answer
            // text. Any one of them alone keeps the read open.
            if (turnFinal && candidateFinal) result.final = true;
          }
        }
      }
    }
  }
  return result;
}


/**
 * Split accumulated Bind text into complete JSON values. Numeric length
 * records and the XSSI guard are wire framing, not values; an unbalanced tail
 * is reported so a caller never treats a partial frame as complete.
 */
function scanBindFrames(buffer) {
  const frames = [];
  const text = String(buffer || "");
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isJsonWhitespace(text[index])) index += 1;
    if (index >= text.length) break;
    if (text.startsWith(")]}'", index)) {
      index += 4;
      if (text[index] === "\n") index += 1;
      continue;
    }
    const end = scanJsonValue(text, index);
    if (end < 0) return { frames, pending: text.slice(index) };
    const raw = text.slice(index, end);
    index = end;
    if (/^-?\d+$/.test(raw)) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    frames.push(value);
  }
  return { frames, pending: "" };
}

function frameCarriesWrb(value) {
  return Array.isArray(value) && value.some((item) => Array.isArray(item) && item[0] === "wrb.fr");
}

/**
 * Separate the parsed Bind source from the output this provider synthesizes.
 * A hex-shaped record is the response form the decoder owns, so it passes
 * through verbatim. A Bind record is base64 protobuf and contributes only its
 * verified turn/candidate slots: answer text and progress labels are never
 * inferred from other strings in the payload.
 *
 * `final` is the single completion decision for typed records: it requires the
 * turn flag and the candidate flag captured together on the completed turn.
 * `typed` records that any protobuf record was seen at all, so a reader can
 * tell an incomplete turn from an empty heartbeat.
 */
function extractBindProgress(buffer) {
  const { frames, pending } = scanBindFrames(buffer);
  const labels = [];
  let answer = "";
  let final = false;
  let typed = false;
  let rawFrames = 0;

  for (const value of frames) {
    if (frameCarriesWrb(value)) {
      rawFrames += 1;
      continue;
    }
    for (const entry of Array.isArray(value) ? value : []) {
      if (!Array.isArray(entry) || !Array.isArray(entry[1])) continue;
      const encoded = entry[1][0];
      if (typeof encoded !== "string" || !encoded) continue;
      const message = readBindMessage(Buffer.from(encoded, "base64"));
      if (message.present) typed = true;
      // The first completed turn owns the answer and completion. Labels and
      // text after it are post-answer chrome (labels) or a different turn's
      // text, and neither may replace what was already delivered.
      if (!final) {
        for (const label of message.labels) {
          if (!labels.includes(label)) labels.push(label);
        }
        if (message.text) answer = message.text;
      }
      if (message.final) final = true;
    }
  }

  return {
    labels,
    answer,
    final,
    typed,
    rawComplete: frames.length > 0 && rawFrames === frames.length && pending === "",
  };
}

/**
 * Answer text from a complete body, without synthesizing a stream. A typed
 * candidate is returned only when its turn completed: an ACK body that carries
 * a partial turn must never be taken as the final answer.
 */
export function extractProcessSessionAnswer(bodyText) {
  const text = stripXssi(bodyText);
  if (!text.trim()) return "";
  if (looksLikeStreamGenerate(text)) return text;
  const progress = extractBindProgress(text);
  return progress.final ? progress.answer : "";
}

function streamFrame(payload) {
  const frame = JSON.stringify([["wrb.fr", null, JSON.stringify(payload)]]);
  return `${Buffer.byteLength(frame)}\n${frame}\n`;
}

export function streamBodyFromAnswerText(text) {
  return `${XSSI_GUARD}${streamFrame([null, "c_conversation", null, null, [["c_choice", [text]]]])}`;
}

/**
 * Synthesize the decoder's input from parsed Bind source: labels become the
 * same reasoning payloads hex StreamGenerate uses, then the answer frame.
 */
function streamBodyFromBind(labels, text) {
  let body = XSSI_GUARD;
  for (const label of labels) {
    body += streamFrame([
      null,
      ["c_conversation", "r_response"],
      { 7: [null, null, null, null, null, [label]], 44: true },
    ]);
  }
  if (text) body += streamFrame([null, "c_conversation", null, null, [["c_choice", [text]]]]);
  return body;
}

/**
 * Read a Bind GET until the turn's own completion flags, then return the
 * decoder's input. Completion is the captured pair: turn.1 = 1 together with
 * candidate.15 = 1 and answer text. That returns immediately, so a long-lived
 * channel never delays the answer.
 *
 * EOF is not completion. A long-poll can close after a partial answer, so a
 * typed stream that ends without the completed turn is an upstream error -- the
 * caller must never receive a finished stream carrying a prefix. A heartbeat
 * that carried no protobuf record at all returns "" so the existing
 * "completed without an answer" path applies, and a label-only stream has no
 * answer text either.
 */
export async function readBindUntilAnswer(response, { signal, limit } = {}) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let pull = null;

  const stop = async (text) => {
    try {
      await reader.cancel();
    } catch {
      // The reader may already be closed.
    }
    return text;
  };

  // A pending read only settles when the body itself stops, so an abort must
  // cancel the reader before the loop can observe the signal.
  const cancelRead = () => {
    try {
      reader.cancel().catch?.(() => {});
    } catch {
      // Cancellation is best-effort; the abort error is authoritative.
    }
  };
  signal?.addEventListener?.("abort", cancelRead, { once: true });

  const nextRead = () => {
    if (!pull) {
      pull = reader.read().finally(() => {
        pull = null;
      });
    }
    return pull;
  };

  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason);
      const progress = extractBindProgress(buffer);
      if (progress.rawComplete) return await stop(buffer);
      if (progress.final) return await stop(streamBodyFromBind(progress.labels, progress.answer));
      const { done, value } = await nextRead();
      if (value) {
        total += value.byteLength;
        if (limit && total > limit) {
          throw upstreamError("Gemini Web response exceeds the allowed size");
        }
        buffer += decoder.decode(value, { stream: !done });
      }
      if (done) {
        if (signal?.aborted) throw abortError(signal.reason);
        buffer += decoder.decode();
        const complete = extractBindProgress(buffer);
        if (complete.rawComplete) return buffer;
        if (complete.final) return streamBodyFromBind(complete.labels, complete.answer);
        if (complete.typed) {
          throw upstreamError(
            "Gemini Web Bind stream ended before the turn reported completion"
          );
        }
        return "";
      }
    }
  } finally {
    signal?.removeEventListener?.("abort", cancelRead);
    try {
      reader.releaseLock?.();
    } catch {
      // cancel() already released the lock.
    }
  }
}
