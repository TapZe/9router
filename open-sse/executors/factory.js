import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { FACTORY_DROID_MODELS } from "../providers/factoryDroid.js";
import { FACTORY_DROID_REQUESTS } from "../providers/factoryDroidRequests.js";
import { factoryEffortFor } from "../providers/thinkingLevels.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";

export const FACTORY_DROID_SYSTEM_PROMPT =
  "You are Droid, an AI software engineering agent built by Factory.\n" +
  "Help the user with software engineering tasks using the provided tools.\n" +
  "Ground all analysis, planning, and answers in actual file contents and tool outputs.";

export const FACTORY_CLIENT_VERSION = "1.5.0";
export const FACTORY_OPENAI_PLATFORM_ORG = "org-bHuLtG1fGmYk5YaOihAAXFBw";
export const ANTHROPIC_VERSION = "2023-06-01";

function randomHex(bytes) {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const arr = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  }
  return out;
}

export function randomTraceparent() {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return `00-${traceId}-${spanId}-01`;
}

// Server-generated item ID prefixes from OpenAI Responses that cause 404 with store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

export function embeddedToolCallFromName(name) {
  if (typeof name !== "string" || !name.trimStart().startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(name);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.name !== "string" || parsed.name.length === 0) {
      return null;
    }
    let args = parsed.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        // keep string
      }
    }
    return { name: parsed.name, arguments: args };
  } catch {
    return null;
  }
}

export function cleanModelId(modelId) {
  let m = String(modelId || "").toLowerCase().trim();
  return m.replace(/^(prd\/)?(fy|factory|droid)\//, "");
}

// Droid's table gives each model's API. An id it does not have gets the chat
// gateway, which only names the URL of the unknown model error.
const GATEWAY_FOR_API = { anthropic: "anthropic", google: "google", responses: "openai-responses", completions: "openai-completions" };

export function resolveTargetGateway(modelId) {
  return GATEWAY_FOR_API[FACTORY_DROID_MODELS[cleanModelId(modelId)]?.api] ?? "openai-completions";
}

const INFERENCE_REGIONS = ["global", "eu", "us"];

// Droid uses whoami's inferenceRegion when it is valid, else sends an eu org to
// eu and every other org to global. Connections saved before inferenceRegion
// was stored keep eu through their EU API endpoint.
export function factoryInferenceRegion(credentials) {
  const data = credentials?.providerSpecificData || {};
  if (INFERENCE_REGIONS.includes(data.inferenceRegion)) {
    return data.inferenceRegion;
  }
  let endpointHost = null;
  try {
    endpointHost = new URL(data.apiEndpoint).hostname.toLowerCase();
  } catch {
    // No saved endpoint, or not a URL
  }
  return data.region === "eu" || endpointHost === "api.eu.factory.ai" ? "eu" : "global";
}

// Droid's table picks the provider for the region. A model with no provider
// there, or an id Droid does not have, gets null.
export function upstreamProviderFor(modelId, region = "global") {
  return FACTORY_DROID_MODELS[cleanModelId(modelId)]?.providers[region] ?? null;
}

export function resolveFactoryApiBase(credentials = null) {
  if (process.env.FACTORY_API_BASE?.trim()) {
    return process.env.FACTORY_API_BASE.trim().replace(/\/+$/, "");
  }
  const custom = credentials?.providerSpecificData?.apiEndpoint;
  if (custom && typeof custom === "string" && custom.trim()) {
    return custom.trim().replace(/\/+$/, "");
  }
  return "https://api.factory.ai";
}

// Fields Droid 1.3.0 decides per model, effort, and provider. The request
// drops each of them and takes Droid's value, so a field Droid leaves out is
// left out here too.
const DROID_OWNED_FIELDS = {
  anthropic: ["thinking", "output_config.effort", "speed", "context_management"],
  responses: [
    "reasoning", "include", "parallel_tool_calls", "prompt_cache_retention", "text.verbosity",
    "service_tier", "safety_identifier", "max_output_tokens", "tool_choice",
  ],
  completions: [
    "reasoning_effort", "reasoning_history", "chat_template_args", "chat_template_kwargs.enable_thinking",
    "enable_thinking", "allow_missing_thinking", "thinking", "reasoning", "temperature", "store", "tool_choice",
  ],
  google: [
    "generationConfig.thinkingConfig", "generationConfig.temperature", "generationConfig.topP",
    "generationConfig.topK", "generationConfig.maxOutputTokens",
  ],
};

// Droid adds fine-grained tool streaming whenever a request carries tools on
// these Anthropic providers.
const TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const TOOL_STREAMING_PROVIDERS = new Set(["anthropic", "vertex_anthropic", "azure_anthropic"]);

// The Droid betas and session id ride on the sent body for buildHeaders.
// A symbol key stays out of the JSON that goes upstream.
const DROID_REQUEST = Symbol("droidRequest");

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function dropField(body, fieldPath) {
  const keys = fieldPath.split(".");
  const last = keys.pop();
  let parent = body;
  for (const key of keys) parent = isObject(parent) ? parent[key] : undefined;
  if (!isObject(parent)) return;
  delete parent[last];
  if (keys.length > 0 && Object.keys(parent).length === 0) dropField(body, keys.join("."));
}

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isObject(value) && isObject(target[key])) mergeInto(target[key], value);
    else target[key] = structuredClone(value);
  }
}

