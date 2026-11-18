// GeminiWebExecutor — Gemini Web session provider (native protocol).
//
// Routes requests through Gemini's own web endpoints using the account cookie
// jar plus one Google account slot, and exposes the result as OpenAI chat
// completions or generated image bytes. No browser is launched per request.
//
// Auth: full Cookie request header (__Secure-1PSID + __Secure-1PSIDTS) shared
// by every slot of that browser session; the slot selects the Google account.
// Execution is stateless: the whole message history is sent as one prompt and
// every generation starts a fresh Google turn. OpenAI function tools go through
// the prompt tool bridge (gemini-web/toolBridge.js); a bridged reply is read in
// full before it is returned, also when the client streams.

import { randomUUID } from "node:crypto";

import { BaseExecutor } from "./base.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { FORMATS } from "../translator/formats.js";
import { extractThinking, parseSuffix } from "../translator/concerns/thinkingUnified.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { markNonReplayableResponse, isNonReplayableResponse } from "../utils/replayPolicy.js";
import {
  GEMINI_WEB_ORIGIN,
  GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
  GEMINI_WEB_UPSTREAM_ERROR_CODE,
  geminiWebError,
  parseRetryAfter,
  unsupportedControl,
  upstreamError,
} from "./gemini-web/config.js";
import { checkGeminiWebUnsupportedControls } from "./gemini-web/capabilities.js";
import { buildImagePrompt } from "./gemini-web/imageGen.js";
import {
  assertGeminiWebInputImageBudget,
  decodeGeminiWebImageDataUrl,
  downloadGeminiWebImage,
  uploadGeminiWebImage,
} from "./gemini-web/media.js";
import { GEMINI_WEB_TASK, resolveGeminiModel } from "./gemini-web/models.js";
import {
  buildJSONModePrompt,
  parseResponseFormat,
  repairJSONPrompt,
  validateJSONReply,
} from "./gemini-web/jsonMode.js";
import {
  GEMINI_WEB_INVALID_TOOL_CALL_CODE,
  MAX_TOOL_BRIDGE_ATTEMPTS,
  buildToolBridgePrompt,
  parseToolBridge,
  parseToolBridgeOutput,
  toolBridgeRetryPrompt,
} from "./gemini-web/toolBridge.js";
import { generateGeminiWeb } from "./gemini-web/protocol.js";
import {
  publicGeminiWebModels,
  resolveGeminiWebSession,
  resetGeminiWebSessionCache,
} from "./gemini-web/session.js";
import { decodeGeminiWebStream } from "./gemini-web/stream.js";

export { resetGeminiWebSessionCache };

/** Client-facing endpoint when a request could not reach Google. */
const GEMINI_WEB_CLIENT_URL = `${GEMINI_WEB_ORIGIN}/app`;

const ABORT_CODE = "request_aborted";
const MODEL_NOT_FOUND_CODE = "model_not_found";
const MODEL_MISMATCH_CODE = "upstream_model_mismatch";
const NO_IMAGE_CODE = "gemini_web_no_image";

export const GEMINI_WEB_VERIFICATION_UNKNOWN = "GEMINI_WEB_VERIFICATION_UNKNOWN";

// ─── Request shaping ────────────────────────────────────────────────────────

function imageUrlOf(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type !== "image_url" && part.type !== "input_image" && part.type !== "image") {
    return null;
  }
  const raw = part.image_url;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof raw.url === "string") return raw.url;
  if (typeof part.url === "string") return part.url;
  return null;
}

/**
 * Flatten one message's content into text, replacing each image part with a
 * stable `[Image N]` marker at its own position. Only a user turn may carry
 * images; anything else has no upload target.
 */
function flattenContent(content, images, allowImages) {
  if (typeof content === "string") return content.trim() ? content : "";
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text") {
      if (typeof part.text === "string" && part.text) parts.push(part.text);
      continue;
    }
    if (!allowImages) continue;
    const url = imageUrlOf(part);
    if (url === null) continue;
    images.push(url);
    parts.push(`[Image ${images.length}]`);
  }
  return parts.join(" ").trim();
}

