// Gemini Web model discovery: GetUserStatus over batchexecute.
//
// Ported from gemini-web-to-api (MIT). See LICENSE in this directory.
// Copyright (c) 2025 Nguyễn Tuấn Thành

import {
  GEMINI_WEB_DEFAULT_HEADERS,
  GEMINI_WEB_DEFAULT_LANGUAGE,
  GEMINI_WEB_ENDPOINTS,
  GEMINI_WEB_LIMITS,
  GEMINI_WEB_MODEL_HEADER,
  GEMINI_WEB_USER_STATUS_RPC,
  geminiAccountUrl,
  geminiSourcePath,
  geminiWebError,
  normalizeAuthUser,
  parseRetryAfter,
  throwIfAborted,
  upstreamError,
} from "./config.js";
import { isJsonWhitespace, scanJsonValue } from "./stream.js";
import { fetchGeminiWeb as defaultTransport, readGeminiWebBodyText } from "./transport.js";

const GEMINI_AUTO_MODEL_ID = "gemini-auto";
const SLUG_SEPARATOR = /[^a-z0-9.]+/g;


/**
 * Decode a batchexecute body into its JSON values. The endpoint prefixes an
 * XSSI guard and interleaves standalone numeric length records; decoding
 * values instead of splitting lines also accepts multiline frames.
 */
function parseJsonSequence(raw) {
  let text = String(raw ?? "");
  const guard = /^\s*\)\]\}'\s*\r?\n/.exec(text);
  if (guard) text = text.slice(guard[0].length);
  else text = text.replace(/^\s*\)\]\}'/, "");

  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && isJsonWhitespace(text[index])) index += 1;
    if (index >= text.length) break;
    const end = scanJsonValue(text, index);
    if (end < 0) {
      throw upstreamError("Gemini model discovery returned an incomplete frame");
    }
    let value;
    try {
      value = JSON.parse(text.slice(index, end));
    } catch {
      throw upstreamError("Gemini model discovery returned invalid JSON");
    }
    index = end;
    if (typeof value === "number") continue;
    values.push(value);
  }
  return values;
}

function collectRecords(value, records) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "string") {
    const marker = value[0];
    if (marker === "wrb.fr" || marker === "er") {
      if (value[1] === GEMINI_WEB_USER_STATUS_RPC) records.push(value);
      return;
    }
  }
  for (const item of value) collectRecords(item, records);
}

