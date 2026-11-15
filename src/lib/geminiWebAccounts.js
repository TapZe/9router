import { getProviderConnections, getProviderConnectionById } from "@/lib/db/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import { getGeminiCookieValue } from "open-sse/utils/geminiCookies.js";
import { throwIfAborted } from "open-sse/executors/gemini-web/config.js";
import {
  GEMINI_WEB_SESSION_CONFLICT,
  GEMINI_WEB_SESSION_IN_USE,
  GEMINI_WEB_SESSION_NOT_FOUND,
  commitGeminiWebAccountSet,
  commitGeminiWebCookieUpdate,
  deleteGeminiWebSession,
  detachGeminiWebAccount,
  getGeminiWebSession,
  listGeminiWebSessions,
  migrateLegacyGeminiWebConnections,
  normalizeGeminiWebAuthUser,
  recordGeminiWebModels,
} from "@/lib/db/repos/geminiWebSessionsRepo.js";

const GEMINI_WEB_PROVIDERS = new Set(["gemini-web", "gweb"]);
const LAST_ERROR_MAX = 180;
const BROWSER_FETCH_HEADERS = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];
const CATALOG_TTL_MS = 10 * 60 * 1000;

let promotionPromise = null;

export function isGeminiWebProvider(provider) {
  return GEMINI_WEB_PROVIDERS.has(String(provider || ""));
}

export function listPublicGeminiWebCatalog(connection, now = Date.now()) {
  const catalog = connection?.geminiWebModelCatalog
    || connection?.providerSpecificData?.geminiWebModelCatalog;
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return null;
  const verifiedAt = Date.parse(catalog.verifiedAt);
  if (!Number.isFinite(verifiedAt) || now - verifiedAt > CATALOG_TTL_MS) return null;
  const sessionId = connection?.providerSpecificData?.geminiWebSessionId;
  if (catalog.sessionId && sessionId && catalog.sessionId !== sessionId) return null;
  const authUser = connection?.providerSpecificData?.authUser;
  if (catalog.authUser !== undefined && authUser !== undefined && String(catalog.authUser) !== String(authUser)) {
    return null;
  }
  return catalog.models.filter((model) => model && typeof model.id === "string" && model.id);
}

export function unionGeminiWebCatalogIds(connections, now = Date.now()) {
  const ids = [];
  const seen = new Set();
  for (const row of connections || []) {
    if (!isGeminiWebProvider(row?.provider)) continue;
    const models = listPublicGeminiWebCatalog(row, now);
    if (!models) continue;
    const enabled = row.providerSpecificData?.enabledModels;
    const allow = Array.isArray(enabled) && enabled.length > 0 ? new Set(enabled) : null;
    for (const model of models) {
      if (allow && !allow.has(model.id)) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push(model.id);
    }
  }
  return ids;
}

export async function ensureLegacyGeminiWebPromotion() {
  if (!promotionPromise) {
    promotionPromise = migrateLegacyGeminiWebConnections().catch((error) => {
      promotionPromise = null;
      throw error;
    });
  }
  return promotionPromise;
}

