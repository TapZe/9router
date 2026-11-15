// Gemini Web media: image input validation, resumable upload, image download.
//
// Ported from gemini-web-to-api (MIT). See LICENSE in this directory.
// Copyright (c) 2025 Nguyễn Tuấn Thành

import {
  GEMINI_WEB_DEFAULT_PUSH_ID,
  GEMINI_WEB_ENDPOINTS,
  GEMINI_WEB_LIMITS,
  GEMINI_WEB_ORIGIN,
  GEMINI_WEB_UPLOAD_AUTHORIZATION,
  GEMINI_WEB_USER_AGENT,
  geminiWebError,
  normalizeAuthUser,
  parseRetryAfter,
  throwIfAborted,
  upstreamError,
} from "./config.js";
import { fetchGeminiWeb as defaultTransport } from "./transport.js";

const UPLOAD_HOST = "content-push.googleapis.com";
const MEDIA_MIME_TYPES = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;


/**
 * Accept only a bare HTTPS media URL on a Google content host.
 *
 * `usercontent.google.com` and its subdomains are required: generated-image
 * downloads redirect through `work.fife.usercontent.google.com`. Arbitrary
 * google.com hosts, userinfo and nondefault ports are rejected.
 */
export function isAllowedGeminiMediaUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  if (host === "gemini.google.com") return true;
  if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) return true;
  if (host === "usercontent.google.com" || host.endsWith(".usercontent.google.com")) return true;
  return false;
}

function asBytes(value) {
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function magicMatches(mime, bytes) {
  if (!bytes || bytes.length === 0) return false;
  if (mime === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  }
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }
  return false;
}

function normalizeMime(mime) {
  return typeof mime === "string" ? mime.split(";")[0].trim().toLowerCase() : "";
}

/**
 * Decode a PNG/JPEG/WebP base64 data URL. Remote URLs, SVG/HTML, malformed
 * base64 and MIME/magic mismatches are client errors; nothing is fetched.
 */
export function decodeGeminiWebImageDataUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    throw geminiWebError("Gemini Web image input must be a data URL", { status: 400 });
  }
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(rawUrl.trim());
  if (!match) {
    throw geminiWebError("Gemini Web accepts only base64 image data URLs", { status: 400 });
  }
  const mime = normalizeMime(match[1]);
  if (!MEDIA_MIME_TYPES[mime]) {
    throw geminiWebError(
      `Gemini Web does not accept ${mime || "unknown"} image input; use PNG, JPEG or WebP`,
      { status: 400 }
    );
  }
  const payload = match[2].replace(/\s+/g, "");
  if (!payload || !BASE64_PATTERN.test(payload)) {
    throw geminiWebError("Gemini Web image data URL is not valid base64", { status: 400 });
  }
  const data = Buffer.from(payload, "base64");
  if (data.length === 0) {
    throw geminiWebError("Gemini Web image data URL is empty", { status: 400 });
  }
  if (!magicMatches(mime, data)) {
    throw geminiWebError(
      `Gemini Web image data does not match its declared ${mime} type`,
      { status: 400 }
    );
  }
  return { mime, extension: MEDIA_MIME_TYPES[mime], data };
}

/** Enforce the aggregate image-input budget before any upload starts. */
export function assertGeminiWebInputImageBudget(value) {
  const total = Array.isArray(value)
    ? value.reduce((sum, size) => sum + (Number.isFinite(size) ? size : 0), 0)
    : Number.isFinite(value)
      ? value
      : 0;
  if (total > GEMINI_WEB_LIMITS.inputImagesBytes) {
    throw geminiWebError(
      `Gemini Web image input exceeds ${GEMINI_WEB_LIMITS.inputImagesBytes} bytes`,
      { status: 413 }
    );
  }
  return total;
}

function validateUploadUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw upstreamError("Gemini Web returned an invalid upload URL");
  }
  if (url.protocol !== "https:") {
    throw upstreamError("Gemini Web returned an insecure upload URL");
  }
  if (url.username || url.password) {
    throw upstreamError("Gemini Web returned an upload URL with credentials");
  }
  if (url.port !== "" && url.port !== "443") {
    throw upstreamError("Gemini Web returned an upload URL on a nondefault port");
  }
  if (url.hostname.toLowerCase() !== UPLOAD_HOST) {
    throw upstreamError("Gemini Web returned an upload URL on an untrusted host");
  }
}

