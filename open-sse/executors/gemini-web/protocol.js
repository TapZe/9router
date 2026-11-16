// Native Gemini Web wire client: bootstrap, generation, thinking and redirects.
//
// Ported from gemini-web-to-api (MIT). See LICENSE in this directory.
// Copyright (c) 2025 Nguyễn Tuấn Thành

import { randomUUID } from "node:crypto";

import { normalizeGeminiCookieInput } from "../../utils/geminiCookies.js";
import { markNonReplayableResponse } from "../../utils/replayPolicy.js";
import {
  GEMINI_WEB_AUTOMATIC_THINKING,
  GEMINI_WEB_DEFAULT_HEADERS,
  GEMINI_WEB_DEFAULT_LANGUAGE,
  GEMINI_WEB_DEFAULT_PUSH_ID,
  GEMINI_WEB_ENDPOINTS,
  GEMINI_WEB_GEMINI_PREFIX,
  GEMINI_WEB_LIMITS,
  GEMINI_WEB_MODEL_HEADER,
  GEMINI_WEB_THINKING_LEVELS,
  GEMINI_WEB_USER_AGENT,
  abortError,
  geminiAccountUrl,
  geminiSourcePath,
  geminiWebError,
  normalizeAuthUser,
  parseRetryAfter,
  throwIfAborted,
  unsupportedControl,
  upstreamError,
} from "./config.js";
import {
  GEMINI_WEB_TASK,
  GEMINI_WEB_TRANSPORT,
  fetchGeminiWebModels,
  selectGeminiTransport,
} from "./models.js";
import {
  encodeProcessSessionReq0,
  encodeProcessSessionReq1,
  extractProcessSessionAnswer,
  extractProcessSessionFailure,
  parseBrowserChannelOpen,
  processSessionUrl,
  protoToBase64,
  randomBindRid,
  readBindChannel,
  streamBodyFromAnswerText,
} from "./processSession.js";
import { fetchGeminiWeb as defaultTransport, readGeminiWebBodyText } from "./transport.js";

export { geminiAccountUrl, geminiSourcePath, normalizeAuthUser };

const SIGN_IN_ORIGIN = "https://accounts.google.com";
const HTML_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

const TOKEN_PATTERNS = {
  at: [/"SNlM0e":"([^"]+)"/, /\["SNlM0e","([^"]+)"\]/],
  pushId: /"qKIAYe":"([^"]+)"/,
  buildLabel: /"cfb2h":"([^"]+)"/,
  sessionId: /"FdrFJe":"([^"]+)"/,
  language: /"TuX5cc":"([^"]+)"/,
  // Public API consumer key the application declares in WIZ_global_data. The
  // ProcessSession service requires some caller identity; this is the same
  // public value the browser ships, not a user credential.
  apiConsumerKey: /"d2zJAe"\s*:\s*"([^"]+)"/,
};

const API_CONSUMER_KEY_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

/**
 * Read the bootstrap's public API consumer key. A value that is not shaped like
 * one is treated as absent, so a page change yields the explicit "missing key"
 * preparation error instead of sending junk identity.
 */
function readApiConsumerKey(body) {
  const key = firstMatch(body, TOKEN_PATTERNS.apiConsumerKey).trim();
  return API_CONSUMER_KEY_SHAPE.test(key) ? key : "";
}


function firstMatch(body, pattern) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  for (const candidate of patterns) {
    const match = candidate.exec(body);
    if (match && match[1]) return match[1];
  }
  return "";
}

function decodeAccountLabel(label) {
  const entities = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return label.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, key) => {
    if (!key.startsWith("#")) return entities[key.toLowerCase()] || entity;
    const hex = key[1].toLowerCase() === "x";
    const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : entity;
  });
}