function originOf(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function mutationOrigins(request) {
  const origins = new Set([
    originOf(request.url),
    originOf(process.env.BASE_URL),
    originOf(process.env.NEXT_PUBLIC_BASE_URL),
  ].filter(Boolean));
  const host = header(request, "host").trim();
  if (host && originOf(request.url)) {
    const candidate = originOf(`${new URL(request.url).protocol}//${host}`);
    if (candidate && new URL(candidate).host.toLowerCase() === host.toLowerCase()) {
      origins.add(candidate);
    }
  }
  return origins;
}

function matchesMutationOrigin(request, origins, source) {
  // Fetch Metadata is browser-controlled and survives TLS termination and Host rewrites.
  return Boolean(source) && (origins.has(source) || header(request, "sec-fetch-site") === "same-origin");
}

function header(request, name) {
  return request.headers?.get?.(name) || "";
}

function hasBrowserAuth(request) {
  const cookie = header(request, "cookie");
  return /(?:^|;\s*)auth_token=/.test(cookie);
}

function hasBrowserMetadata(request) {
  return BROWSER_FETCH_HEADERS.some((name) => header(request, name));
}

export function assertGeminiWebMutationOrigin(request) {
  const expected = mutationOrigins(request);
  if (expected.size === 0) {
    const error = new Error("Gemini Web mutation origin could not be determined");
    error.status = 403;
    error.code = "gemini_web_origin_denied";
    throw error;
  }

  const site = header(request, "sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    const error = new Error("Gemini Web mutation origin is not allowed");
    error.status = 403;
    error.code = "gemini_web_origin_denied";
    throw error;
  }

  const originHeader = header(request, "origin").trim();
  if (originHeader) {
    const source = originOf(originHeader);
    if (originHeader !== source || !matchesMutationOrigin(request, expected, source)) {
      const error = new Error("Gemini Web mutation origin is not allowed");
      error.status = 403;
      error.code = "gemini_web_origin_denied";
      throw error;
    }
    return;
  }

  const referer = header(request, "referer").trim();
  const refererOrigin = referer ? originOf(referer) : null;
  if (matchesMutationOrigin(request, expected, refererOrigin)) return;

  if (hasBrowserAuth(request) || hasBrowserMetadata(request)) {
    const error = new Error("Gemini Web mutation origin is not allowed");
    error.status = 403;
    error.code = "gemini_web_origin_denied";
    throw error;
  }
}

function sanitizeLastError(value) {
  if (typeof value !== "string" || !value) return null;
  return value.length > LAST_ERROR_MAX ? `${value.slice(0, LAST_ERROR_MAX)}…` : value;
}

function projectConnection(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    name: connection.name || null,
    provider: connection.provider,
    authType: connection.authType,
    priority: connection.priority,
    isActive: connection.isActive !== false,
    authUser: connection.providerSpecificData?.authUser ?? "",
    testStatus: connection.testStatus || "unknown",
    rateLimitedUntil: connection.rateLimitedUntil || null,
    lastError: sanitizeLastError(connection.lastError),
  };
}

function redactSession(session, connections = []) {
  if (!session) return null;
  return {
    id: session.id,
    name: session.name || "",
    fingerprint: session.fingerprint,
    revision: session.revision,
    source: session.source,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastRotatedAt: session.lastRotatedAt,
    connections: connections.map(projectConnection),
  };
}

async function connectionsForSession(sessionId) {
  const rows = await getProviderConnections({ provider: "gemini-web" });
  return rows.filter((row) => row.providerSpecificData?.geminiWebSessionId === sessionId);
}

export function geminiWebAccountIsUsable(connection) {
  const sessionId = connection?.providerSpecificData?.geminiWebSessionId;
  return typeof sessionId === "string" && sessionId.length > 0;
}

function sessionCapability(session, connectionId) {
  if (!session) return null;
  return {
    id: session.id,
    read: async () => getGeminiWebSession(session.id),
    commit: async ({ cookieHeader, expectedRevision, source, lastRotatedAt }) =>
      commitGeminiWebCookieUpdate(session.id, {
        cookieHeader,
        expectedRevision,
        source,
        lastRotatedAt,
      }),
    recordModels: async ({ authUser, cookieRevision, models, verifiedAt }) =>
      recordGeminiWebModels(connectionId, {
        sessionId: session.id,
        authUser,
        cookieRevision,
        models,
        verifiedAt,
      }),
  };
}

export async function hydrateGeminiWebCredentials(connectionOrCredentials) {
  if (!connectionOrCredentials || typeof connectionOrCredentials !== "object") {
    return connectionOrCredentials;
  }
  const provider = connectionOrCredentials.provider;
  const sessionId = connectionOrCredentials.providerSpecificData?.geminiWebSessionId;
  if (provider && !isGeminiWebProvider(provider) && !sessionId) {
    return connectionOrCredentials;
  }
  if (!isGeminiWebProvider(provider) && !sessionId) {
    return connectionOrCredentials;
  }

  await ensureLegacyGeminiWebPromotion();
  if (!sessionId) return connectionOrCredentials;
  const session = await getGeminiWebSession(sessionId);
  if (!session?.cookieHeader) return connectionOrCredentials;
  const psid = getGeminiCookieValue(session.cookieHeader, "__Secure-1PSID");
  if (!psid) return connectionOrCredentials;

  const connectionId = connectionOrCredentials.connectionId || connectionOrCredentials.id;
  return {
    ...connectionOrCredentials,
    apiKey: session.cookieHeader,
    geminiWebSession: sessionCapability(session, connectionId),
  };
}