function integerValue(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function hasFlag(values, wanted) {
  if (!Array.isArray(values)) return false;
  return values.some((flag) => integerValue(flag) === wanted);
}

/**
 * Capacity/field priority mirrors Gemini-API's AvailableModel.compute_capacity:
 * the account's flags, not the public model name, decide its routing capacity.
 */
function accountCapacity(tiersValue, capabilitiesValue) {
  const tiers = Array.isArray(tiersValue) ? tiersValue : [];
  const capabilities = Array.isArray(capabilitiesValue) ? capabilitiesValue : [];
  if (hasFlag(tiers, 21)) return { capacity: 1, capacityField: 13 };
  if (hasFlag(tiers, 22)) return { capacity: 2, capacityField: 13 };
  if (hasFlag(capabilities, 115)) return { capacity: 4, capacityField: 12 };
  if (hasFlag(tiers, 16) || hasFlag(capabilities, 106)) {
    return { capacity: 3, capacityField: 12 };
  }
  if (hasFlag(tiers, 8) || hasFlag(capabilities, 19)) {
    return { capacity: 2, capacityField: 12 };
  }
  return { capacity: 1, capacityField: 12 };
}

function slugify(value) {
  return String(value).trim().toLowerCase().replace(SLUG_SEPARATOR, "-").replace(/^-+|-+$/g, "");
}

function withGeminiPrefix(value) {
  return value.startsWith("gemini-") ? value : `gemini-${value}`;
}

function publicModelName(modelId, category, display) {
  const nameSource = display || category;
  if (!nameSource) return withGeminiPrefix(String(modelId).toLowerCase());
  return withGeminiPrefix(slugify(nameSource).replace(/^gemini-/, ""));
}

function entryField(entry, index) {
  return index < entry.length ? entry[index] : undefined;
}

function firstEntryString(entry, indexes) {
  for (const index of indexes) {
    const value = entryField(entry, index);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function decodeUserStatus(raw) {
  if (typeof raw === "string") {
    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw upstreamError("Gemini model discovery returned an invalid user status");
    }
    if (!Array.isArray(decoded)) {
      throw upstreamError("Gemini model discovery returned an invalid user status");
    }
    return decoded;
  }
  if (Array.isArray(raw)) return raw;
  throw upstreamError("Gemini model discovery returned no user status");
}

/**
 * Parse a GetUserStatus response into private routing records. A model name
 * alone cannot select a model; the account's internal ID, capacity and model
 * number must all be present.
 */
export function parseGeminiModels(raw) {
  const records = [];
  for (const value of parseJsonSequence(raw)) collectRecords(value, records);

  const models = [];
  const skipped = [];
  const seenModelIds = new Set();
  const publicNames = new Set();

  const skip = (reason, entry) => {
    let encoded;
    try {
      encoded = JSON.stringify(entry);
    } catch {
      encoded = String(entry);
    }
    if (encoded.length > 300) encoded = `${encoded.slice(0, 300)}...`;
    skipped.push(`${reason}: ${encoded}`);
  };

  for (const record of records) {
    const rejected = entryField(record, 5);
    if (Array.isArray(rejected)) {
      const code = integerValue(rejected[0]);
      if (code !== null && code !== 0) {
        throw upstreamError(`Gemini model discovery rejected the session (code ${code})`);
      }
    }

    const status = decodeUserStatus(entryField(record, 2));
    const accountStatus = entryField(status, 14);
    if (accountStatus !== undefined && accountStatus !== null) {
      const code = integerValue(accountStatus);
      if (code === null) {
        throw upstreamError("Gemini model discovery returned an invalid account status");
      }
      if (code !== 1000) {
        throw upstreamError(
          `Gemini account cannot select models (status ${code}); verify access and cookies on Gemini Web`
        );
      }
    }

    const { capacity, capacityField } = accountCapacity(
      entryField(status, 16),
      entryField(status, 17)
    );
    const entries = entryField(status, 15);
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!Array.isArray(entry)) {
        skip("entry is not a list", entry);
        continue;
      }
      const modelId = firstEntryString(entry, [0]);
      if (!modelId) {
        skip("entry has no model ID", entry);
        continue;
      }
      if (seenModelIds.has(modelId)) {
        skip("duplicate model ID", entry);
        continue;
      }

      const category = firstEntryString(entry, [1, 10]);
      const display = firstEntryString(entry, [11, 19, 1]);
      let name = publicModelName(modelId, category, display);
      if (publicNames.has(name)) name = `${name}-${modelId.slice(0, 8).toLowerCase()}`;

      const rawNumber = entryField(entry, 17) ?? entryField(entry, 9);
      let modelNumber = 1;
      if (rawNumber !== undefined && rawNumber !== null) {
        const parsed = integerValue(rawNumber);
        if (parsed === null || parsed <= 0) {
          skip("invalid model number", entry);
          continue;
        }
        modelNumber = parsed;
      }

      models.push({ id: name, name: display, modelId, modelNumber, capacity, capacityField });
      seenModelIds.add(modelId);
      publicNames.add(name);
    }
  }

  if (models.length === 0) {
    if (skipped.length > 0) {
      throw upstreamError(
        `Gemini model discovery returned no usable models; skipped ${skipped.join("; ")}`
      );
    }
    throw upstreamError("Gemini model discovery returned no available models");
  }

  return { models, skipped };
}

/**
 * Resolve a requested public name against this account's registry.
 *
 * Missing and ambiguous names are 404 so the account-routing loop can try
 * another slot; the account default is never substituted.
 */
