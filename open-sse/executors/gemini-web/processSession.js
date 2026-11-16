// Argon / policy-code generate uses Gemini Web ProcessSession (BrowserChannel
// Bind), not StreamGenerate. Field numbers are pinned from a live Argon capture
// (req0 envelope + req1 prompt) plus BardChatUi's jspb mapping (proto field N
// is JSON array index N-1).

import { createHash } from "node:crypto";

import {
  GEMINI_WEB_DEFAULT_LANGUAGE,
  GEMINI_WEB_ENDPOINTS,
  GEMINI_WEB_LIMITS,
  GEMINI_WEB_ORIGIN,
  abortError,
  normalizeAuthUser,
  upstreamError,
} from "./config.js";
import { isJsonWhitespace, scanJsonValue } from "./stream.js";

const TEXT_ENC = new TextEncoder();
const XSSI_GUARD = ")]}'\n";

// ProcessSession carries base64 protobuf request records; the channel must be
// told so at handshake time or the service parses them as JSON.
const BIND_CONTENT_TYPE = "application/x-protobuf";

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
  aid = 0,
  apiKey = "",
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
    // The captured browser handshake declares the channel's caller identity and
    // payload type here; ProcessSession rejects an unregistered caller, and
    // without the protobuf declaration it parses the base64 body as JSON.
    const declared = [];
    const auth = buildSapiSidHash(cookieHeader);
    if (auth) declared.push(`Authorization:${auth}`);
    if (apiKey) declared.push(`X-Goog-Api-Key:${apiKey}`);
    declared.push(`X-WebChannel-Content-Type:${BIND_CONTENT_TYPE}`);
    query.set("$httpHeaders", declared.join("\r\n"));
  } else {
    if (gsessionid) query.set("gsessionid", gsessionid);
    if (sid) query.set("SID", sid);
    // The channel acknowledgement cursor: a rearm asks for everything after
    // the highest record already applied to this turn.
    query.set("AID", String(aid));
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

const BIND_CONTROL_TOKENS = Object.freeze(["noop", "close", "stop"]);

/**
 * One turn's Bind parser state. A receive poll can end mid-turn and be
 * rearmed, so every later poll must see the labels, answer, partial frame and
 * acknowledgement cursor the earlier ones produced. Keeping them here is what
 * makes a rollover idempotent instead of a second generation.
 */
function createBindChannelState() {
  return {
    pending: "",
    labels: [],
    answer: "",
    final: false,
    typed: false,
    frames: 0,
    rawFrames: 0,
    bytes: 0,
    // Decoded wire text for the whole turn. A raw (hex/wrb) body can be split
    // across a rollover, so the passthrough must return the whole run rather
    // than the last poll's tail; `bytes` bounds it.
    rawText: "",
    sequence: null,
    control: null,
    sm: null,
  };
}

function bindProgress(state) {
  return {
    labels: state.labels,
    answer: state.answer,
    final: state.final,
    typed: state.typed,
    control: state.control,
    sm: state.sm,
    sequence: state.sequence,
    rawComplete: state.frames > 0 && state.rawFrames === state.frames && state.pending === "",
  };
}

function entrySequence(entry) {
  const value = Array.isArray(entry) ? entry[0] : null;
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A rearm asks for everything after the highest record already applied, so a
 * record at or below that cursor is a replay and cannot rewrite the answer.
 */
function isReplayedRecord(state, sequence) {
  return sequence !== null && state.sequence !== null && sequence <= state.sequence;
}

function advanceSequence(state, sequence) {
  if (sequence === null) return;
  if (state.sequence === null || sequence > state.sequence) state.sequence = sequence;
}

function controlToken(payload) {
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const token = payload[0];
  return typeof token === "string" && BIND_CONTROL_TOKENS.includes(token) ? token : null;
}

const SM_MAX_GROUPS = 8;
const SM_MAX_RECORDS = 8;
const SM_MAX_MESSAGE_CHARS = 300;
const SM_MAX_REASON_CHARS = 64;

function sanitizeSmText(value, limit) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The channel's own service-error record, captured on a rejected Argon turn as
 * `[1, {"__sm__": {"status": [[{"error": {code, message, status}}]]}}]`. It is
 * bounded: a few records, sanitized text, and an HTTP status only when the
 * upstream code is one. A status entry that is not this shape contributes
 * nothing, so no failure is invented from unrelated metadata.
 */
function readSmStatus(entry) {
  const envelope = entry?.[1];
  if (!plainObject(envelope)) return null;
  const serviceStatus = envelope.__sm__;
  if (!plainObject(serviceStatus) || !Array.isArray(serviceStatus.status)) return null;
  for (const group of serviceStatus.status.slice(0, SM_MAX_GROUPS)) {
    const records = Array.isArray(group) ? group : [group];
    for (const record of records.slice(0, SM_MAX_RECORDS)) {
      if (!plainObject(record) || !plainObject(record.error)) continue;
      const message = sanitizeSmText(record.error.message, SM_MAX_MESSAGE_CHARS);
      if (!message) continue;
      const code = Number(record.error.code);
      return {
        status: Number.isInteger(code) && code >= 400 && code <= 599 ? code : 502,
        reason: sanitizeSmText(record.error.status, SM_MAX_REASON_CHARS),
        message,
      };
    }
  }
  return null;
}

function bindSmError(failure) {
  const detail = failure.reason ? `${failure.reason}: ${failure.message}` : failure.message;
  const error = upstreamError(`Gemini Web rejected the request: ${detail}`, {
    status: failure.status,
  });
  // An `__sm__` record only ever arrives on a channel that exists after the
  // turn POST, so the generation may already be consumed. The executor still
  // gates this on its own dispatch flag.
  error.nonReplayable = true;
  return error;
}

/**
 * BrowserChannel authority for the channel itself: `noop` keeps it alive while
 * `close` and `stop` end it without producing an answer. None of the three is
 * evidence that the turn completed.
 */
function bindControlError(control) {
  if (control === "close") {
    return upstreamError("Gemini Web Bind channel closed before the turn completed");
  }
  if (control === "stop") {
    return upstreamError("Gemini Web stopped the turn before it completed");
  }
  return null;
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
function absorbBindText(state, text) {
  const { frames, pending } = scanBindFrames(state.pending + String(text ?? ""));
  state.pending = pending;
  for (const value of frames) {
    state.frames += 1;
    if (frameCarriesWrb(value)) {
      state.rawFrames += 1;
      continue;
    }
    for (const entry of Array.isArray(value) ? value : []) {
      if (!Array.isArray(entry)) continue;
      const sequence = entrySequence(entry);
      // Channel-level facts are not turn data: a close/stop or the service
      // error describing why this channel ended still applies when its record
      // id is at or below the acknowledged cursor, so they precede the replay
      // skip that protects the answer.
      if (!Array.isArray(entry[1])) {
        const serviceError = readSmStatus(entry);
        if (serviceError && !state.sm) state.sm = serviceError;
        advanceSequence(state, sequence);
        continue;
      }
      const control = controlToken(entry[1]);
      if (control) {
        if (control !== "noop" && !state.control) state.control = control;
        advanceSequence(state, sequence);
        continue;
      }
      if (isReplayedRecord(state, sequence)) continue;
      advanceSequence(state, sequence);
      const encoded = entry[1][0];
      if (typeof encoded !== "string" || !encoded) continue;
      const message = readBindMessage(Buffer.from(encoded, "base64"));
      if (message.present) state.typed = true;
      // The first completed turn owns the answer and completion. Labels and
      // text after it are post-answer chrome (labels) or a different turn's
      // text, and neither may replace what was already delivered.
      if (state.final) continue;
      for (const label of message.labels) {
        if (!state.labels.includes(label)) state.labels.push(label);
      }
      if (message.text) state.answer = message.text;
      if (message.final) state.final = true;
    }
  }
  return bindProgress(state);
}

function extractBindProgress(buffer) {
  return absorbBindText(createBindChannelState(), buffer);
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
 * Read one Bind body to its own end and report what it proved. Completion is
 * the captured flag pair, never a quiet poll: a body that ends with a partial
 * turn, a heartbeat or nothing at all is a rollover the caller may rearm.
 */
async function consumeBindBody(response, { state, signal, limit }) {
  if (!response?.body) return { eof: true };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pull = null;

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
      const progress = bindProgress(state);
      if (progress.rawComplete) return { rawComplete: true };
      if (progress.final) return { final: true };
      // An explicit service error outranks the close control that follows it in
      // the same body: the status and message are the reason the channel ended.
      if (progress.sm) return { sm: progress.sm };
      if (progress.control) return { control: progress.control };
      const { done, value } = await nextRead();
      if (value) {
        // The bound covers the whole turn, not one poll: a channel that reopens
        // cannot reset the budget by closing.
        state.bytes += value.byteLength;
        if (limit && state.bytes > limit) {
          throw upstreamError("Gemini Web response exceeds the allowed size");
        }
      }
      if (done) {
        if (signal?.aborted) throw abortError(signal.reason);
        const tail = decoder.decode();
        state.rawText += tail;
        absorbBindText(state, tail);
        const settled = bindProgress(state);
        return {
          final: settled.final,
          rawComplete: settled.rawComplete,
          control: settled.control,
          sm: settled.sm,
          eof: true,
        };
      }
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;
      state.rawText += text;
      absorbBindText(state, text);
    }
  } finally {
    signal?.removeEventListener?.("abort", cancelRead);
    try {
      await reader.cancel();
    } catch {
      // The reader may already be closed.
    }
    try {
      reader.releaseLock?.();
    } catch {
      // cancel() already released the lock.
    }
  }
}

/**
 * Read one Bind GET until the turn's own completion flags, then return the
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
  const state = createBindChannelState();
  const result = await consumeBindBody(response, { state, signal, limit });
  if (result.rawComplete) return state.rawText;
  if (result.final) return streamBodyFromBind(state.labels, state.answer);
  if (result.sm) throw bindSmError(result.sm);
  const control = bindControlError(result.control);
  if (control) throw control;
  if (state.typed) {
    throw upstreamError("Gemini Web Bind stream ended before the turn reported completion");
  }
  return "";
}

/**
 * The channel's own service error from a complete body, as the error a caller
 * can raise. The send ACK is read as a whole body, so a rejection that arrives
 * as a 200 with an `__sm__` record must not be mistaken for an empty ACK.
 */
export function extractProcessSessionFailure(bodyText) {
  const text = stripXssi(bodyText);
  if (!text.trim()) return null;
  const progress = extractBindProgress(text);
  return progress.sm ? bindSmError(progress.sm) : null;
}

/**
 * Drive one turn across Bind polls. A poll handle settles to its receive
 * response without blocking, so the caller starts the first poll before it
 * posts the turn and every later one only after a body ended without
 * completion. Rollover is not completion: the next poll acknowledges the
 * highest sequence seen and carries this state forward, so a replayed record
 * cannot rewrite the answer and no poll ever re-sends the generation.
 *
 * Every rearm reuses the turn's own signal, so the caller keeps one deadline
 * and one cancellation scope for the whole turn instead of a fresh budget per
 * poll.
 */
export async function readBindChannel({ firstPoll, startPoll, signal, limit }) {
  const state = createBindChannelState();
  let poll = firstPoll;
  const abandon = () => {
    const current = poll;
    poll = null;
    current?.abandon?.();
  };

  try {
    for (let polls = 0; ; polls += 1) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (polls >= GEMINI_WEB_LIMITS.bindPollLimit) {
        throw upstreamError(
          `Gemini Web Bind stream ended before the turn reported completion (${GEMINI_WEB_LIMITS.bindPollLimit} polls)`
        );
      }
      if (!poll) poll = startPoll(state.sequence ?? 0);
      const current = poll;
      const outcome = await current.settle();
      if (!outcome.ok) {
        if (signal?.aborted) throw abortError(signal.reason);
        throw outcome.error;
      }
      if (!outcome.response.ok) {
        // The read itself was rejected; the response carries the status and
        // Retry-After the caller must report, so hand it back untouched.
        poll = null;
        return { rejected: outcome.response };
      }
      const result = await consumeBindBody(outcome.response, { state, signal, limit });
      poll = null;
      current.abandon?.();
      if (result.rawComplete) return { rawText: state.rawText };
      if (result.final) return { body: streamBodyFromBind(state.labels, state.answer) };
      // A rejection that arrives as a 200 body is still the turn's reason for
      // ending, and it must be reported with the upstream status.
      if (result.sm) throw bindSmError(result.sm);
      const control = bindControlError(result.control);
      if (control) throw control;
    }
  } finally {
    abandon();
  }
}