function uploadHeaders(session, size) {
  return {
    accept: "*/*",
    authorization: GEMINI_WEB_UPLOAD_AUTHORIZATION,
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    origin: GEMINI_WEB_ORIGIN,
    referer: `${GEMINI_WEB_ORIGIN}/`,
    "push-id": session.pushId || GEMINI_WEB_DEFAULT_PUSH_ID,
    "x-goog-upload-command": "start",
    "x-goog-upload-header-content-length": String(size),
    "x-goog-upload-protocol": "resumable",
    "x-tenant-id": "bard-storage",
    "user-agent": GEMINI_WEB_USER_AGENT,
    cookie: session.cookieHeader,
  };
}

async function discard(response) {
  try {
    if (response?.body && !response.body.locked) await response.body.cancel();
  } catch {
    // Draining a failed response is best-effort.
  }
}

function assertOk(response, what) {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    throw geminiWebError(`Gemini Web ${what} was rejected with HTTP ${response.status}`, {
      status: response.status,
      retryAfter: parseRetryAfter(response.headers?.get?.("retry-after")),
    });
  }
  throw upstreamError(`Gemini Web ${what} failed with HTTP ${response.status}`);
}

async function send(url, { method, headers, body, signal, proxyOptions, transport, timeoutMs, forceFreshSocket }) {
  const fetchImpl = transport || defaultTransport;
  const proxy = { ...(proxyOptions || {}), strictProxy: true };
  const options = {
    method,
    headers,
    redirect: "manual",
    strictTls: true,
    maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
    timeoutMs,
    signal,
  };
  if (body !== undefined) options.body = body;
  if (forceFreshSocket) options.forceFreshSocket = true;
  return fetchImpl(url, options, proxy);
}

async function readBytesLimited(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw upstreamError("Gemini Web generated image exceeds the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

/**
 * Upload one image through the reference resumable protocol. The endpoint and
 * every returned URL must stay on the exact content-push host.
 */
export async function uploadGeminiWebImage(session, file, { signal, proxyOptions, transport } = {}) {
  throwIfAborted(signal);
  if (!session || typeof session !== "object" || !session.cookieHeader) {
    throw geminiWebError("Gemini Web upload requires an authenticated session", { status: 401 });
  }

  const data = asBytes(file?.data);
  if (!data || data.length === 0) {
    throw geminiWebError("Gemini Web upload requires nonempty image bytes", { status: 400 });
  }
  if (data.length > GEMINI_WEB_LIMITS.inputImagesBytes) {
    throw geminiWebError(
      `Gemini Web image input exceeds ${GEMINI_WEB_LIMITS.inputImagesBytes} bytes`,
      { status: 413 }
    );
  }
  const mime = normalizeMime(file?.mimeType);
  if (!MEDIA_MIME_TYPES[mime]) {
    throw geminiWebError(
      `Gemini Web does not accept ${mime || "unknown"} image input; use PNG, JPEG or WebP`,
      { status: 400 }
    );
  }
  if (!magicMatches(mime, data)) {
    throw geminiWebError(
      `Gemini Web image data does not match its declared ${mime} type`,
      { status: 400 }
    );
  }

  const suppliedName = typeof file?.name === "string" ? file.name.trim() : "";
  const name = suppliedName || `image_1.${MEDIA_MIME_TYPES[mime]}`;
  const headers = uploadHeaders(session, data.length);
  const common = {
    signal,
    proxyOptions,
    transport,
    timeoutMs: GEMINI_WEB_LIMITS.uploadTimeoutMs,
    forceFreshSocket: true,
  };

  const prepare = await send(GEMINI_WEB_ENDPOINTS.upload, {
    ...common,
    method: "OPTIONS",
    headers,
  });
  assertOk(prepare, "upload preparation");
  await discard(prepare);

  const startHeaders = { ...headers, size: String(data.length) };
  const start = await send(GEMINI_WEB_ENDPOINTS.upload, {
    ...common,
    method: "POST",
    headers: startHeaders,
    body: `File name: ${name}`,
  });
  assertOk(start, "upload start");
  const uploadUrl = start.headers.get("x-goog-upload-url")?.trim() || "";
  await discard(start);
  if (!uploadUrl) {
    throw upstreamError("Gemini Web upload did not return an upload URL");
  }
  validateUploadUrl(uploadUrl);

  const prepareUrl = await send(uploadUrl, {
    ...common,
    method: "OPTIONS",
    headers: startHeaders,
  });
  assertOk(prepareUrl, "upload URL preparation");
  await discard(prepareUrl);

  const finalizeHeaders = {
    ...startHeaders,
    "content-type": mime,
    "x-goog-upload-command": "upload, finalize",
    "x-goog-upload-offset": "0",
  };
  const finalize = await send(uploadUrl, {
    ...common,
    method: "POST",
    headers: finalizeHeaders,
    body: data,
  });
  assertOk(finalize, "upload finalize");
  const id = (await finalize.text()).trim().slice(0, 4096);
  if (!id) {
    throw upstreamError("Gemini Web upload returned an empty file id");
  }
  return { id, name };
}

function appendGoogleImageSize(rawUrl, size) {
  if (!Number.isInteger(size) || size <= 0) return rawUrl;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return rawUrl;
  }
  const lastSegment = url.pathname.split("/").pop() || "";
  if (lastSegment.includes("=s") || lastSegment.includes("=w")) return url.toString();
  url.pathname = `${url.pathname.replace(/\/$/, "")}=s${size}`;
  return url.toString();
}

// Non-default Google slots 403 unless the download names the account, same as
// the reference video/music helper. Root "" must not invent authuser.
function applyMediaAuthUser(rawUrl, authUser) {
  const slot = normalizeAuthUser(authUser);
  if (slot === "") return rawUrl;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return rawUrl;
  }
  url.searchParams.set("authuser", slot);
  return url.toString();
}