function toolArgumentsText(value) {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

/** An earlier assistant tool call, written the way gemini-web-to-api renders it. */
function toolCallText(call) {
  const fn = call?.function || {};
  return `[Call Tool: ${fn.name ?? ""} with ID ${call?.id ?? ""} and Input: ${toolArgumentsText(fn.arguments)}]`;
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return flattenContent(content, [], false);
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

/**
 * One message as prompt text. Gemini Web only sees text, so an assistant's
 * tool calls and a tool result are written out; a tool result speaks as the
 * user, as in gemini-web-to-api.
 */
function turnOf(message, images) {
  if (message.role === "tool") {
    const content = `[Tool Result for ID ${message.tool_call_id ?? ""}]: ${toolResultText(message.content)}`;
    return { role: "user", content };
  }
  const text = flattenContent(message.content, images, message.role === "user");
  const calls = message.role === "assistant" && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return { role: message.role, content: [text, ...calls.map(toolCallText)].filter(Boolean).join("\n") };
}

/**
 * Flatten the whole message list once, so the prompt and the upload list can
 * never disagree about image order or numbering.
 */
function flattenMessages(messages) {
  const images = [];
  const turns = [];
  let hasUserTurn = false;

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const turn = turnOf(message, images);
    if (message.role === "user" && turn.content) hasUserTurn = true;
    if (!turn.content) continue;
    turns.push(turn);
  }

  return { turns, images, hasUserTurn };
}

function promptFromTurns(turns) {
  const userTurns = turns.filter((turn) => turn.role === "user");
  const lastUser = userTurns[userTurns.length - 1];
  const lastUserContent = lastUser?.content ?? "";
  const lastUserIdx = lastUser ? turns.lastIndexOf(lastUser) : -1;

  const priorTurns = turns.filter(
    (turn, index) => index < lastUserIdx && (turn.role === "user" || turn.role === "assistant")
  );
  const systemText = turns
    .filter((turn) => turn.role === "system")
    .map((turn) => turn.content)
    .join("\n\n");

  // Single-turn without a system message: the message is the prompt verbatim.
  if (priorTurns.length === 0 && !systemText) return lastUserContent;
  if (priorTurns.length === 0) return `System:\n${systemText}\n\n${lastUserContent}`;

  const parts = [];
  if (systemText) parts.push(`System:\n${systemText}`);
  parts.push(
    `Previous conversation:\n${priorTurns
      .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.content}`)
      .join("\n\n")}`
  );
  parts.push(`Current user message:\n${lastUserContent}`);
  return parts.join("\n\n");
}

/**
 * Flatten the OpenAI-style multi-turn `messages[]` into the single prompt this
 * provider sends. Image parts keep their position as `[Image N]`, numbered in
 * message/part order; the matching uploads use the same numbering.
 */
export function buildGeminiPrompt(messages) {
  return promptFromTurns(flattenMessages(messages).turns);
}

function decodeInputImages(imageUrls) {
  const decoded = [];
  for (const url of imageUrls) {
    try {
      decoded.push(decodeGeminiWebImageDataUrl(url));
    } catch (error) {
      if (Number(error?.status) === 413) throw error;
      throw unsupportedControl(
        error instanceof Error && error.message
          ? error.message
          : "Gemini Web image input is not a supported PNG, JPEG or WebP data URL"
      );
    }
  }
  assertGeminiWebInputImageBudget(decoded.map((image) => image.data.length));
  return decoded;
}

function slotHeaderValue(credentials) {
  const authUser = credentials?.providerSpecificData?.authUser;
  if (authUser === undefined || authUser === null || authUser === "") return "default";
  return String(authUser);
}

function sanitizedBody(model, body, stream) {
  return {
    model,
    messages: Array.isArray(body?.messages) ? body.messages : [],
    stream: Boolean(stream),
  };
}

// ─── Response shaping ───────────────────────────────────────────────────────

function safeMessage(error, fallback = "Gemini Web request failed") {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const message = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return message ? message.slice(0, 400) : fallback;
}

function errorStatus(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status <= 599) return status;
  return 502;
}

function errorCode(status, error) {
  if (typeof error?.code === "string" && error.code) return error.code;
  if (status === 404) return MODEL_NOT_FOUND_CODE;
  if (status >= 500) return GEMINI_WEB_UPSTREAM_ERROR_CODE;
  return GEMINI_WEB_UNSUPPORTED_CONTROL_CODE;
}

function errorResponse(error, { nonReplayable = false } = {}) {
  const status = errorStatus(error);
  const payload = {
    error: {
      message: safeMessage(error),
      type: status >= 500 ? "upstream_error" : "invalid_request_error",
      code: errorCode(status, error),
    },
  };
  if (typeof error?.param === "string" && error.param) payload.error.param = error.param;

  const headers = { "Content-Type": "application/json" };
  if (Number.isFinite(Number(error?.retryAfter))) {
    headers["Retry-After"] = String(Math.max(0, Math.ceil(Number(error.retryAfter))));
  }
  const response = new Response(JSON.stringify(payload), { status, headers });
  return nonReplayable ? markNonReplayableResponse(response) : response;
}

function abortError() {
  return geminiWebError("The Gemini Web request was aborted", {
    status: 499,
    code: ABORT_CODE,
  });
}

function modelNotFoundError(error) {
  if (Number(error?.status) === 404) {
    return geminiWebError(safeMessage(error, "Gemini Web model not found"), {
      status: 404,
      code: MODEL_NOT_FOUND_CODE,
    });
  }
  return error;
}

function modelMismatchError(expected) {
  return geminiWebError(
    `Gemini Web answered with a different model than "${expected}"; refusing to mislabel the result`,
    { status: 502, code: MODEL_MISMATCH_CODE }
  );
}

function noImageError() {
  const error = upstreamError("Gemini Web completed the image request without returning an image");
  error.code = NO_IMAGE_CODE;
  return error;
}

/** A generation that may already have been accepted must never be replayed. */
function isAmbiguousGenerationError(error) {
  const status = Number(error?.status);
  if (status === 400 || status === 401 || status === 403 || status === 429) return false;
  return true;
}

function buildLinkBlock(images) {
  return images
    .map((image, index) => `![Generated image ${index + 1}](<${image.url}>)`)
    .join("\n\n");
}

/**
 * Answer text first, then one Markdown link per distinct generated image. The
 * links are Google-hosted and belong to the same browser session, so they can
 * expire; `/v1/images/generations` remains the portable byte form.
 */
function composeContent(text, images) {
  const parts = [];
  if (typeof text === "string" && text.trim()) parts.push(text);
  if (images.length > 0) parts.push(buildLinkBlock(images));
  return parts.join("\n\n");
}

function usagePayload(usage, requestBody, outputLength) {
  if (usage) {
    return {
      prompt_tokens: usage.promptTokens || 0,
      completion_tokens: usage.completionTokens || 0,
      total_tokens: usage.totalTokens || 0,
    };
  }
  return estimateUsage(requestBody, outputLength, FORMATS.OPENAI);
}

// ─── Dispatch helpers ───────────────────────────────────────────────────────

async function upstreamFailure(response) {
  await response.body?.cancel?.().catch?.(() => {});
  const status = Number(response.status);
  const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"));
  const message =
    status === 401 || status === 403 || status === 429
      ? `Gemini Web generation was rejected with HTTP ${status}`
      : `Gemini Web generation failed with HTTP ${status}`;
  const error = geminiWebError(message, {
    status: Number.isFinite(status) ? status : 502,
    retryAfter,
  });
  // The protocol layer marks a response that arrived after the turn was
  // accepted. That evidence outranks the status-based rejection rule: a 401
  // while reading an accepted turn's channel is not a retryable rejection.
  if (isNonReplayableResponse(response)) error.nonReplayable = true;
  return error;
}

async function collectEvents(body, { signal, knownModelIds }) {
  const state = { text: "", reasoning: "", images: [], usage: null, modelId: null };
  for await (const event of decodeGeminiWebStream(body, { signal, knownModelIds })) {
    if (event.type === "text") state.text = event.text;
    else if (event.type === "reasoning") state.reasoning = event.text;
    else if (event.type === "images") state.images.push(...event.images);
    else if (event.type === "usage") state.usage = event.usage;
    else if (event.type === "model" && event.modelId) state.modelId = event.modelId;
  }
  return state;
}

/**
 * Upload the turn's images and send one generation. Images are uploaded per
 * turn, so a tool-bridge retry sends them again as gemini-web-to-api does.
 */
async function sendGeminiWebTurn({
  resolved,
  routing,
  prompt,
  inputImages,
  thinkingLevel,
  signal,
  proxyOptions,
  transport,
  turn,
}) {
  const files = [];
  for (const [index, image] of inputImages.entries()) {
    const uploaded = await uploadGeminiWebImage(
      resolved.session,
      {
        data: image.data,
        mimeType: image.mime,
        name: `image_${index + 1}.${image.extension}`,
      },
      { signal, proxyOptions, transport }
    );
    files.push(uploaded);
  }

  const upstream = await generateGeminiWeb({
    session: resolved.session,
    authUser: resolved.authUser,
    model: routing,
    prompt,
    files,
    thinkingLevel,
    signal,
    proxyOptions,
    transport,
    onDispatch: () => {
      turn.dispatched = true;
    },
  });
  if (!upstream.ok) throw await upstreamFailure(upstream);
  return upstream;
}

/**
 * The error response for a failed turn. Once Google accepted a turn, or may
 * have, the request must not be replayed on another account.
 */
function turnFailure(error, signal, turn) {
  if (signal?.aborted || error?.name === "AbortError") return errorResponse(abortError());
  return errorResponse(error, { nonReplayable: turn.accepted || mayHaveRun(error, turn) });
}

function mayHaveRun(error, turn) {
  return turn.dispatched && (error?.nonReplayable === true || isAmbiguousGenerationError(error));
}

function invalidToolCallError(reason) {
  return geminiWebError(
    `Gemini Web did not return a valid tool call after ${MAX_TOOL_BRIDGE_ATTEMPTS} attempts: ${reason}`,
    { status: 502, code: GEMINI_WEB_INVALID_TOOL_CALL_CODE }
  );
}

/**
 * Ask Gemini for a tool-bridge reply, and ask again with the reason while the
 * reply has no usable tool call. A call is never made up: after the last
 * attempt the request fails with 502, as in gemini-web-to-api.
 */
async function runToolBridge({ bridge, prompt, readTurn, log }) {
  let attemptPrompt = prompt;
  let reason;
  for (let attempt = 1; attempt <= MAX_TOOL_BRIDGE_ATTEMPTS; attempt += 1) {
    const collected = await readTurn(attemptPrompt);
    const outcome = { collected, ...parseToolBridgeOutput(bridge, collected.text) };
    if (!outcome.error) return outcome;
    reason = outcome.error;
    log?.debug?.("GEMINI-WEB", `Unusable tool-bridge reply (attempt ${attempt}): ${reason}`);
    attemptPrompt = toolBridgeRetryPrompt(prompt, reason);
  }
  throw invalidToolCallError(reason);
}

/** A JSON-mode answer without tools: its text. */
async function jsonModeTurn({ prompt, readTurn }) {
  const collected = await readTurn(prompt);
  return { collected, calls: [], content: collected.text.trim() };
}

/**
 * Check a text reply against response_format and repair it once. A repair is
 * another turn on the account, so a reply still unusable after it, or a
 * repair that fails, returns the raw reply, as in gemini-web-to-api.
 * Cancellation is not a failed repair.
 */
async function ensureJSONReply({ jsonMode, prompt, reply, regenerate, signal, log }) {
  const first = validateJSONReply(reply, jsonMode);
  if (!first.error) return first.json;
  log?.debug?.("GEMINI-WEB", `response_format reply was not usable: ${first.error}`);

  let repaired;
  try {
    repaired = await regenerate(repairJSONPrompt(prompt, jsonMode, first.error));
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    log?.warn?.("GEMINI-WEB", `response_format repair request failed; returning the raw reply: ${safeMessage(error)}`);
    return reply;
  }
  const second = validateJSONReply(repaired, jsonMode);
  if (!second.error) return second.json;
  log?.warn?.(
    "GEMINI-WEB",
    `Gemini reply still does not match response_format after one repair attempt; returning the raw reply: ${second.error}`
  );
  return reply;
}

/** One repair turn: the bridge's text content, or the plain text. A tool call in it is not used. */
function repairTurn(bridge, readTurn) {
  return async (prompt) => {
    const { text } = await readTurn(prompt);
    if (!bridge) return text;
    const outcome = parseToolBridgeOutput(bridge, text);
    if (outcome.error) throw new Error(outcome.error);
    return outcome.content;
  };
}

/**
 * The whole answer of a buffered turn (tools or response_format): tool calls
 * or text, with the text checked against response_format.
 */
async function bufferedAnswer({ request, readTurn, signal, log }) {
  const { bridge, jsonMode, prompt } = request;
  const outcome = bridge
    ? await runToolBridge({ bridge, prompt, readTurn, log })
    : await jsonModeTurn({ prompt, readTurn });
  if (jsonMode && outcome.calls.length === 0 && outcome.content) {
    const regenerate = repairTurn(bridge, readTurn);
    outcome.content = await ensureJSONReply({ jsonMode, prompt, reply: outcome.content, regenerate, signal, log });
  }
  // Image links would break a JSON reply, so they only stand in for missing text.
  if (!bridge && !outcome.content) outcome.content = composeContent("", outcome.collected.images);
  if (outcome.calls.length === 0 && !outcome.content) throw upstreamError("Gemini Web did not return an answer");
  return outcome;
}

function completionPayload({ message, finishReason, reportedModel, usage }) {
  return {
    id: `chatcmpl-gw-${randomUUID().slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: reportedModel,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage,
  };
}

