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

function collectProtoStrings(buf, found) {
  let offset = 0;
  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (tag.error) break;
    offset = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (wire === 0) {
      const num = readVarint(buf, offset);
      offset = num.next;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, offset);
      if (len.error) break;
      offset = len.next;
      const end = offset + len.value;
      if (end > buf.length) break;
      const slice = buf.subarray(offset, end);
      offset = end;
      const asStr = Buffer.from(slice).toString("utf8");
      if (slice.length > 0 && /^[\x09\x0a\x0d\x20-\x7e]+$/.test(asStr)) {
        if (asStr.length >= 1 && field > 0) found.push({ field, text: asStr });
      } else {
        collectProtoStrings(slice, found);
      }
    } else {
      break;
    }
  }
}

const SKIP_STRINGS = new Set(["argon", "en", "ping", "c", "ok"]);

export function extractProcessSessionAnswer(bodyText) {
  const text = stripXssi(bodyText);
  if (!text.trim()) return "";
  if (looksLikeStreamGenerate(text)) return text;

  const candidates = [];
  const consider = (value) => {
    if (typeof value !== "string" || value.length < 1) return;
    if (SKIP_STRINGS.has(value)) return;
    if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value)) return;
    if (/^c_[0-9a-f]+$/i.test(value)) return;
    if (value.startsWith("!")) return;
    if (/^[0-9a-f]{32}$/i.test(value)) return;
    candidates.push(value);
  };

  try {
    const parsed = JSON.parse(text);
    const walk = (node) => {
      if (typeof node === "string") {
        consider(node);
        if (/^[A-Za-z0-9+/]+=*$/.test(node) && node.length > 8) {
          try {
            const buf = Buffer.from(node, "base64");
            const found = [];
            collectProtoStrings(buf, found);
            for (const item of found) consider(item.text);
          } catch {
            // Not base64 protobuf.
          }
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node && typeof node === "object") {
        for (const child of Object.values(node)) walk(child);
      }
    };
    walk(parsed);
  } catch {
    const found = [];
    collectProtoStrings(Buffer.from(text), found);
    for (const item of found) consider(item.text);
  }

  const longest = candidates.sort((a, b) => b.length - a.length)[0];
  return longest || "";
}

export function streamBodyFromAnswerText(text) {
  const payload = [null, "c_conversation", null, null, [["c_choice", [text]]]];
  const frame = JSON.stringify([["wrb.fr", null, JSON.stringify(payload)]]);
  return `${XSSI_GUARD}${Buffer.byteLength(frame)}\n${frame}\n`;
}

export async function readBindUntilAnswer(response, { signal, limit } = {}) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;

  const stop = async (text) => {
    try {
      await reader.cancel();
    } catch {
      // The reader may already be closed.
    }
    return text;
  };

  const answered = (text) => {
    if (text.includes("wrb.fr")) return text;
    const extracted = extractProcessSessionAnswer(text);
    if (!extracted) return "";
    return extracted.includes("wrb.fr") ? extracted : streamBodyFromAnswerText(extracted);
  };

  try {
    for (;;) {
      if (signal?.aborted) throw abortError(signal.reason);
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (limit && total > limit) {
          throw upstreamError("Gemini Web response exceeds the allowed size");
        }
        buffer += decoder.decode(value, { stream: !done });
      }
      const ready = answered(buffer);
      if (ready) return await stop(ready);
      try {
        JSON.parse(stripXssi(buffer));
        const complete = answered(buffer);
        if (complete) return await stop(complete);
      } catch {
        // Incomplete JSON: keep reading.
      }
      if (done) {
        buffer += decoder.decode();
        return answered(buffer);
      }
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      // cancel() already released the lock.
    }
  }
}