/**
 * Download one generated image with the account cookie. Every redirect is
 * validated before the next request, and the bytes must be a real PNG/JPEG/WebP.
 */
export async function downloadGeminiWebImage(session, image, { signal, proxyOptions, transport, authUser } = {}) {
  throwIfAborted(signal);
  if (!session || typeof session !== "object" || !session.cookieHeader) {
    throw geminiWebError("Gemini Web download requires an authenticated session", { status: 401 });
  }
  if (!image || typeof image.url !== "string" || !image.url) {
    throw upstreamError("Gemini Web generated image has no download URL");
  }

  let current = applyMediaAuthUser(
    appendGoogleImageSize(image.url, GEMINI_WEB_LIMITS.generatedImageSize),
    authUser
  );
  if (!isAllowedGeminiMediaUrl(current)) {
    throw upstreamError("Gemini Web generated image URL is on an untrusted host");
  }
  const headers = {
    "user-agent": GEMINI_WEB_USER_AGENT,
    referer: `${GEMINI_WEB_ORIGIN}/`,
    cookie: session.cookieHeader,
  };
  const common = {
    signal,
    proxyOptions,
    transport,
    timeoutMs: GEMINI_WEB_LIMITS.downloadTimeoutMs,
  };

  let hops = 0;
  for (;;) {
    const response = await send(current, { ...common, method: "GET", headers });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await discard(response);
      if (!location) {
        throw upstreamError("Gemini Web image download returned an empty redirect");
      }
      let next;
      try {
        next = applyMediaAuthUser(new URL(location, current).toString(), authUser);
      } catch {
        throw upstreamError("Gemini Web image download returned an invalid redirect");
      }
      hops += 1;
      if (hops > GEMINI_WEB_LIMITS.maxRedirects) {
        throw upstreamError("Gemini Web image download exceeded the redirect limit");
      }
      if (!isAllowedGeminiMediaUrl(next)) {
        throw upstreamError("Gemini Web image download redirected to an untrusted host");
      }
      current = next;
      continue;
    }

    if (response.status !== 200) {
      await discard(response);
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        throw geminiWebError(
          `Gemini Web image download was rejected with HTTP ${response.status}`,
          {
            status: response.status,
            retryAfter: parseRetryAfter(response.headers?.get?.("retry-after")),
          }
        );
      }
      throw upstreamError(`Gemini Web image download failed with HTTP ${response.status}`);
    }

    const contentType = normalizeMime(response.headers.get("content-type"));
    if (!MEDIA_MIME_TYPES[contentType]) {
      await discard(response);
      throw upstreamError("Gemini Web image download did not return a supported image type");
    }
    const data = await readBytesLimited(response, GEMINI_WEB_LIMITS.generatedImageBytes);
    if (!magicMatches(contentType, data)) {
      throw upstreamError("Gemini Web image download bytes do not match the declared image type");
    }
    return { b64: data.toString("base64"), mime: contentType };
  }
}