function fillSession(value, sessionId) {
  if (value === "$session") return sessionId;
  if (Array.isArray(value)) return value.map((item) => fillSession(item, sessionId));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillSession(v, sessionId)]));
  return value;
}

// The effort a client asked for, read before the gateway shapes the body.
// A bare Claude budget asks for high, as before.
function requestedEffortOf(gateway, body) {
  let effort;
  if (gateway === "anthropic") {
    effort = body.thinking?.type === "disabled"
      ? "none"
      : body.output_config?.effort ?? body.reasoning_effort ?? body.thinking?.effort ?? (body.thinking?.budget_tokens > 0 ? "high" : undefined);
  } else if (gateway === "google") {
    effort = body.reasoning_effort ?? body.thinking?.effort ?? body.generationConfig?.thinkingConfig?.thinkingLevel;
  } else {
    effort = body.reasoning?.effort ?? body.reasoning_effort;
  }
  return typeof effort === "string" ? effort.toLowerCase() : undefined;
}

// The body fields and Anthropic betas Droid sends for this model, region, and
// effort. A request without an effort gets the model's default. Models Droid
// does not list get null.
export function droidRequestFor(modelId, region, requested) {
  const m = cleanModelId(modelId);
  const droid = FACTORY_DROID_MODELS[m];
  if (!droid) return null;
  const byEffort = FACTORY_DROID_REQUESTS[m][upstreamProviderFor(m, region)];
  const effort = factoryEffortFor(m, requested ?? droid.defaultEffort);
  return { api: droid.api, ...(byEffort[effort] ?? byEffort[droid.defaultEffort]) };
}