function readAccountIdentity(body) {
  // Generic email fields can describe other signed-in accounts, not this slot.
  const match = /"oPEP7c"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(body);
  if (!match) return null;
  let email;
  try {
    email = JSON.parse(match[1]).trim();
  } catch {
    return null;
  }
  if (email.length > 254 || /[\u0000-\u001f\u007f-\u009f]/u.test(email) || !/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/u.test(email)) return null;
  for (const attribute of body.matchAll(/\baria-label\s*=\s*(["'])(.*?)\1/gs)) {
    const label = /^Google Account:\s*(.*?)\s*\(([^()]*)\)\s*$/s.exec(decodeAccountLabel(attribute[2]));
    if (label?.[2].trim().toLowerCase() !== email.toLowerCase()) continue;
    const name = label[1].trim().replace(/\s+/g, " ");
    if (name && name.length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name)) return { name, email };
  }
  return { name: email, email };
}

/**
 * Map an effort intent to the wire enum. The decoder only accepts the three
 * levels Gemini Web exposes; anything else is a compatibility rejection.
 */
export function resolveThinkingLevel(level) {
  if (level === undefined || level === null) return GEMINI_WEB_THINKING_LEVELS.low;
  if (typeof level === "number") {
    if (level === 1 || level === 4 || level === 2) return level;
    throw unsupportedControl(
      `Model provider "gemini-web" cannot honor this thinking budget (${level}). It supports only low, medium or high effort.`
    );
  }
  if (typeof level !== "string") {
    throw unsupportedControl(
      'Model provider "gemini-web" cannot honor a non-text thinking control. Use low, medium or high.'
    );
  }
  const value = level.trim().toLowerCase();
  if (GEMINI_WEB_AUTOMATIC_THINKING.includes(value)) return GEMINI_WEB_THINKING_LEVELS.low;
  if (Object.prototype.hasOwnProperty.call(GEMINI_WEB_THINKING_LEVELS, value)) {
    return GEMINI_WEB_THINKING_LEVELS[value];
  }
  throw unsupportedControl(
    `Model provider "gemini-web" does not support thinking level "${level}". Use low, medium or high.`
  );
}

function normalizeCookieHeader(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^cookie:\s*/i, "");
  return normalizeGeminiCookieInput(trimmed);
}

function parseCookiePairs(header) {
  const pairs = [];
  for (const part of String(header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    if (!name) continue;
    pairs.push([name, trimmed.slice(index + 1).trim()]);
  }
  return pairs;
}

function setCookiesOf(response) {
  if (!response?.headers) return [];
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const raw = response.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function absorbCookies(jar, response) {
  for (const cookie of setCookiesOf(response)) {
    const first = String(cookie).split(";")[0];
    const index = first.indexOf("=");
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    // A deletion (empty value + expired attributes) must not be replayed as an
    // empty cookie; dropping the name keeps the jar truthful.
    if (!name) continue;
    if (value === "" && /max-age=0|expires=thu, 01 jan 1970/i.test(String(cookie))) {
      jar.delete(name);
      continue;
    }
    jar.set(name, value);
  }
}

function cookieHeaderFromJar(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function drain(response) {
  try {
    if (response?.body && !response.body.locked) await response.body.cancel();
  } catch {
    // A drained body is best-effort cleanup; the request outcome is unchanged.
  }
}

function statusError(response, what) {
  const status = response.status;
  if (status === 401 || status === 403 || status === 429) {
    return geminiWebError(`Gemini Web ${what} was rejected with HTTP ${status}`, {
      status,
      retryAfter: parseRetryAfter(response.headers?.get?.("retry-after")),
    });
  }
  return upstreamError(`Gemini Web ${what} failed with HTTP ${status}`);
}

/**
 * Follow at most `maxRedirects` same-origin redirects while keeping account
 * cookies inside the Gemini origin. A sign-in redirect is an authentication
 * failure and never receives them.
 */
async function followGeminiRedirects({
  startUrl,
  fetchImpl,
  proxyOptions,
  signal,
  jar,
  baseHeaders,
}) {
  let current;
  try {
    current = new URL(startUrl);
  } catch {
    throw upstreamError("Gemini Web produced an invalid URL");
  }
  const origin = current.origin;
  let hops = 0;

  for (;;) {
    throwIfAborted(signal);
    const response = await fetchImpl(
      current.toString(),
      {
        method: "GET",
        headers: { ...baseHeaders, cookie: cookieHeaderFromJar(jar) },
        redirect: "manual",
        strictTls: true,
        maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
        timeoutMs: GEMINI_WEB_LIMITS.bootstrapTimeoutMs,
        signal,
      },
      proxyOptions
    );
    absorbCookies(jar, response);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, url: current };
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw upstreamError("Gemini Web returned an invalid redirect location");
      }
      if (next.origin === SIGN_IN_ORIGIN) {
        await drain(response);
        throw geminiWebError("Gemini Web session is not signed in", { status: 401 });
      }
      if (next.origin !== origin) {
        await drain(response);
        throw upstreamError("Gemini Web redirected outside its origin");
      }
      hops += 1;
      if (hops > GEMINI_WEB_LIMITS.maxRedirects) {
        await drain(response);
        throw upstreamError("Gemini Web exceeded the redirect limit");
      }
      await drain(response);
      current = next;
      continue;
    }

    return { response, url: current };
  }
}

const UUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export function createGenerationId() {
  return randomUUID().toUpperCase();
}

/**
 * Sign in with a full Cookie header, read the bootstrap tokens, and discover
 * this account's selectable models.
 */
export async function bootstrapGeminiWeb({
  cookieHeader,
  authUser,
  signal,
  proxyOptions,
  transport,
} = {}) {
  const slot = normalizeAuthUser(authUser);
  const fetchImpl = transport || defaultTransport;
  const proxy = { ...(proxyOptions || {}), strictProxy: true };
  throwIfAborted(signal);

  const normalizedCookie = normalizeCookieHeader(cookieHeader);
  if (!normalizedCookie) {
    throw geminiWebError("Gemini Web bootstrap requires a cookie session", { status: 401 });
  }

  const jar = new Map();
  for (const [name, value] of parseCookiePairs(normalizedCookie)) jar.set(name, value);

  const browserHeaders = {
    accept: HTML_ACCEPT,
    "accept-language": "en-US,en;q=0.9",
    "user-agent": GEMINI_WEB_USER_AGENT,
  };

  // 1. Public warm-up: rollout cookies only, never the account session.
  try {
    const warm = await fetchImpl(
      GEMINI_WEB_ENDPOINTS.google,
      {
        method: "GET",
        headers: { accept: "*/*", "user-agent": GEMINI_WEB_USER_AGENT },
        redirect: "manual",
        strictTls: true,
        maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
        timeoutMs: GEMINI_WEB_LIMITS.bootstrapTimeoutMs,
        signal,
      },
      proxy
    );
    absorbCookies(jar, warm);
    await drain(warm);
  } catch (error) {
    throwIfAborted(signal);
    if (error?.name === "AbortError") throw error;
    // The warm-up is optional: a rollout-cookie failure must not block a
    // session that the Gemini application itself accepts.
  }

  // 2. Prime the root page so the browser-session cookies match a real tab.
  const root = await followGeminiRedirects({
    startUrl: `${GEMINI_WEB_GEMINI_PREFIX}?hl=en`,
    fetchImpl,
    proxyOptions: proxy,
    signal,
    jar,
    baseHeaders: browserHeaders,
  });
  await drain(root.response);

  // 3. The account-scoped application page.
  const app = await followGeminiRedirects({
    startUrl: `${geminiAccountUrl(GEMINI_WEB_ENDPOINTS.app, slot)}?hl=en`,
    fetchImpl,
    proxyOptions: proxy,
    signal,
    jar,
    baseHeaders: { ...browserHeaders, referer: `${GEMINI_WEB_GEMINI_PREFIX}` },
  });

  if (app.response.status === 401 || app.response.status === 403 || app.response.status === 429) {
    await drain(app.response);
    throw statusError(app.response, "bootstrap");
  }
  if (!app.response.ok) {
    await drain(app.response);
    throw statusError(app.response, "bootstrap");
  }

  const expectedPath = geminiSourcePath(slot);
  if (app.url.pathname !== expectedPath) {
    await drain(app.response);
    throw geminiWebError(
      slot === ""
        ? "Gemini Web moved the default session away from /app"
        : `Gemini Web did not stay on account slot ${slot}`,
      { status: 400 }
    );
  }

  const body = await readGeminiWebBodyText(app.response, GEMINI_WEB_LIMITS.maxFrameBytes);
  const at = firstMatch(body, TOKEN_PATTERNS.at);
  if (!at) {
    throw geminiWebError("Gemini Web session is not signed in", { status: 401 });
  }

  const language = firstMatch(body, TOKEN_PATTERNS.language) || GEMINI_WEB_DEFAULT_LANGUAGE;
  const generationId = createGenerationId();
  const session = {
    cookieHeader: cookieHeaderFromJar(jar),
    at,
    pushId: firstMatch(body, TOKEN_PATTERNS.pushId) || GEMINI_WEB_DEFAULT_PUSH_ID,
    buildLabel: firstMatch(body, TOKEN_PATTERNS.buildLabel),
    sessionId: firstMatch(body, TOKEN_PATTERNS.sessionId),
    language,
    generationId,
    // Kept on the internal session object only: it never reaches a response,
    // the persisted credential record, or the model catalog.
    apiConsumerKey: readApiConsumerKey(body),
    account: readAccountIdentity(body),
  };

  const models = await fetchGeminiWebModels(session, {
    authUser: slot,
    signal,
    proxyOptions: proxy,
    transport,
  });

  return { ...session, models };
}

function validateModelRouting(model) {
  const invalid = (reason) =>
    geminiWebError(`Gemini Web model routing is incomplete: ${reason}`, { status: 400 });
  if (!model || typeof model !== "object") throw invalid("missing model record");
  if (typeof model.id !== "string" || !model.id.trim()) throw invalid("missing public id");
  if (typeof model.modelId !== "string" || !model.modelId.trim()) {
    throw invalid("missing internal model id");
  }
  if (!Number.isInteger(model.modelNumber) || model.modelNumber <= 0) {
    throw invalid("missing model number");
  }
  if (!Number.isInteger(model.capacity) || model.capacity <= 0) throw invalid("missing capacity");
  if (model.capacityField !== 12 && model.capacityField !== 13) {
    throw invalid("missing capacity field");
  }
}

export function buildGenerateInner({ prompt, files = [], modelNumber, language, requestId, thinkingLevel }) {
  const inner = new Array(81);
  const fileData = files.map((file) => [[file.id], file.name]);
  inner[0] = fileData.length > 0
    ? [prompt, 0, null, fileData, null, null, 0]
    : [prompt];
  inner[1] = [language];
  // Every generation sends blank conversation metadata so two unrelated
  // requests can never continue each other's hidden Google thread.
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [1];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = requestId;
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelNumber;
  inner[80] = thinkingLevel;
  return inner;
}

export function buildGeminiModelHeaders(model, requestId, generationId, thinkingLevel) {
  const offset = model.capacityField - 12;
  const header = new Array(17 + offset);
  header[0] = 1;
  header[4] = model.modelId;
  header[7] = 0;
  header[8] = [4, 5, 6, 8];
  header[model.capacityField - 1] = model.capacity;
  header[14 + offset] = model.modelNumber;
  header[15 + offset] = thinkingLevel;
  header[16 + offset] = generationId;
  return {
    [GEMINI_WEB_MODEL_HEADER]: JSON.stringify(header),
    "x-goog-ext-525005358-jspb": JSON.stringify([requestId, 1]),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0,0,0]",
  };
}

