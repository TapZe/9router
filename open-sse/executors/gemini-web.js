// GeminiWebExecutor — Gemini Web session provider (native protocol).
//
// Routes requests through Gemini's own web endpoints using the account cookie
// jar plus one Google account slot, and exposes the result as OpenAI chat
// completions or generated image bytes. No browser is launched per request.
//
// Auth: full Cookie request header (__Secure-1PSID + __Secure-1PSIDTS) shared
// by every slot of that browser session; the slot selects the Google account.
// Execution is stateless: the whole message history is sent as one prompt and
// every generation starts a fresh Google turn.

import { randomUUID } from "node:crypto";

import { BaseExecutor } from "./base.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { FORMATS } from "../translator/formats.js";
import { extractThinking, parseSuffix } from "../translator/concerns/thinkingUnified.js";
import { estimateUsage } from "../utils/usageTracking.js";
import { markNonReplayableResponse } from "../utils/replayPolicy.js";
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
import { resolveGeminiModel } from "./gemini-web/models.js";
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
    const allowImages = message.role === "user";
    const text = flattenContent(message.content, images, allowImages);
    if (allowImages && text) hasUserTurn = true;
    if (!text) continue;
    turns.push({ role: message.role, content: text });
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
  return geminiWebError(message, {
    status: Number.isFinite(status) ? status : 502,
    retryAfter,
  });
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

