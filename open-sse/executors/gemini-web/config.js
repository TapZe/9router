// Gemini Web protocol constants and error factories.
//
// Ported from gemini-web-to-api (MIT). See LICENSE in this directory.
// Copyright (c) 2025 Nguyễn Tuấn Thành

export const GEMINI_WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const GEMINI_WEB_ENDPOINTS = Object.freeze({
  google: "https://www.google.com/",
  app: "https://gemini.google.com/app",
  generate:
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  batchExec: "https://gemini.google.com/_/BardChatUi/data/batchexecute",
  rotateCookies: "https://accounts.google.com/RotateCookies",
  upload: "https://content-push.googleapis.com/upload",
});

export const GEMINI_WEB_ORIGIN = "https://gemini.google.com";
export const GEMINI_WEB_GEMINI_PREFIX = `${GEMINI_WEB_ORIGIN}/`;

export const GEMINI_WEB_DEFAULT_PUSH_ID = "feeds/mcudyrk2a4khkz";
export const GEMINI_WEB_DEFAULT_LANGUAGE = "en";
export const GEMINI_WEB_MODEL_HEADER = "x-goog-ext-525001261-jspb";
export const GEMINI_WEB_USER_STATUS_RPC = "otAQ7b";

// Upload-protocol authorization constant published by the reference client.
// It is not a user credential and carries no account access.
export const GEMINI_WEB_UPLOAD_AUTHORIZATION =
  "Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=";

export const GEMINI_WEB_DEFAULT_HEADERS = Object.freeze({
  "content-type": "application/x-www-form-urlencoded;charset=utf-8",
  origin: GEMINI_WEB_ORIGIN,
  referer: `${GEMINI_WEB_ORIGIN}/`,
  "user-agent": GEMINI_WEB_USER_AGENT,
  "x-same-domain": "1",
});

export const GEMINI_WEB_LIMITS = Object.freeze({
  maxHeaderSize: 2 * 1024 * 1024,
  bootstrapTimeoutMs: 30 * 1000,
  generationTimeoutMs: 5 * 60 * 1000,
  uploadTimeoutMs: 2 * 60 * 1000,
  downloadTimeoutMs: 2 * 60 * 1000,
  maxFrameBytes: 8 * 1024 * 1024,
  modelResponseBytes: 8 * 1024 * 1024,
  inputImagesBytes: 32 * 1024 * 1024,
  generatedImageBytes: 32 * 1024 * 1024,
  maxRedirects: 5,
  generatedImageSize: 2048,
});

/** Wire enums for the Gemini Web thinking selector. */
export const GEMINI_WEB_THINKING_LEVELS = Object.freeze({ low: 1, medium: 4, high: 2 });

/** Effort names that mean "let Gemini choose", mapped to the low enum. */
export const GEMINI_WEB_AUTOMATIC_THINKING = Object.freeze(["", "auto", "default", "automatic"]);

export const GEMINI_WEB_UNSUPPORTED_CONTROL_CODE = "unsupported_control_for_provider";
export const GEMINI_WEB_UPSTREAM_ERROR_CODE = "gemini_web_upstream_error";

export function geminiWebError(message, { status = 502, code, retryAfter, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "GeminiWebError";
  error.status = status;
  if (code) error.code = code;
  if (Number.isFinite(retryAfter)) error.retryAfter = retryAfter;
  return error;
}

export function unsupportedControl(message) {
  return geminiWebError(message, {
    status: 400,
    code: GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
  });
}

export function upstreamError(message, { status = 502, retryAfter, cause } = {}) {
  return geminiWebError(message, {
    status,
    code: GEMINI_WEB_UPSTREAM_ERROR_CODE,
    retryAfter,
    cause,
  });
}

export function abortError(reason) {
  const error = new Error(
    reason instanceof Error ? reason.message : "The Gemini Web request was aborted"
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

/** Parse a Retry-After header as seconds, ignoring HTTP-date forms we cannot use. */
export function parseRetryAfter(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Slot is "" (default root) or a canonical nonnegative integer string. */
export function normalizeAuthUser(authUser) {
  if (authUser === undefined || authUser === null || authUser === "") return "";
  if (typeof authUser !== "string" || !/^(0|[1-9]\d*)$/.test(authUser)) {
    throw geminiWebError(
      "Gemini Web account slot must be a nonnegative integer string",
      { status: 400 }
    );
  }
  if (!Number.isSafeInteger(Number(authUser))) {
    throw geminiWebError("Gemini Web account slot is out of range", { status: 400 });
  }
  return authUser;
}

export function geminiSourcePath(authUser) {
  const slot = normalizeAuthUser(authUser);
  return slot === "" ? "/app" : `/u/${slot}/app`;
}

/** Prefix only Gemini app endpoints; rotation and upload URLs keep their host. */
export function geminiAccountUrl(endpoint, authUser) {
  const slot = normalizeAuthUser(authUser);
  if (slot === "") return endpoint;
  const value = String(endpoint);
  if (!value.startsWith(GEMINI_WEB_GEMINI_PREFIX)) return value;
  return `${GEMINI_WEB_GEMINI_PREFIX}u/${slot}/${value.slice(GEMINI_WEB_GEMINI_PREFIX.length)}`;
}