// Swaps the Droid-owned fields for what Droid sends. Droid's chat body sends
// max_tokens and never max_completion_tokens.
function applyDroidRequest(body, request, sessionId) {
  const next = structuredClone(body);
  for (const fieldPath of DROID_OWNED_FIELDS[request.api]) dropField(next, fieldPath);
  if (request.api === "completions" && "max_completion_tokens" in next) {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
  }
  mergeInto(next, fillSession(request.body, sessionId));
  // Droid always sends tools, so its tool fields assume them.
  if (!(Array.isArray(next.tools) && next.tools.length > 0)) {
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  next[DROID_REQUEST] = { betas: request.betas ?? [], sessionId };
  return next;
}

// Droid 1.5.0's wrapping: text already wrapped after a trim stays as it is.
function systemReminder(content) {
  const text = typeof content === "string" ? content : (content ?? []).map((part) => part.text).join("\n");
  const trimmed = text.trim();
  if (trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>")) return text;
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return item.text || item.content || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export class FactoryExecutor extends BaseExecutor {
  constructor(provider = "factory") {
    super(provider, PROVIDERS[provider] || PROVIDERS.openai);
  }

  // Droid 1.3.0 throws "Unknown model" for an id its registry does not have.
  // It stops a turn when the model has no provider in the region and never
  // tries another region. Both end the request here before any fetch.
  async execute(args) {
    const model = cleanModelId(args.model);
    const region = factoryInferenceRegion(args.credentials);
    let message = null;
    if (!FACTORY_DROID_MODELS[model]) {
      message = `Unknown model: ${model}`;
    } else if (upstreamProviderFor(model, region) === null) {
      message = `No providers available for this turn (model ${model}, region ${region})`;
    }
    if (message) {
      const response = new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response, url: this.buildUrl(args.model, args.stream, 0, args.credentials), headers: {}, transformedBody: args.body };
    }
    return super.execute(args);
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("factory", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("factory", credentials);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = resolveFactoryApiBase(credentials);
    const gateway = resolveTargetGateway(model);
    if (gateway === "anthropic") {
      return `${base}/api/llm/a/v1/messages`;
    }
    if (gateway === "google") {
      return `${base}/api/llm/g/v1/generate`;
    }
    if (gateway === "openai-responses") {
      return `${base}/api/llm/o/v1/responses`;
    }
    return `${base}/api/llm/o/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const clientType = process.env.FACTORY_UPSTREAM_CLIENT_TYPE?.trim() || "cli";
    const headers = {
      "Content-Type": "application/json",
      "X-Factory-Client": clientType,
      "X-Client-Version": FACTORY_CLIENT_VERSION,
      "User-Agent": `factory-cli/${FACTORY_CLIENT_VERSION}`,
    };

    const token = credentials?.accessToken || credentials?.apiKey;
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const orgId =
      credentials?.providerSpecificData?.orgId ||
      process.env.FACTORY_ORG_ID?.trim() ||
      process.env.FACTORY_ORGANIZATION_ID?.trim();
    if (orgId) {
      headers["X-Factory-Org-Id"] = orgId;
    }

    const gateway = resolveTargetGateway(model);
    const provider = upstreamProviderFor(model, factoryInferenceRegion(credentials));
    const droidRequest = body?.[DROID_REQUEST];
    headers["x-api-provider"] = provider;
    headers["x-provider-routing-source"] = "registry_default";
    headers["traceparent"] = randomTraceparent();

    if (gateway === "anthropic") {
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      if (droidRequest) {
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        const betas = [...droidRequest.betas, ...(hasTools && TOOL_STREAMING_PROVIDERS.has(provider) ? [TOOL_STREAMING_BETA] : [])];
        if (betas.length > 0) headers["anthropic-beta"] = betas.join(",");
      }
    } else if (gateway === "openai-responses") {
      headers["OpenAI-Platform"] = FACTORY_OPENAI_PLATFORM_ORG;
    } else if (gateway === "google") {
      delete headers["x-goog-api-key"];
    }

    if (globalThis.crypto?.randomUUID) {
      headers["x-session-id"] = droidRequest?.sessionId ?? globalThis.crypto.randomUUID();
      headers["x-assistant-message-id"] = globalThis.crypto.randomUUID();
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    } else {
      headers["Accept"] = "application/json";
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    if (!body || typeof body !== "object") return body;
    const cloned = { ...body };
    const gateway = resolveTargetGateway(model);
    const m = cleanModelId(model);
    const droidRequest = droidRequestFor(m, factoryInferenceRegion(credentials), requestedEffortOf(gateway, body));

    if (gateway !== "google") {
      cloned.stream = !!stream;
    }

    if (Array.isArray(cloned.tools) && cloned.tools.length > 0) {
      if (gateway === "anthropic") {
        // Claude tool shape: { name, description, input_schema }
        cloned.tools = cloned.tools.map((t) => {
          if (!t || typeof t !== "object") return t;
          const name = t.name || t.function?.name || "";
          const desc = t.description || t.function?.description || "";
          const schema = t.input_schema || t.parameters || t.function?.parameters || { type: "object" };
          return {
            name,
            description: desc,
            input_schema: schema,
          };
        });
      } else if (gateway === "openai-responses") {
        // OpenAI Responses flat shape: { type: "function", name, description, parameters }
        cloned.tools = cloned.tools.map((t) => {
          if (!t || typeof t !== "object") return t;
          const rawName = t.name || t.function?.name || "";
          const desc = t.description || t.function?.description || "";
          const params = t.parameters || t.function?.parameters || { type: "object", properties: {} };
          return {
            type: "function",
            name: rawName,
            description: desc,
            parameters: params,
            ...(t.strict || t.function?.strict ? { strict: true } : {}),
          };
        });
        cloned.tool_choice = "auto";
        cloned.parallel_tool_calls = true;
      } else if (gateway === "google") {
        // Google Gemini shape: tools: [{ functionDeclarations: [...] }]
        if (cloned.tools[0]?.functionDeclarations) {
          // Already in Gemini format
        } else {
          const declarations = [];
          for (const t of cloned.tools) {
            if (!t || typeof t !== "object") continue;
            const name = t.name || t.function?.name || "";
            const desc = t.description || t.function?.description || "";
            const schema = t.parameters || t.function?.parameters || t.input_schema || { type: "object", properties: {} };
            if (name) {
              declarations.push({
                name,
                description: desc,
                parameters: schema,
              });
            }
          }
          if (declarations.length > 0) {
            cloned.tools = [{ functionDeclarations: declarations }];
          } else {
            delete cloned.tools;
          }
        }
      } else {
        // OpenAI Chat shape: { type: "function", function: { name, description, parameters } }
        cloned.tools = cloned.tools.map((t) => {
          if (!t || typeof t !== "object") return t;
          if (t.function && typeof t.function === "object") {
            return t;
          }
          if (typeof t.name === "string") {
            return {
              type: "function",
              function: { name: t.name, description: t.description || "", parameters: t.parameters || {} },
            };
          }
          return t;
        });
        cloned.tool_choice = "auto";
      }
    }

    // 2. Inject Droid System Prompt Attestation prefix & strip competing CLI identities
    const DROID_PROMPT_PREFIX = "You are Droid, an AI software engineering agent built by Factory";

    const stripCompeting = (str) => {
      if (typeof str !== "string") return str;
      return str
        .replace(/You are Claude Code[^.\n]*[.\n]/gi, "")
        .replace(/You are Claude Code/gi, "")
        .trim();
    };

    if (gateway === "anthropic") {
      // Claude Messages format requires max_tokens
      if (!cloned.max_tokens) {
        cloned.max_tokens = 4096;
      }

      delete cloned.reasoning_effort;

      if (typeof cloned.system === "string") {
        const clean = stripCompeting(cloned.system);
        cloned.system = clean.includes(DROID_PROMPT_PREFIX)
          ? clean
          : (clean ? `${FACTORY_DROID_SYSTEM_PROMPT}\n\n${clean}` : FACTORY_DROID_SYSTEM_PROMPT);
      } else if (Array.isArray(cloned.system)) {
        const cleaned = cloned.system
          .map((b) => typeof b === "string" ? stripCompeting(b) : { ...b, text: stripCompeting(b.text || "") })
          .filter((b) => (typeof b === "string" ? b.length > 0 : (b.text && b.text.length > 0)));
        const hasPrefix = cleaned.some((item) =>
          typeof item === "string" ? item.includes(DROID_PROMPT_PREFIX) : item.text?.includes(DROID_PROMPT_PREFIX),
        );
        if (!hasPrefix) {
          cleaned.unshift({ type: "text", text: FACTORY_DROID_SYSTEM_PROMPT });
        }
        cloned.system = cleaned;
      } else {
        cloned.system = [{ type: "text", text: FACTORY_DROID_SYSTEM_PROMPT }];
      }
    } else if (gateway === "openai-responses") {
      // OpenAI Responses format requires system prompt in top-level `instructions`
      cloned.store = false;

      if (typeof cloned.instructions === "string" && cloned.instructions.trim()) {
        const clean = stripCompeting(cloned.instructions);
        cloned.instructions = clean.includes(DROID_PROMPT_PREFIX)
          ? clean
          : (clean ? `${FACTORY_DROID_SYSTEM_PROMPT}\n\n${clean}` : FACTORY_DROID_SYSTEM_PROMPT);
      } else if (Array.isArray(cloned.input)) {
        const sysTurns = cloned.input.filter(
          (turn) => turn && (turn.role === "system" || turn.role === "developer"),
        );
        const combined = sysTurns
          .map((turn) => extractTextContent(turn.content))
          .filter(Boolean)
          .join("\n\n");
        const clean = stripCompeting(combined);
        cloned.instructions = clean.includes(DROID_PROMPT_PREFIX)
          ? clean
          : (clean ? `${FACTORY_DROID_SYSTEM_PROMPT}\n\n${clean}` : FACTORY_DROID_SYSTEM_PROMPT);
        // Strip system turns from input array since instructions carries it
        cloned.input = cloned.input.filter((turn) => turn.role !== "system" && turn.role !== "developer");
      } else {
        cloned.instructions = FACTORY_DROID_SYSTEM_PROMPT;
      }

      // Strip server-generated IDs to prevent 404
      if (Array.isArray(cloned.input)) {
        cloned.input = cloned.input.filter((item) => {
          if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
          if (item && typeof item === "object" && !Array.isArray(item)) {
            if (item.type === "item_reference") return false;
            if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) delete item.id;
          }
          return true;
        });
      }
    } else if (gateway === "google") {
      // Google Gemini format (/api/llm/g/v1/generate requires model in body)
      cloned.model = model;

      // Convert messages to contents if contents is missing (e.g. raw OpenAI shape input)
      if (!cloned.contents && Array.isArray(cloned.messages)) {
        const contents = [];
        let systemText = "";
        for (const msg of cloned.messages) {
          if (msg.role === "system") {
            const txt = extractTextContent(msg.content);
            systemText += (systemText ? "\n\n" : "") + txt;
          } else {
            const role = msg.role === "assistant" ? "model" : "user";
            const text = extractTextContent(msg.content);
            contents.push({ role, parts: [{ text }] });
          }
        }
        cloned.contents = contents;
        if (systemText && !cloned.systemInstruction) {
          cloned.systemInstruction = systemText;
        }
      }

      if (typeof cloned.systemInstruction === "string") {
        const clean = stripCompeting(cloned.systemInstruction);
        const text = clean.includes(DROID_PROMPT_PREFIX)
          ? clean
          : (clean ? `${FACTORY_DROID_SYSTEM_PROMPT}\n\n${clean}` : FACTORY_DROID_SYSTEM_PROMPT);
        cloned.systemInstruction = {
          role: "user",
          parts: [{ text }],
        };
      } else if (cloned.systemInstruction?.parts && Array.isArray(cloned.systemInstruction.parts)) {
        const cleaned = cloned.systemInstruction.parts
          .map((p) => (typeof p === "string" ? { text: stripCompeting(p) } : { ...p, text: stripCompeting(p.text || "") }))
          .filter((p) => typeof p.text === "string" && p.text.length > 0);
        const hasPrefix = cleaned.some((item) => item.text?.includes(DROID_PROMPT_PREFIX));
        if (!hasPrefix) {
          cleaned.unshift({ text: FACTORY_DROID_SYSTEM_PROMPT });
        }
        cloned.systemInstruction = {
          role: "user",
          parts: cleaned,
        };
      } else {
        cloned.systemInstruction = {
          role: "user",
          parts: [{ text: FACTORY_DROID_SYSTEM_PROMPT }],
        };
      }

      // Clean up parameters mapped into generationConfig
      if (cloned.max_tokens !== undefined) {
        if (!cloned.generationConfig) cloned.generationConfig = {};
        if (cloned.generationConfig.maxOutputTokens === undefined) {
          cloned.generationConfig.maxOutputTokens = cloned.max_tokens;
        }
        delete cloned.max_tokens;
      }
      if (cloned.temperature !== undefined) {
        if (!cloned.generationConfig) cloned.generationConfig = {};
        if (cloned.generationConfig.temperature === undefined) {
          cloned.generationConfig.temperature = cloned.temperature;
        }
        delete cloned.temperature;
      }
      if (cloned.top_p !== undefined) {
        if (!cloned.generationConfig) cloned.generationConfig = {};
        if (cloned.generationConfig.topP === undefined) {
          cloned.generationConfig.topP = cloned.top_p;
        }
        delete cloned.top_p;
      }
      if (cloned.top_k !== undefined) {
        if (!cloned.generationConfig) cloned.generationConfig = {};
        if (cloned.generationConfig.topK === undefined) {
          cloned.generationConfig.topK = cloned.top_k;
        }
        delete cloned.top_k;
      }
      if (cloned.stop !== undefined) {
        if (!cloned.generationConfig) cloned.generationConfig = {};
        if (!cloned.generationConfig.stopSequences) {
          cloned.generationConfig.stopSequences = Array.isArray(cloned.stop) ? cloned.stop : [cloned.stop];
        }
        delete cloned.stop;
      }

      // Google proto3 GenerateContentRequest schema strictly rejects unknown fields.
      // Top-level fields like `stream`, `reasoning_effort`, `thinking`, `tool_choice`,
      // `parallel_tool_calls`, `messages` cause HTTP 400:
      // "Invalid JSON payload received. Unknown name 'stream': Cannot find field."
      delete cloned.stream;
      delete cloned.reasoning_effort;
      delete cloned.thinking;
      delete cloned.tool_choice;
      delete cloned.parallel_tool_calls;
      delete cloned.messages;
      delete cloned.user;
      delete cloned.store;
      delete cloned.metadata;
      delete cloned.service_tier;
      delete cloned.n;
      delete cloned.logit_bias;
      delete cloned.response_format;

      if (Array.isArray(cloned.tools) && cloned.tools.length === 0) {
        delete cloned.tools;
      }
    } else {
      // OpenAI Chat Completions format (Factory Core / Fireworks gateway)
      if (Array.isArray(cloned.messages)) {
        const msgs = cloned.messages.map((m) => ({ ...m }));
        // Droid puts its system prompt at index 0. A model with
        // systemMessageOnlyAtBeginning only takes a system message there.
        const systemFirst = FACTORY_DROID_MODELS[m]?.systemMessageOnlyAtBeginning;
        const sysIndex = systemFirst
          ? (msgs[0]?.role === "system" ? 0 : -1)
          : msgs.findIndex((m) => m.role === "system");
        if (sysIndex >= 0) {
          const sys = msgs[sysIndex];
          if (typeof sys.content === "string") {
            const clean = stripCompeting(sys.content);
            sys.content = clean.includes(DROID_PROMPT_PREFIX)
              ? clean
              : (clean ? `${FACTORY_DROID_SYSTEM_PROMPT}\n\n${clean}` : FACTORY_DROID_SYSTEM_PROMPT);
          } else if (Array.isArray(sys.content)) {
            const cleaned = sys.content
              .map((c) => ({ ...c, text: stripCompeting(c.text || "") }))
              .filter((c) => c.text && c.text.length > 0);
            const has = cleaned.some((c) => c.text?.includes(DROID_PROMPT_PREFIX));
            if (!has) {
              cleaned.unshift({ type: "text", text: FACTORY_DROID_SYSTEM_PROMPT });
            }
            sys.content = cleaned;
          }
        } else {
          msgs.unshift({ role: "system", content: FACTORY_DROID_SYSTEM_PROMPT });
        }

        // Droid sends each system message after index 0 as a user system
        // reminder on models with systemMessageOnlyAtBeginning.
        if (systemFirst) {
          msgs.forEach((msg, i) => {
            if (i > 0 && msg.role === "system") msgs[i] = { ...msg, role: "user", content: systemReminder(msg.content) };
          });
        }

        // 3. Fireworks / Factory Core requirements for assistant tool turns and tool results
        const isDeepseek = m.startsWith("deepseek-");
        const isKimi = m.startsWith("kimi-");
        const isGlm = m.startsWith("glm-");

        for (const msg of msgs) {
          // DeepSeek validates reasoning on every assistant turn; replay captured
          // reasoning before falling back to empty text, never synthetic ".".
          if (isDeepseek && msg.role === "assistant" && msg.reasoning_content == null) {
            msg.reasoning_content =
              (typeof msg.reasoning === "string" && msg.reasoning) ||
              (typeof msg.reasoning_text === "string" && msg.reasoning_text) ||
              "";
          }
          if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            // requiresAssistantContentForToolCalls
            if (msg.content === undefined || msg.content === null) {
              msg.content = "";
            }
            // requiresReasoningContentForToolCalls
            if (msg.reasoning_content === undefined || msg.reasoning_content === null) {
              msg.reasoning_content = isKimi || isGlm ? "." : "";
            }
          }
          // requiresToolResultName for Kimi
          if (msg.role === "tool" && isKimi && !msg.name) {
            // Attempt to resolve name from tool_call_id
            const matchedAssistant = msgs.find((a) =>
              a.role === "assistant" && Array.isArray(a.tool_calls) && a.tool_calls.some((tc) => tc.id === msg.tool_call_id),
            );
            const matchedTc = matchedAssistant?.tool_calls?.find((tc) => tc.id === msg.tool_call_id);
            if (matchedTc?.function?.name) {
              msg.name = matchedTc.function.name;
            }
          }
        }


        cloned.messages = msgs;
      }
    }

    // 5. Droid's fields for the model, provider, and effort
    if (droidRequest) {
      const sent = applyDroidRequest(cloned, droidRequest, globalThis.crypto.randomUUID());
      if (gateway === "openai-responses") {
        // Responses takes the effort in reasoning, and reasoning models refuse sampling fields.
        delete sent.reasoning_effort;
        if (sent.reasoning) {
          delete sent.temperature;
          delete sent.top_p;
        }
      }
      if (gateway === "anthropic") {
        // A client's own Claude budget still wins over Droid's, down to
        // Anthropic's smallest budget of 1024 tokens.
        const budget = body.thinking?.budget_tokens;
        if (sent.thinking?.type === "enabled" && Number.isFinite(budget) && budget > 0) {
          sent.thinking.budget_tokens = Math.max(1024, budget);
        }
        // Anthropic and Fireworks need max_tokens above the thinking budget.
        if (sent.thinking?.type === "enabled" && sent.thinking.budget_tokens) {
          sent.max_tokens = Math.max(sent.max_tokens, sent.thinking.budget_tokens + 1024);
        }
      }
      return sent;
    }

    return cloned;
  }
}