function imageTaskModel(models) {
  const list = Array.isArray(models) ? models : [];
  const chosen = list.find((model) => model.id === "gemini-auto") || list[0];
  if (!chosen) {
    throw upstreamError("Gemini Web returned no image-capable model for this account");
  }
  return chosen;
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

  async execute({ model, body, stream, credentials, signal, log, proxyOptions, transport }) {
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

    // 1. Controls Gemini Web structurally cannot honor.
    const violation = checkGeminiWebUnsupportedControls(requestBody, requestedModel);
    if (violation) {
      const error = unsupportedControl(violation.message);
      error.param = violation.param;
      log?.debug?.("GEMINI-WEB", `Rejected request: unsupported ${violation.param}`);
      return result(errorResponse(error));
    }

    // 2. Prompt and image input, validated before any network call.
    const { cleanModel } = parseModelSuffix(requestedModel);
    let prompt;
    let inputImages;
    try {
      const flattened = flattenMessages(requestBody.messages);
      prompt = promptFromTurns(flattened.turns);
      if (!prompt || !flattened.hasUserTurn) {
        throw geminiWebError("No user message found", {
          status: 400,
          code: GEMINI_WEB_UNSUPPORTED_CONTROL_CODE,
        });
      }
      inputImages = decodeInputImages(flattened.images);
    } catch (error) {
      return result(errorResponse(error));
    }

    // 3. Account session (bootstrap + optional PSIDTS rotation).
    let resolved;
    try {
      resolved = await resolveGeminiWebSession(credentials, {
        signal,
        proxyOptions,
        transport,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") return result(errorResponse(abortError()));
      log?.debug?.("GEMINI-WEB", `Bootstrap failed with HTTP ${errorStatus(error)}`);
      return result(errorResponse(error));
    }

    // 4. Model routing: an account-specific catalog entry, never a substitute.
    let routing;
    try {
      routing = resolveGeminiModel(cleanModel, resolved.session.models);
    } catch (error) {
      return result(errorResponse(modelNotFoundError(error), cleanModel));
    }

    const reportedModel = cleanModel || routing.id;
    const knownModelIds = new Set(
      (resolved.session.models || [])
        .map((entry) => entry.modelId)
        .filter((value) => typeof value === "string" && value)
    );

    // 5. Upload every input image, in prompt order, then generate one turn.
    let upstream;
    let dispatched = false;
    try {
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

      dispatched = true;
      upstream = await generateGeminiWeb({
        session: resolved.session,
        authUser: resolved.authUser,
        model: routing,
        prompt,
        files,
        thinkingLevel: resolveRequestedThinking(requestBody, requestedModel),
        signal,
        proxyOptions,
        transport,
      });

      if (!upstream.ok) {
        throw await upstreamFailure(upstream);
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        return result(errorResponse(abortError()), reportedModel);
      }
      return result(
        errorResponse(error, { nonReplayable: dispatched && isAmbiguousGenerationError(error) }),
        reportedModel
      );
    }

    const includeUsage = Boolean(requestBody.stream_options?.include_usage);

    if (!wantsStream) {
      let collected;
      try {
        collected = await collectEvents(upstream.body, { signal, knownModelIds });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
          return result(errorResponse(abortError()), reportedModel);
        }
        return result(errorResponse(error, { nonReplayable: true }), reportedModel);
      }
      if (collected.modelId && collected.modelId !== routing.modelId) {
        return result(errorResponse(modelMismatchError(cleanModel), { nonReplayable: true }), reportedModel);
      }

      const content = composeContent(collected.text, collected.images);
      if (!content) {
        return result(errorResponse(upstreamError("Gemini Web did not return an answer"), {
          nonReplayable: true,
        }), reportedModel);
      }

      const message = { role: "assistant", content };
      if (collected.reasoning) message.reasoning_content = collected.reasoning;

      const payload = {
        id: `chatcmpl-gw-${randomUUID().slice(0, 24)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: reportedModel,
        choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
        usage: usagePayload(
          collected.usage,
          requestBody,
          content.length + (collected.reasoning?.length || 0)
        ),
      };

      return result(
        markNonReplayableResponse(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        ),
        reportedModel
      );
    }

    const response = streamCompletion({
      upstream,
      signal,
      requestBody,
      knownModelIds,
      routing,
      reportedModel,
      requestedModel: cleanModel,
      includeUsage,
    });
    return result(markNonReplayableResponse(response), reportedModel);
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
    try {
      while (images.length < wanted) {
        const upstream = await generateGeminiWeb({
          session: resolved.session,
          authUser: resolved.authUser,
          model: routing,
          prompt: buildImagePrompt(prompt, size),
          files: [],
          thinkingLevel: "low",
          signal,
          proxyOptions,
          transport,
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
      // A rejected generation (401/403/429) was never accepted, so account
      // fallback is still safe; anything after acceptance must not replay.
      const status = Number(error?.status);
      const rejected = status === 400 || status === 401 || status === 403 || status === 429;
      if (accepted || !rejected) error.nonReplayable = true;
      throw error;
    }

    return images.map((image) => ({ b64: image.b64, mime: image.mime }));
  }
}

// ─── Streaming ──────────────────────────────────────────────────────────────

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
  const encoder = new TextEncoder();
  const id = `chatcmpl-gw-${randomUUID().slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const state = { closed: false };

  const chunk = (delta, finish = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: reportedModel,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
  });

  const readable = new ReadableStream(
    {
      async start(controller) {
        const send = (payload) => {
          if (state.closed) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            return true;
          } catch {
            state.closed = true;
            return false;
          }
        };
        const finish = () => {
          if (state.closed) return;
          state.closed = true;
          try {
            controller.close();
          } catch {
            // The client may already have closed the stream.
          }
        };

        let emittedText = "";
        let emittedReasoning = "";
        let usage = null;
        const pendingImages = [];

        try {
          send(chunk({ role: "assistant", content: "" }));
          for await (const event of decodeGeminiWebStream(upstream.body, {
            signal,
            knownModelIds,
          })) {
            if (event.type === "text") {
              if (event.text.length > emittedText.length) {
                send(chunk({ content: event.text.slice(emittedText.length) }));
              }
              if (event.text.length >= emittedText.length) emittedText = event.text;
              continue;
            }
            if (event.type === "reasoning") {
              if (event.text.length > emittedReasoning.length) {
                send(chunk({ reasoning_content: event.text.slice(emittedReasoning.length) }));
              }
              if (event.text.length >= emittedReasoning.length) emittedReasoning = event.text;
              continue;
            }
            if (event.type === "images") {
              pendingImages.push(...event.images);
              continue;
            }
            if (event.type === "usage") {
              usage = event.usage;
              continue;
            }
            if (event.type === "model" && event.modelId && event.modelId !== routing.modelId) {
              throw modelMismatchError(requestedModel);
            }
          }

          if (pendingImages.length > 0) {
            const block = buildLinkBlock(pendingImages);
            send(chunk({ content: emittedText ? `\n\n${block}` : block }));
          }

          send(chunk({}, "stop"));
          if (includeUsage) {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model: reportedModel,
              choices: [],
              usage: usagePayload(
                usage,
                requestBody,
                emittedText.length + emittedReasoning.length
              ),
            });
          }
          if (!state.closed) controller.enqueue(encoder.encode(SSE_DONE));
        } catch (error) {
          if (signal?.aborted || error?.name === "AbortError") {
            send({ error: { message: "The Gemini Web request was aborted", type: "aborted", code: ABORT_CODE } });
          } else {
            send({
              error: {
                message: safeMessage(error, "Gemini Web stream failed"),
                type: "upstream_error",
                code: errorCode(errorStatus(error), error),
              },
            });
          }
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