function randomRequestId() {
  return randomUUID().toUpperCase();
}

function randomRequestNumber() {
  return Math.floor(Math.random() * 90000) + 10000;
}

function combineSignals(signal, controllerSignal) {
  if (!signal) return controllerSignal;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, controllerSignal]);
  }
  const controller = new AbortController();
  const forward = (source) => () => controller.abort(source.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", forward(signal), { once: true });
  if (controllerSignal.aborted) controller.abort(controllerSignal.reason);
  else controllerSignal.addEventListener("abort", forward(controllerSignal), { once: true });
  return controller.signal;
}

async function withTimeout(fn, signal, timeoutMs, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${what} timed out`)), timeoutMs);
  try {
    return await fn(combineSignals(signal, controller.signal));
  } catch (error) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (controller.signal.aborted) throw upstreamError(`Gemini Web ${what} timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One deadline and one cancellation scope for a whole turn. Every send, poll
 * and body read of that turn shares this signal, so a channel that rolls over
 * cannot restart the budget, and a caller abort reaches whatever request is
 * outstanding at that moment.
 */
function createTurnScope(signal, timeoutMs) {
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort(new Error("Gemini Web generation timed out"));
  }, timeoutMs);
  return {
    signal: combineSignals(signal, deadline.signal),
    failure(error) {
      if (signal?.aborted) return abortError(signal.reason);
      if (timedOut) return upstreamError("Gemini Web generation timed out");
      return error;
    },
    close() {
      clearTimeout(timer);
    },
  };
}