export async function listGeminiWebSessionViews() {
  await ensureLegacyGeminiWebPromotion();
  const sessions = await listGeminiWebSessions();
  const views = [];
  for (const session of sessions) {
    views.push(redactSession(session, await connectionsForSession(session.id)));
  }
  return views;
}

export async function getGeminiWebSessionView(id) {
  await ensureLegacyGeminiWebPromotion();
  const session = await getGeminiWebSession(id);
  if (!session) return null;
  return redactSession(session, await connectionsForSession(session.id));
}

function normalizeAuthUsers(authUsers) {
  if (!Array.isArray(authUsers) || authUsers.length === 0) {
    const error = new Error("authUsers must be a nonempty array of slots");
    error.status = 400;
    throw error;
  }
  const seen = new Set();
  const slots = [];
  for (const value of authUsers) {
    const slot = normalizeGeminiWebAuthUser(value === 0 ? "0" : value);
    if (seen.has(slot)) continue;
    seen.add(slot);
    slots.push(slot);
  }
  if (slots.length === 0) {
    const error = new Error("authUsers must be a nonempty array of slots");
    error.status = 400;
    throw error;
  }
  return slots;
}

async function probeExecutor() {
  const executor = await import("open-sse/executors/gemini-web.js");
  if (typeof executor.probeGeminiWebConnection !== "function") {
    const error = new Error("Gemini Web probe is not available");
    error.status = 503;
    throw error;
  }
  return executor;
}

async function probeSlot({ cookieHeader, authUser, proxyPoolId, proxyOptions, signal }) {
  throwIfAborted(signal);
  const { probeGeminiWebConnection, resolveGeminiWebModels } = await probeExecutor();
  const credentials = {
    provider: "gemini-web",
    apiKey: cookieHeader,
    providerSpecificData: {
      authUser,
      ...(proxyPoolId ? { proxyPoolId } : {}),
    },
  };
  const probe = await probeGeminiWebConnection(credentials, { proxyOptions, signal });
  throwIfAborted(signal);
  if (probe?.status !== "valid") {
    const error = new Error(probe?.error || `Gemini Web slot ${authUser || "default"} failed verification`);
    error.status = probe?.status === "unknown" ? 503 : 400;
    error.verification = probe?.status || "invalid";
    throw error;
  }
  let models = [];
  if (typeof resolveGeminiWebModels === "function") {
    models = await resolveGeminiWebModels(credentials, { proxyOptions, signal });
  }
  throwIfAborted(signal);
  return { authUser, account: probe.account || null, models, verifiedAt: new Date().toISOString() };
}

async function resolveProbeProxy(proxyPoolId) {
  return resolveConnectionProxyConfig(proxyPoolId ? { proxyPoolId } : {});
}

export async function createGeminiWebSession({ name, cookieHeader, authUsers, proxyPoolId = undefined, signal }) {
  throwIfAborted(signal);
  await ensureLegacyGeminiWebPromotion();
  const slots = normalizeAuthUsers(authUsers);
  if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
    const error = new Error("cookieHeader is required");
    error.status = 400;
    throw error;
  }
  const proxyOptions = await resolveProbeProxy(proxyPoolId);
  const accounts = [];
  for (const authUser of slots) {
    const probed = await probeSlot({
      cookieHeader,
      authUser,
      proxyPoolId: proxyPoolId || null,
      proxyOptions,
      signal,
    });
    accounts.push({
      authUser,
      name: probed.account?.name || (name ? `${name} / ${authUser || "default"}` : undefined),
      proxyPoolId: proxyPoolId === undefined ? undefined : proxyPoolId,
      models: probed.models,
      modelsVerifiedAt: probed.verifiedAt,
    });
  }
  try {
    throwIfAborted(signal);
    const rotatedAt = getGeminiCookieValue(cookieHeader, "__Secure-1PSIDTS")
      ? new Date().toISOString()
      : null;
    const committed = await commitGeminiWebAccountSet({
      session: { name: name || "", cookieHeader, source: "paste", lastRotatedAt: rotatedAt },
      accounts,
      verifiedMembers: slots.map((authUser) => ({ connectionId: null, authUser })),
      signal,
    });
    return {
      session: redactSession(committed.session, committed.connections),
      connections: committed.connections.map(projectConnection),
    };
  } catch (error) {
    if (error?.code === GEMINI_WEB_SESSION_CONFLICT) {
      error.status = 409;
      error.code = "cookie_session_exists";
    }
    throw error;
  }
}