/** Chunk builders for one streamed completion: same id, time and model on every chunk. */
function completionChunks(reportedModel) {
  const id = `chatcmpl-gw-${randomUUID().slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: reportedModel };
  return {
    chunk: (delta, finish = null) => ({
      ...base,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }),
    usageChunk: (usage) => ({ ...base, choices: [], usage }),
  };
}

function toolBridgeMessage({ calls, content, collected }) {
  const message =
    calls.length > 0
      ? { role: "assistant", content: null, tool_calls: calls }
      : { role: "assistant", content };
  if (collected.reasoning) message.reasoning_content = collected.reasoning;
  return message;
}

/** The whole bridged reply as SSE: it is only known once Gemini finished. */
function toolBridgeSse({ message, finishReason, usage, reportedModel, includeUsage }) {
  const { chunk, usageChunk } = completionChunks(reportedModel);
  const events = [chunk({ role: "assistant", content: "" })];
  if (message.reasoning_content) events.push(chunk({ reasoning_content: message.reasoning_content }));
  if (message.tool_calls) {
    message.tool_calls.forEach((call, index) => events.push(chunk({ tool_calls: [{ index, ...call }] })));
  } else {
    events.push(chunk({ content: message.content }));
  }
  events.push(chunk({}, finishReason));
  if (includeUsage) events.push(usageChunk(usage));
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + SSE_DONE;
  return new Response(body, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } });
}

function toolBridgeResponse({ outcome, wantsStream, requestBody, reportedModel, includeUsage }) {
  const message = toolBridgeMessage(outcome);
  const finishReason = outcome.calls.length > 0 ? "tool_calls" : "stop";
  const output = outcome.calls.length > 0 ? JSON.stringify(outcome.calls) : outcome.content;
  const usage = usagePayload(
    outcome.collected.usage,
    requestBody,
    output.length + outcome.collected.reasoning.length
  );
  if (wantsStream) return toolBridgeSse({ message, finishReason, usage, reportedModel, includeUsage });
  return new Response(JSON.stringify(completionPayload({ message, finishReason, reportedModel, usage })), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function imageTaskModel(models) {
  const list = Array.isArray(models) ? models : [];
  const chosen = list.find((model) => model.id === "gemini-auto") || list[0];
  if (!chosen) {
    throw upstreamError("Gemini Web returned no image-capable model for this account");
  }
  return chosen;
}

// ─── Execute stages ─────────────────────────────────────────────────────────

/** The prompt Gemini gets: the tool bridge owns the reply format when there are tools. */
function turnPrompt(basePrompt, bridge, jsonMode) {
  if (bridge) return buildToolBridgePrompt(bridge, basePrompt, jsonMode);
  if (jsonMode) return buildJSONModePrompt(basePrompt, jsonMode);
  return basePrompt;
}

function noUserMessageError() {
  return geminiWebError("No user message found", {
    status: 400,
    code: GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
  });
}

/**
 * Stages 1 and 2: reject controls Gemini Web cannot honor, then build the
 * prompt, the tool bridge and the image input. No network call is made.
 */
function prepareRequest(requestBody, requestedModel, log) {
  const violation = checkGeminiWebUnsupportedControls(requestBody, requestedModel);
  if (violation) {
    const error = unsupportedControl(violation.message);
    error.param = violation.param;
    log?.debug?.("GEMINI-WEB", `Rejected request: unsupported ${violation.param}`);
    return { failure: errorResponse(error) };
  }

  const { cleanModel } = parseModelSuffix(requestedModel);
  try {
    const bridge = parseToolBridge(requestBody);
    const jsonMode = parseResponseFormat(requestBody);
    const flattened = flattenMessages(requestBody.messages);
    const basePrompt = promptFromTurns(flattened.turns);
    if (!basePrompt || !flattened.hasUserTurn) throw noUserMessageError();
    const inputImages = decodeInputImages(flattened.images);
    const prompt = turnPrompt(basePrompt, bridge, jsonMode);
    return { requestBody, requestedModel, cleanModel, prompt, bridge, jsonMode, inputImages };
  } catch (error) {
    return { failure: errorResponse(error) };
  }
}

function knownModelIdsOf(models) {
  return new Set(
    (models || []).map((entry) => entry.modelId).filter((value) => typeof value === "string" && value)
  );
}

function channelImageError(reportedModel) {
  return unsupportedControl(
    'Model provider "gemini-web" cannot attach input images to a channel-only model. ' +
      `"${reportedModel}" is published only for text turns. Remove the images or route to ` +
      "a model that accepts them."
  );
}

/**
 * Stages 3 and 4: the account session (bootstrap plus optional PSIDTS
 * rotation) and its catalog entry for the model, never a substitute.
 */
async function resolveAccount(request, options) {
  const session = await resolveSession(options);
  if (session.failure) return session;
  return routeModel(request, session.resolved);
}

async function resolveSession({ credentials, signal, log, proxyOptions, transport }) {
  try {
    return { resolved: await resolveGeminiWebSession(credentials, { signal, proxyOptions, transport }) };
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { failure: errorResponse(abortError()) };
    log?.debug?.("GEMINI-WEB", `Bootstrap failed with HTTP ${errorStatus(error)}`);
    return { failure: errorResponse(error) };
  }
}

function routeModel(request, resolved) {
  let routing;
  try {
    routing = resolveGeminiModel(request.cleanModel, resolved.session.models);
  } catch (error) {
    return { failure: errorResponse(modelNotFoundError(error)) };
  }

  const reportedModel = request.cleanModel || routing.id;
  // A policy code is published only inside the channel's model group, and the
  // channel's request records carry no uploaded-file slot. Sending the turn
  // anyway would keep the [Image N] marker and silently drop the image, so the
  // request is refused here, before an upload is spent.
  if (routing.policy === true && request.inputImages.length > 0) {
    return { failure: errorResponse(channelImageError(reportedModel)) };
  }
  return { resolved, routing, reportedModel, knownModelIds: knownModelIdsOf(resolved.session.models) };
}

/** The whole answer, or the error response that replaces it. */
async function collectAnswer({ upstream, signal, account, request }) {
  let collected;
  try {
    collected = await collectEvents(upstream.body, { signal, knownModelIds: account.knownModelIds });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return { failure: errorResponse(abortError()) };
    return { failure: errorResponse(error, { nonReplayable: true }) };
  }
  if (collected.modelId && collected.modelId !== account.routing.modelId) {
    return { failure: errorResponse(modelMismatchError(request.cleanModel), { nonReplayable: true }) };
  }
  return { collected };
}

/** A plain (no tool bridge) JSON completion read from the whole answer. */
async function plainCompletion(context) {
  const { collected, failure } = await collectAnswer(context);
  if (failure) return failure;

  const content = composeContent(collected.text, collected.images);
  if (!content) {
    return errorResponse(upstreamError("Gemini Web did not return an answer"), { nonReplayable: true });
  }

  const message = { role: "assistant", content };
  if (collected.reasoning) message.reasoning_content = collected.reasoning;

  const payload = completionPayload({
    message,
    finishReason: "stop",
    reportedModel: context.account.reportedModel,
    usage: usagePayload(
      collected.usage,
      context.request.requestBody,
      content.length + (collected.reasoning?.length || 0)
    ),
  });
  return markNonReplayableResponse(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

/**
 * One buffered turn on the account: send, read the whole answer, check the
 * model. Once Google accepted a turn the request is never replayed.
 */
function turnReader({ sendTurn, turn, signal, account, request }) {
  return async (prompt) => {
    const upstream = await sendTurn(prompt);
    turn.accepted = true;
    const collected = await collectEvents(upstream.body, { signal, knownModelIds: account.knownModelIds });
    if (collected.modelId && collected.modelId !== account.routing.modelId) {
      throw modelMismatchError(request.cleanModel);
    }
    return collected;
  };
}

/** A buffered completion (tools or response_format): read in full, then JSON or SSE. */
async function bufferedCompletion({ request, account, sendTurn, turn, signal, log, wantsStream, includeUsage }) {
  let outcome;
  try {
    const readTurn = turnReader({ sendTurn, turn, signal, account, request });
    outcome = await bufferedAnswer({ request, readTurn, signal, log });
  } catch (error) {
    return turnFailure(error, signal, turn);
  }
  return markNonReplayableResponse(
    toolBridgeResponse({
      outcome,
      wantsStream,
      requestBody: request.requestBody,
      reportedModel: account.reportedModel,
      includeUsage,
    })
  );
}

/**
 * Stage 5: send the turn and shape the answer. Only the request that can
 * consume a generation counts as dispatched; a failed upload or a Bind
 * channel that never opened stays retryable.
 */
async function completeTurn({ request, account, requestBody, wantsStream, signal, log, proxyOptions, transport }) {
  const turn = { dispatched: false, accepted: false };
  const sendTurn = (turnPrompt) =>
    sendGeminiWebTurn({
      resolved: account.resolved,
      routing: account.routing,
      prompt: turnPrompt,
      inputImages: request.inputImages,
      thinkingLevel: resolveRequestedThinking(requestBody, request.requestedModel),
      signal,
      proxyOptions,
      transport,
      turn,
    });
  const includeUsage = Boolean(requestBody.stream_options?.include_usage);

  if (request.bridge || request.jsonMode) {
    return bufferedCompletion({ request, account, sendTurn, turn, signal, log, wantsStream, includeUsage });
  }

  let upstream;
  try {
    upstream = await sendTurn(request.prompt);
  } catch (error) {
    return turnFailure(error, signal, turn);
  }

  if (!wantsStream) return plainCompletion({ upstream, signal, account, request });

  const response = streamCompletion({
    upstream,
    signal,
    requestBody,
    knownModelIds: account.knownModelIds,
    routing: account.routing,
    reportedModel: account.reportedModel,
    requestedModel: request.cleanModel,
    includeUsage,
  });
  return markNonReplayableResponse(response);
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", { id: "gemini-web", baseUrl: GEMINI_WEB_CLIENT_URL });
  }

  /**
   * Boolean compatibility probe. Only a definitive result maps to true/false;
   * an inconclusive probe throws so route health is never guessed.
   */
  async testConnection(credentials, options = {}) {
    const result = await probeGeminiWebConnection(credentials, options);
    if (result.status === "valid") return true;
    if (result.status === "invalid") return false;
    const error = new Error(result.error || "Gemini Web verification is inconclusive");
    error.code = GEMINI_WEB_VERIFICATION_UNKNOWN;
    throw error;
  }

  async execute(options) {
    const { model, body, stream, credentials, signal, log } = options;
    const requestBody = body && typeof body === "object" ? body : {};
    const requestedModel = typeof model === "string" ? model : "";
    const wantsStream = Boolean(stream);
    const result = (response, reportedModel = requestedModel) => ({
      response,
      url: GEMINI_WEB_CLIENT_URL,
      headers: { "x-gemini-web-slot": slotHeaderValue(credentials) },
      transformedBody: sanitizedBody(reportedModel, requestBody, wantsStream),
    });

    if (signal?.aborted) {
      return result(errorResponse(abortError()));
    }

    // 1-2. Controls, prompt and image input, validated before any network call.
    const request = prepareRequest(requestBody, requestedModel, log);
    if (request.failure) return result(request.failure);

    // 3-4. Account session and the model it routes to.
    const account = await resolveAccount(request, options);
    if (account.failure) return result(account.failure);

    // 5. Upload every input image, in prompt order, then generate one turn.
    const response = await completeTurn({ ...options, request, account, requestBody, wantsStream });
    return result(response, account.reportedModel);
  }

  /**
   * Generate images through the image task. `gemini-image` resolves to the
   * account's advertised Auto entry (or its first entry); the caller's `n` is
   * honored by collecting multiple images from one turn before asking again.
   *
   * @returns {Promise<Array<{ b64: string, mime: string }>>}
   */
  async generateMedia({ prompt, n = 1, size, credentials, signal, log, proxyOptions, transport }) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw geminiWebError("prompt is required for image generation", { status: 400 });
    }
    const wanted = Math.max(1, Math.min(4, Number(n) || 1));

    const resolved = await resolveGeminiWebSession(credentials, {
      signal,
      proxyOptions,
      transport,
    });
    const routing = imageTaskModel(resolved.session.models);
    const knownModelIds = new Set(
      (resolved.session.models || [])
        .map((entry) => entry.modelId)
        .filter((value) => typeof value === "string" && value)
    );

    const images = [];
    let accepted = false;
    let dispatched = false;
    try {
      while (images.length < wanted) {
        dispatched = false;
        const upstream = await generateGeminiWeb({
          session: resolved.session,
          authUser: resolved.authUser,
          model: routing,
          prompt: buildImagePrompt(prompt, size),
          files: [],
          task: GEMINI_WEB_TASK.IMAGE,
          thinkingLevel: "low",
          signal,
          proxyOptions,
          transport,
          onDispatch: () => {
            dispatched = true;
          },
        });
        if (!upstream.ok) throw await upstreamFailure(upstream);
        accepted = true;

        const collected = await collectEvents(upstream.body, { signal, knownModelIds });
        if (collected.images.length === 0) throw noImageError();

        for (const image of collected.images) {
          if (images.length >= wanted) break;
          images.push(
            await downloadGeminiWebImage(resolved.session, image, {
              signal,
              proxyOptions,
              transport,
              authUser: resolved.authUser,
            })
          );
        }
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw geminiWebError("The Gemini Web image request was aborted", {
          status: 499,
          code: ABORT_CODE,
        });
      }
      // A rejected generation (401/403/429) or a channel that never carried
      // req0/req1 was not consumed, so account fallback is still safe;
      // anything after the send must not replay.
      const status = Number(error?.status);
      const rejected = status === 400 || status === 401 || status === 403 || status === 429;
      if (accepted || error?.nonReplayable === true || (dispatched && !rejected)) {
        error.nonReplayable = true;
      }
      throw error;
    }

    return images.map((image) => ({ b64: image.b64, mime: image.mime }));
  }
}

// ─── Streaming ──────────────────────────────────────────────────────────────

/**
 * Gemini resends the whole text so far. Only a longer text adds a tail, and a
 * shorter one never replaces what was already sent.
 */
function growField(acc, key, text) {
  const previous = acc[key];
  if (text.length >= previous.length) acc[key] = text;
  return text.length > previous.length ? text.slice(previous.length) : "";
}

function grownDelta(acc, key, text, deltaKey) {
  const tail = growField(acc, key, text);
  return tail ? { [deltaKey]: tail } : null;
}

/** One handler per decoded event type; each returns the delta to send, or null. */
const STREAM_EVENT_HANDLERS = {
  text: (acc, event) => grownDelta(acc, "text", event.text, "content"),
  reasoning: (acc, event) => grownDelta(acc, "reasoning", event.text, "reasoning_content"),
  images: (acc, event) => {
    acc.images.push(...event.images);
    return null;
  },
  usage: (acc, event) => {
    acc.usage = event.usage;
    return null;
  },
  model: (_acc, event, routing, requestedModel) => {
    if (event.modelId && event.modelId !== routing.modelId) throw modelMismatchError(requestedModel);
    return null;
  },
};

/** Fold one decoded event into the stream state. Unknown event types are ignored. */
function streamEventDelta(acc, event, routing, requestedModel) {
  const handler = Object.hasOwn(STREAM_EVENT_HANDLERS, event.type) ? STREAM_EVENT_HANDLERS[event.type] : null;
  return handler ? handler(acc, event, routing, requestedModel) : null;
}

/** Image links, the stop chunk and the optional usage chunk, in that order. */
function closingChunks(acc, { chunk, usageChunk, includeUsage, requestBody }) {
  const payloads = [];
  if (acc.images.length > 0) {
    const block = buildLinkBlock(acc.images);
    payloads.push(chunk({ content: acc.text ? `\n\n${block}` : block }));
  }
  payloads.push(chunk({}, "stop"));
  if (includeUsage) {
    payloads.push(usageChunk(usagePayload(acc.usage, requestBody, acc.text.length + acc.reasoning.length)));
  }
  return payloads;
}

function streamErrorPayload(error, signal) {
  if (signal?.aborted || error?.name === "AbortError") {
    return { error: { message: "The Gemini Web request was aborted", type: "aborted", code: ABORT_CODE } };
  }
  return {
    error: {
      message: safeMessage(error, "Gemini Web stream failed"),
      type: "upstream_error",
      code: errorCode(errorStatus(error), error),
    },
  };
}

/** SSE writes that stop quietly once the client has gone. */
function sseWriter(controller, state) {
  const encoder = new TextEncoder();
  const write = (text) => {
    if (state.closed) return false;
    try {
      controller.enqueue(encoder.encode(text));
      return true;
    } catch {
      state.closed = true;
      return false;
    }
  };
  return {
    send: (payload) => write(`data: ${JSON.stringify(payload)}\n\n`),
    done: () => write(SSE_DONE),
    finish: () => {
      if (state.closed) return;
      state.closed = true;
      try {
        controller.close();
      } catch {
        // The client may already have closed the stream.
      }
    },
  };
}

function streamCompletion({
  upstream,
  signal,
  requestBody,
  knownModelIds,
  routing,
  reportedModel,
  requestedModel,
  includeUsage,
}) {
  const { chunk, usageChunk } = completionChunks(reportedModel);
  const state = { closed: false };

  const readable = new ReadableStream(
    {
      async start(controller) {
        const { send, done, finish } = sseWriter(controller, state);
        const acc = { text: "", reasoning: "", usage: null, images: [] };

        try {
          send(chunk({ role: "assistant", content: "" }));
          for await (const event of decodeGeminiWebStream(upstream.body, { signal, knownModelIds })) {
            const delta = streamEventDelta(acc, event, routing, requestedModel);
            if (delta) send(chunk(delta));
          }
          for (const payload of closingChunks(acc, { chunk, usageChunk, includeUsage, requestBody })) send(payload);
          done();
        } catch (error) {
          send(streamErrorPayload(error, signal));
        } finally {
          finish();
        }
      },
      cancel() {
        state.closed = true;
        try {
          void upstream.body?.cancel?.().catch?.(() => {});
        } catch {
          // The body may be locked by the decoder that is already tearing down.
        }
      },
    },
    { highWaterMark: 16384 }
  );

  return new Response(readable, { status: 200, headers: { ...SSE_HEADERS_NO_BUFFER } });
}

// ─── Thinking intent ────────────────────────────────────────────────────────

/**
 * Resolve the wire thinking enum from the model suffix or the body. The suffix
 * wins, matching the rest of the translator pipeline; validation already ran.
 */
function resolveRequestedThinking(body, model) {
  const { override } = parseModelSuffix(model);
  if (override?.mode === "level") return override.level;
  if (override?.mode === "auto") return "auto";

  const intent = extractThinkingIntent(body);
  if (!intent) return "low";
  if (intent.mode === "auto") return "auto";
  if (intent.mode === "level") return intent.level;
  return "low";
}

// Kept local so a model suffix and the thinking guard always agree.
function parseModelSuffix(model) {
  if (typeof model !== "string" || !model) return { cleanModel: model, override: null };
  return parseSuffix(model);
}

function extractThinkingIntent(body) {
  return extractThinking(body);
}

// ─── Provider-level helpers used by routes ──────────────────────────────────

function classifyProbeFailure(error) {
  const status = Number(error?.status);
  const message = safeMessage(error, "Gemini Web verification failed");

  if (status === 401 || status === 403 || status === 400) return { status: "invalid", error: message };
  if (status === 429) return { status: "unknown", error: message };
  if (/not signed in|cannot select models|no usable models|no available models/i.test(message)) {
    return { status: "invalid", error: message };
  }
  return { status: "unknown", error: message };
}

/**
 * Three-state connection probe. Only signed-in bootstrap + model discovery
 * count as valid; a refused session or an account that cannot select models is
 * invalid; transport uncertainty is unknown.
 */
export async function probeGeminiWebConnection(credentials, options = {}) {
  try {
    const { session } = await resolveGeminiWebSession(credentials, { ...options, forceRefresh: true });
    return { status: "valid", ...(session.account ? { account: session.account } : {}) };
  } catch (error) {
    return classifyProbeFailure(error);
  }
}

/**
 * Resolve this account's public chat catalog. Private routing ids, capacities
 * and model numbers stay inside the runtime cache.
 */
export async function resolveGeminiWebModels(credentials, options = {}) {
  const { forceRefresh = false, signal, proxyOptions, transport } = options || {};
  const resolved = await resolveGeminiWebSession(credentials, {
    forceRefresh,
    signal,
    proxyOptions,
    transport,
  });
  return publicGeminiWebModels(resolved.session.models);
}

export default GeminiWebExecutor;
