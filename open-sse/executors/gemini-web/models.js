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

/** Native generation lanes: one ProcessSession Bind turn, or one StreamGenerate POST. */
export const GEMINI_WEB_TRANSPORT = Object.freeze({
  PROCESS_SESSION: "processSession",
  STREAM_GENERATE: "streamGenerate",
});

/** What the caller is generating. Image tasks use their own prompt and model choice. */
export const GEMINI_WEB_TASK = Object.freeze({ CHAT: "chat", IMAGE: "image" });

/**
 * The one place that decides how a resolved model is generated.
 *
 * The choice follows what each surface can carry, not which model it is.
 * ProcessSession owns text-only chat: it reports the turn's own completion
 * flags, whereas StreamGenerate leaves some selectors pending without ever
 * reporting completion, so a text turn there can only end at the deadline.
 * StreamGenerate owns everything else, because its payload carries the uploaded
 * file slots and the generated-media slots that the ProcessSession encoders do
 * not. That media rule is checked first for the image task: a policy code
 * picked by the image task must still reach the media-capable surface.
 *
 * Policy codes stay channel-only. They are published only inside the channel's
 * own model group, so there is no verified StreamGenerate form of them; when
 * the bootstrap identity is missing the preparation error is the honest answer
 * rather than an unverified request. A policy chat turn that carries uploads is
 * refused by the executor rather than encoded without them. For every other
 * model a missing identity falls back to StreamGenerate, because a slower text
 * lane beats refusing every text model when one bootstrap token moves.
 */
export function selectGeminiTransport({
  model,
  files = [],
  task = GEMINI_WEB_TASK.CHAT,
  channelIdentity = true,
} = {}) {
  if (task !== GEMINI_WEB_TASK.CHAT) return GEMINI_WEB_TRANSPORT.STREAM_GENERATE;
  if (model?.policy === true) return GEMINI_WEB_TRANSPORT.PROCESS_SESSION;
  if (!Array.isArray(files) || files.length > 0) return GEMINI_WEB_TRANSPORT.STREAM_GENERATE;
  if (!channelIdentity) return GEMINI_WEB_TRANSPORT.STREAM_GENERATE;
  return GEMINI_WEB_TRANSPORT.PROCESS_SESSION;
}


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

function policyCodeModels(status, capacity, capacityField, seenModelIds, publicNames, skip) {
  const policy = entryField(status, 24);
  if (!Array.isArray(policy)) return [];
  const groups = entryField(policy, 1);
  if (!Array.isArray(groups)) return [];

  const added = [];
  for (const group of groups) {
    if (!Array.isArray(group) || !Array.isArray(group[0])) continue;
    const head = group[0];
    const code = firstEntryString(head, [3]);
    if (!code) continue;
    if (seenModelIds.has(code)) {
      skip("duplicate model ID", head);
      continue;
    }
    const modelNumber = integerValue(entryField(head, 1));
    if (modelNumber === null || modelNumber <= 0) {
      skip("invalid model number", head);
      continue;
    }
    const category = firstEntryString(head, [4, 5]);
    const display = firstEntryString(head, [12, 5, 4]);
    let name = publicModelName(code, category, display);
    if (publicNames.has(name)) name = `${name}-${code.slice(0, 8).toLowerCase()}`;
    added.push({
      id: name,
      name: display,
      modelId: code,
      modelNumber,
      capacity,
      capacityField,
      policy: true,
    });
    seenModelIds.add(code);
    publicNames.add(name);
  }
  return added;
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
    models.push(
      ...policyCodeModels(status, capacity, capacityField, seenModelIds, publicNames, skip)
    );
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