export function resolveGeminiModel(requested, models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw geminiWebError("No Gemini Web models are available for this account", {
      status: 404,
    });
  }
  const wanted = String(requested ?? "").trim().toLowerCase();
  if (!wanted) {
    throw geminiWebError("A Gemini Web model must be selected explicitly", { status: 404 });
  }
  const lookup = wanted === "gemini-advanced" ? "gemini-pro" : wanted;
  const matchesFor = (matcher) =>
    models.filter((model) => {
      const names = [model.id, model.name, model.modelId]
        .filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase());
      return names.some(matcher);
    });

  let matches = matchesFor((name) => name === lookup);
  if (matches.length === 0) {
    matches = models.filter((model) => model.modelId?.toLowerCase() === lookup);
  }
  if (matches.length === 1) return matches[0];

  const available = models.map((model) => model.id).join(", ");
  if (matches.length > 1) {
    throw geminiWebError(
      `Ambiguous Gemini Web model "${requested}"; available models: ${available}`,
      { status: 404 }
    );
  }
  const hasAuto = models.some((model) => model.id.toLowerCase() === GEMINI_AUTO_MODEL_ID);
  const hint = hasAuto
    ? `. With ${GEMINI_AUTO_MODEL_ID}, Gemini Web chooses the model itself; request ${GEMINI_AUTO_MODEL_ID} and set the thinking level for depth`
    : "";
  throw geminiWebError(
    `Unsupported Gemini Web model "${requested}"; available models: ${available}${hint}`,
    { status: 404 }
  );
}

/**
 * Query GetUserStatus with the account's authenticated session and slot.
 * Returns private routing records; callers keep them out of public responses.
 */
export async function fetchGeminiWebModels(
  session,
  { authUser, signal, proxyOptions, transport } = {}
) {
  const slot = normalizeAuthUser(authUser);
  throwIfAborted(signal);
  if (!session || typeof session !== "object" || !session.at || !session.cookieHeader) {
    throw upstreamError("Gemini model discovery requires an authenticated session");
  }

  const language = session.language || GEMINI_WEB_DEFAULT_LANGUAGE;
  const query = new URLSearchParams({
    rpcids: GEMINI_WEB_USER_STATUS_RPC,
    hl: language,
    _reqid: String(Math.floor(Math.random() * 90000) + 10000),
    rt: "c",
    "source-path": geminiSourcePath(slot),
  });
  if (session.buildLabel) query.set("bl", session.buildLabel);
  if (session.sessionId) query.set("f.sid", session.sessionId);

  const url = `${geminiAccountUrl(GEMINI_WEB_ENDPOINTS.batchExec, slot)}?${query.toString()}`;
  const batchHeader = new Array(17);
  batchHeader[0] = 1;
  batchHeader[8] = [4, 5, 6, 8];
  batchHeader[16] = session.generationId;

  const headers = {
    ...GEMINI_WEB_DEFAULT_HEADERS,
    cookie: session.cookieHeader,
    [GEMINI_WEB_MODEL_HEADER]: JSON.stringify(batchHeader),
    "x-goog-ext-73010989-jspb": "[0]",
  };
  const body = new URLSearchParams({
    at: session.at,
    "f.req": `[[["${GEMINI_WEB_USER_STATUS_RPC}","[]",null,"generic"]]]`,
  }).toString();

  const fetchImpl = transport || defaultTransport;
  const proxy = { ...(proxyOptions || {}), strictProxy: true };

  let response;
  try {
    response = await fetchImpl(
      url,
      {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        strictTls: true,
        maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
        timeoutMs: GEMINI_WEB_LIMITS.bootstrapTimeoutMs,
        signal,
      },
      proxy
    );
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }

  if (response.status === 401 || response.status === 403 || response.status === 429) {
    await response.body?.cancel?.().catch?.(() => {});
    throw geminiWebError(
      `Gemini model discovery was rejected with HTTP ${response.status}`,
      {
        status: response.status,
        retryAfter: parseRetryAfter(response.headers?.get?.("retry-after")),
      }
    );
  }
  if (!response.ok) {
    await response.body?.cancel?.().catch?.(() => {});
    throw upstreamError(`Gemini model discovery failed with HTTP ${response.status}`);
  }

  const text = await readGeminiWebBodyText(response, GEMINI_WEB_LIMITS.modelResponseBytes);
  return parseGeminiModels(text).models;
}