async function generateGeminiWebProcessSession({
  session,
  authUser,
  model,
  prompt,
  thinkingLevel,
  signal,
  proxyOptions,
  transport,
  botguard,
  onDispatch,
}) {
  const slot = normalizeAuthUser(authUser);
  const language = session.language || GEMINI_WEB_DEFAULT_LANGUAGE;
  const requestId = randomRequestId();
  const generationId = UUID_PATTERN.test(String(session.generationId || ""))
    ? session.generationId
    : createGenerationId();
  const fetchImpl = transport || defaultTransport;
  const proxy = { ...(proxyOptions || {}), strictProxy: true };
  const headers = {
    ...GEMINI_WEB_DEFAULT_HEADERS,
    cookie: session.cookieHeader,
    referer: `${GEMINI_WEB_GEMINI_PREFIX}${slot ? `u/${slot}/` : ""}app`,
  };

  const openRid = randomBindRid();
  const attestation = botguard;


  // The API consumer key identifies this client to the ProcessSession service.
  // Without it the channel has no caller identity, so a ProcessSession turn fails
  // as preparation before dispatch instead of spending a generation on a call
  // the service is guaranteed to reject.
  const apiConsumerKey =
    typeof session.apiConsumerKey === "string" ? session.apiConsumerKey.trim() : "";
  if (!apiConsumerKey) {
    throw geminiWebError(
      "Gemini Web session is missing the API consumer key that ProcessSession models require; re-bootstrap the account",
      { status: 502 }
    );
  }

  // One turn owns one deadline and one cancellation scope: the channel open,
  // the send and every poll share them, so no stage restarts a budget and the
  // model-test deadline covers the whole operation.
  const turn = createTurnScope(signal, GEMINI_WEB_LIMITS.generationTimeoutMs);
  let firstPoll = null;
  let handedOffResponse = false;

  try {
    const openResponse = await fetchImpl(
      processSessionUrl({
        authUser: slot,
        rid: openRid,
        cookieHeader: session.cookieHeader,
        mode: "open",
        apiKey: apiConsumerKey,
      }),
      {
        method: "POST",
        headers,
        body: "count=0",
        redirect: "manual",
        strictTls: true,
        maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
        forceFreshSocket: true,
        signal: turn.signal,
      },
      proxy
    );
    if (openResponse.status >= 300 && openResponse.status < 400) {
      await drain(openResponse);
      throw upstreamError("Gemini Web ProcessSession returned an unexpected redirect");
    }
    if (!openResponse.ok) return openResponse;

    const openText = await readGeminiWebBodyText(
      openResponse,
      GEMINI_WEB_LIMITS.modelResponseBytes
    );
    const channel = parseBrowserChannelOpen(openText);
    const gsessionid =
      openResponse.headers?.get?.("x-http-session-id") ||
      openResponse.headers?.["x-http-session-id"];
    if (!channel?.sid || !gsessionid) {
      throw upstreamError("Gemini Web ProcessSession did not open a Bind channel");
    }

    const req0 = encodeProcessSessionReq0({
      modelId: model.modelId,
      language,
      generationId,
      requestId,
      modelNumber: model.modelNumber,
      thinkingLevel,
      botguardToken: attestation?.token,
      botguardHash: attestation?.hash,
    });
    const req1 = encodeProcessSessionReq1(typeof prompt === "string" ? prompt : "");
    const form = new URLSearchParams({
      count: "2",
      ofs: "0",
      req0___data__: protoToBase64(req0),
      req1___data__: protoToBase64(req1),
    }).toString();

    // The receive poll is issued before the turn is posted and is never
    // awaited here, so a poll whose headers are still pending cannot delay the
    // send. The settle promise is already normalized, so a late failure can
    // never surface as an unhandled rejection.
    const startReceive = (aid) => {
      const controller = new AbortController();
      const settle = (async () => {
        try {
          const response = await fetchImpl(
            processSessionUrl({
              authUser: slot,
              rid: "rpc",
              sid: channel.sid,
              gsessionid,
              cookieHeader: session.cookieHeader,
              mode: "rpc",
              aid,
            }),
            {
              method: "GET",
              headers,
              redirect: "manual",
              strictTls: true,
              maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
              forceFreshSocket: true,
              signal: combineSignals(turn.signal, controller.signal),
            },
            proxy
          );
          return { ok: true, response };
        } catch (error) {
          return { ok: false, error: turn.failure(error) };
        }
      })();
      return {
        settle: () => settle,
        abandon: () => {
          controller.abort(new Error("Gemini Web Bind receive abandoned"));
          void settle.then((outcome) => {
            if (outcome.ok) void drain(outcome.response);
          });
        },
      };
    };

    // The browser arms the receive channel first and posts the turn without
    // waiting for the poll's headers; only the POST can consume a generation.
    firstPoll = startReceive(0);

    // Opening the Bind channel does not consume a turn; posting req0/req1
    // does. Everything after this point must never be replayed on another
    // account.
    onDispatch?.();

    const sendResponse = await fetchImpl(
      processSessionUrl({
        authUser: slot,
        rid: openRid + 1,
        sid: channel.sid,
        gsessionid,
        cookieHeader: session.cookieHeader,
        mode: "send",
      }),
      {
        method: "POST",
        headers,
        body: form,
        redirect: "manual",
        strictTls: true,
        maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
        forceFreshSocket: true,
        signal: turn.signal,
      },
      proxy
    );
    if (sendResponse.status >= 300 && sendResponse.status < 400) {
      await drain(sendResponse);
      throw upstreamError("Gemini Web ProcessSession returned an unexpected redirect");
    }
    if (!sendResponse.ok) {
      // A rejected send is the turn's outcome; the armed receive has no owner.
      return sendResponse;
    }

    const sendText = await readGeminiWebBodyText(sendResponse, GEMINI_WEB_LIMITS.maxFrameBytes);
    if (sendText.includes("wrb.fr")) {
      return new Response(sendText, { status: 200 });
    }

    const answer = extractProcessSessionAnswer(sendText);
    if (answer) {
      return new Response(streamBodyFromAnswerText(answer), { status: 200 });
    }

    // A 200 ACK can still carry the channel's explicit rejection; report it
    // with its own status before waiting on a poll that will never answer.
    const sendFailure = extractProcessSessionFailure(sendText);
    if (sendFailure) throw sendFailure;

    const outcome = await readBindChannel({
      firstPoll,
      startPoll: startReceive,
      signal: turn.signal,
      limit: GEMINI_WEB_LIMITS.maxFrameBytes,
    });
    if (outcome.rejected) {
      // The turn POST was already accepted, so a rejection while reading its
      // channel is evidence the generation may have been consumed. Mark the
      // response so the executor never offers it to another account, even when
      // the status alone would look like a plain rejection.
      handedOffResponse = true;
      return markNonReplayableResponse(outcome.rejected);
    }
    const body = outcome.rawText ?? outcome.body;
    if (!body) throw upstreamError("Gemini Web ProcessSession completed without an answer");
    return new Response(body, { status: 200 });
  } catch (error) {
    // One classification point for the whole operation: a stalled header, a
    // stalled body read or a poll failure surfaces the same way, so the turn's
    // own deadline is never mistaken for the caller cancelling.
    throw turn.failure(error);
  } finally {
    turn.close();
    // A response handed to the executor still owns its body; every other exit
    // leaves the armed receive with no reader, so it must be released here.
    if (!handedOffResponse) firstPoll?.abandon();
  }
}