export async function updateGeminiWebSession(sessionId, body, { signal } = {}) {
  throwIfAborted(signal);
  await ensureLegacyGeminiWebPromotion();
  const current = await getGeminiWebSession(sessionId);
  if (!current) {
    const error = new Error("Gemini Web session not found");
    error.status = 404;
    error.code = GEMINI_WEB_SESSION_NOT_FOUND;
    throw error;
  }
  if (body.cookieHeader !== undefined && String(body.cookieHeader).trim() === "") {
    const error = new Error("cookieHeader replacement cannot be blank");
    error.status = 400;
    throw error;
  }
  const linked = await connectionsForSession(sessionId);
  const cookieHeader = body.cookieHeader === undefined ? current.cookieHeader : body.cookieHeader;
  const replacingCookie = body.cookieHeader !== undefined;
  const linkedSlots = linked.map((row) => normalizeGeminiWebAuthUser(row.providerSpecificData?.authUser));
  const requestedSlots = body.authUsers === undefined ? linkedSlots : normalizeAuthUsers(body.authUsers);
  const nextSlots = replacingCookie
    ? [...new Set([...linkedSlots, ...requestedSlots])]
    : requestedSlots;

  const existingBySlot = new Map(
    linked.map((row) => [normalizeGeminiWebAuthUser(row.providerSpecificData?.authUser), row])
  );
  const accounts = [];
  for (const authUser of nextSlots) {
    const existing = existingBySlot.get(authUser);
    const isNew = !existing;
    if (isNew && body.authUsers !== undefined && !Object.hasOwn(body, "proxyPoolId")) {
      const error = new Error("proxyPoolId is required when adding a new slot");
      error.status = 400;
      throw error;
    }
    const proxyPoolId = isNew
      ? (body.proxyPoolId === undefined ? null : body.proxyPoolId)
      : existing.providerSpecificData?.proxyPoolId || null;
    const proxyOptions = await resolveConnectionProxyConfig(
      existing?.providerSpecificData || (proxyPoolId ? { proxyPoolId } : {})
    );
    const probed = await probeSlot({ cookieHeader, authUser, proxyPoolId, proxyOptions, signal });
    accounts.push({
      authUser,
      name: probed.account?.name,
      proxyPoolId: isNew ? proxyPoolId : undefined,
      models: probed.models,
      modelsVerifiedAt: probed.verifiedAt,
    });
  }

  const verifiedMembers = linked.map((row) => ({
    connectionId: row.id,
    authUser: normalizeGeminiWebAuthUser(row.providerSpecificData?.authUser),
  }));

  try {
    throwIfAborted(signal);
    const rotatedAt = replacingCookie && getGeminiCookieValue(cookieHeader, "__Secure-1PSIDTS")
      ? new Date().toISOString()
      : undefined;
    const committed = await commitGeminiWebAccountSet({
      session: {
        id: sessionId,
        name: body.name === undefined ? current.name : body.name,
        cookieHeader,
        source: body.cookieHeader === undefined ? current.source : "paste",
        ...(rotatedAt ? { lastRotatedAt: rotatedAt } : {}),
      },
      accounts,
      expectedRevision: body.expectedRevision,
      verifiedMembers,
      signal,
    });
    return {
      session: redactSession(committed.session, committed.connections),
      connections: committed.connections.map(projectConnection),
    };
  } catch (error) {
    if (error?.code === GEMINI_WEB_SESSION_CONFLICT) error.status = 409;
    if (error?.code === GEMINI_WEB_SESSION_NOT_FOUND) error.status = 404;
    throw error;
  }
}

export async function removeGeminiWebSession(sessionId) {
  await ensureLegacyGeminiWebPromotion();
  try {
    await deleteGeminiWebSession(sessionId);
  } catch (error) {
    if (error?.code === GEMINI_WEB_SESSION_NOT_FOUND) {
      error.status = 404;
    } else if (error?.code === GEMINI_WEB_SESSION_IN_USE) {
      error.status = 409;
      error.code = "cookie_session_in_use";
    }
    throw error;
  }
}

export async function detachGeminiWebConnection(connectionId) {
  await ensureLegacyGeminiWebPromotion();
  const existing = await getProviderConnectionById(connectionId);
  if (!existing) return false;
  if (!isGeminiWebProvider(existing.provider)) return false;
  return detachGeminiWebAccount(connectionId);
}