/** Build and dispatch one native StreamGenerate request. */
export async function generateGeminiWeb({
  session,
  authUser,
  model,
  prompt,
  files = [],
  task = GEMINI_WEB_TASK.CHAT,
  thinkingLevel,
  signal,
  proxyOptions,
  transport,
  botguard,
  onDispatch,
} = {}) {
  const slot = normalizeAuthUser(authUser);
  const level = resolveThinkingLevel(thinkingLevel);
  validateModelRouting(model);
  throwIfAborted(signal);

  if (!session || typeof session !== "object" || !session.at || !session.cookieHeader) {
    throw geminiWebError("Gemini Web session is not initialized", { status: 502 });
  }

  const lane = selectGeminiTransport({ model, files, task });
  if (lane === GEMINI_WEB_TRANSPORT.PROCESS_SESSION) {
    return generateGeminiWebProcessSession({
      session,
      authUser: slot,
      model,
      prompt,
      thinkingLevel: level,
      signal,
      proxyOptions,
      transport,
      botguard,
      onDispatch,
    });
  }
  const language = session.language || GEMINI_WEB_DEFAULT_LANGUAGE;
  const requestId = randomRequestId();
  const generationId = UUID_PATTERN.test(String(session.generationId || ""))
    ? session.generationId
    : createGenerationId();

  const inner = buildGenerateInner({
    prompt: typeof prompt === "string" ? prompt : "",
    files,
    modelNumber: model.modelNumber,
    language,
    requestId,
    thinkingLevel: level,
  });

  const query = new URLSearchParams({
    at: session.at,
    hl: language,
    _reqid: String(randomRequestNumber()),
    rt: "c",
  });
  if (session.buildLabel) query.set("bl", session.buildLabel);
  if (session.sessionId) query.set("f.sid", session.sessionId);

  const url = `${geminiAccountUrl(GEMINI_WEB_ENDPOINTS.generate, slot)}?${query.toString()}`;
  const headers = {
    ...GEMINI_WEB_DEFAULT_HEADERS,
    cookie: session.cookieHeader,
    ...buildGeminiModelHeaders(model, requestId, generationId, level),
  };
  const form = new URLSearchParams({
    at: session.at,
    "f.req": JSON.stringify([null, JSON.stringify(inner)]),
  }).toString();

  const fetchImpl = transport || defaultTransport;
  const proxy = { ...(proxyOptions || {}), strictProxy: true };

  const response = await withTimeout(
    (combinedSignal) => {
      // This POST is the boundary that can consume a generation.
      onDispatch?.();
      return fetchImpl(
        url,
        {
          method: "POST",
          headers,
          body: form,
          redirect: "manual",
          strictTls: true,
          maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
          forceFreshSocket: true,
          timeoutMs: GEMINI_WEB_LIMITS.generationTimeoutMs,
          signal: combinedSignal,
        },
        proxy
      );
    },
    signal,
    GEMINI_WEB_LIMITS.generationTimeoutMs,
    "generation"
  );

  if (response.status >= 300 && response.status < 400) {
    await drain(response);
    throw upstreamError("Gemini Web generation returned an unexpected redirect");
  }
  return response;
}
