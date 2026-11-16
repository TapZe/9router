import {
  getProviderConnections,
  getProviderConnectionById,
  getProxyPoolById,
} from "@/lib/db/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import {
  getGeminiCookieValue,
  normalizeGeminiValidationCookie,
} from "open-sse/utils/geminiCookies.js";
import { throwIfAborted } from "open-sse/executors/gemini-web/config.js";
import {
  GEMINI_WEB_COOKIE_INVALID,
  GEMINI_WEB_SESSION_CONFLICT,
  GEMINI_WEB_SESSION_IN_USE,
  GEMINI_WEB_SESSION_INVALID,
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

function badRequest(message, code) {
  const error = new Error(message);
  error.status = 400;
  if (code) error.code = code;
  return error;
}

// Repository failures are typed; routes answer with status codes.
function applyRepoErrorStatus(error) {
  if (error?.code === GEMINI_WEB_SESSION_CONFLICT || error?.code === GEMINI_WEB_SESSION_IN_USE) {
    error.status = 409;
  } else if (error?.code === GEMINI_WEB_SESSION_NOT_FOUND) {
    error.status = 404;
  } else if (
    error?.code === GEMINI_WEB_SESSION_INVALID ||
    error?.code === GEMINI_WEB_COOKIE_INVALID
  ) {
    error.status = 400;
  }
  return error;
}

function normalizeAuthUserSlot(value) {
  try {
    return normalizeGeminiWebAuthUser(value);
  } catch {
    throw badRequest("Invalid Gemini Web account slot", GEMINI_WEB_SESSION_INVALID);
  }
}

function normalizeAuthUsers(authUsers) {
  if (!Array.isArray(authUsers) || authUsers.length === 0) {
    throw badRequest("authUsers must be a nonempty array of slots");
  }
  const seen = new Set();
  const slots = [];
  for (const value of authUsers) {
    const slot = normalizeAuthUserSlot(value);
    if (seen.has(slot)) continue;
    seen.add(slot);
    slots.push(slot);
  }
  if (slots.length === 0) {
    throw badRequest("authUsers must be a nonempty array of slots");
  }
  return slots;
}

function normalizeCookieForProbe(raw) {
  let cookieHeader;
  try {
    cookieHeader = normalizeGeminiValidationCookie(raw);
  } catch {
    throw badRequest("Invalid Gemini Web cookie header", GEMINI_WEB_COOKIE_INVALID);
  }
  if (!cookieHeader) {
    throw badRequest(
      "Gemini Web cookie header is missing __Secure-1PSID",
      GEMINI_WEB_COOKIE_INVALID
    );
  }
  return cookieHeader;
}

function assertExpectedRevision(expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
    throw badRequest("expectedRevision must be a positive integer", GEMINI_WEB_SESSION_INVALID);
  }
  return expectedRevision;
}

function normalizeProxyPoolId(value) {
  if (value === undefined || value === null) return null;
  const proxyPoolId = String(value).trim();
  if (!proxyPoolId || proxyPoolId === "__none__") return null;
  return proxyPoolId;
}

// A resolver fallback to direct egress is not acceptable when the caller named
// a pool for a brand-new account: the save must fail before Google is contacted.
async function assertUsableProxyPool(value) {
  const proxyPoolId = normalizeProxyPoolId(value);
  if (!proxyPoolId) return null;
  const pool = await getProxyPoolById(proxyPoolId);
  if (!pool) throw badRequest(`Proxy pool ${proxyPoolId} not found`);
  if (pool.isActive !== true) throw badRequest(`Proxy pool ${proxyPoolId} is inactive`);
  if (!String(pool.proxyUrl || "").trim()) {
    throw badRequest(`Proxy pool ${proxyPoolId} has no proxy URL`);
  }
  return proxyPoolId;
}

// The resolver reads the pool again; a pool deleted or downgraded between that
// read and this one makes it fall back to legacy/direct. The snapshot it returns
// must therefore still be the exact usable pool the caller named.
function resolvedExplicitPool(proxyOptions, proxyPoolId) {
  const pool = proxyOptions?.proxyPool;
  return Boolean(
    pool
    && pool.id === proxyPoolId
    && proxyOptions.proxyPoolId === proxyPoolId
    && pool.isActive === true
    && String(pool.proxyUrl || "").trim()
  );
}

function slotSetKey(slots) {
  return [...new Set(slots)].sort().join("\u0000");
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
  const proxyOptions = await resolveConnectionProxyConfig(proxyPoolId ? { proxyPoolId } : {});
  if (proxyPoolId && !resolvedExplicitPool(proxyOptions, proxyPoolId)) {
    throw badRequest(`Proxy pool ${proxyPoolId} became unusable before verification`);
  }
  return proxyOptions;
}

export async function createGeminiWebSession({ name, cookieHeader, authUsers, proxyPoolId = undefined, signal }) {
  throwIfAborted(signal);
  await ensureLegacyGeminiWebPromotion();
  const slots = normalizeAuthUsers(authUsers);
  if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
    throw badRequest("cookieHeader is required", GEMINI_WEB_SESSION_INVALID);
  }
  const normalizedCookie = normalizeCookieForProbe(cookieHeader);
  const explicitPoolId = await assertUsableProxyPool(proxyPoolId);
  const proxyOptions = await resolveProbeProxy(explicitPoolId);
  const accounts = [];
  for (const authUser of slots) {
    const probed = await probeSlot({
      cookieHeader: normalizedCookie,
      authUser,
      proxyPoolId: explicitPoolId,
      proxyOptions,
      signal,
    });
    accounts.push({
      authUser,
      name: probed.account?.name || (name ? `${name} / ${authUser || "default"}` : undefined),
      proxyPoolId: explicitPoolId,
      models: probed.models,
      modelsVerifiedAt: probed.verifiedAt,
    });
  }
  try {
    throwIfAborted(signal);
    const rotatedAt = getGeminiCookieValue(normalizedCookie, "__Secure-1PSIDTS")
      ? new Date().toISOString()
      : null;
    const committed = await commitGeminiWebAccountSet({
      session: { name: name || "", cookieHeader: normalizedCookie, source: "paste", lastRotatedAt: rotatedAt },
      accounts,
      verifiedMembers: slots.map((authUser) => ({ connectionId: null, authUser })),
      signal,
    });
    return {
      session: redactSession(committed.session, committed.connections),
      connections: committed.connections.map(projectConnection),
    };
  } catch (error) {
    applyRepoErrorStatus(error);
    if (error?.code === GEMINI_WEB_SESSION_CONFLICT) error.code = "cookie_session_exists";
    throw error;
  }
}

export async function updateGeminiWebSession(sessionId, body = {}, { signal } = {}) {
  throwIfAborted(signal);
  await ensureLegacyGeminiWebPromotion();
  const current = await getGeminiWebSession(sessionId);
  if (!current) {
    const error = new Error("Gemini Web session not found");
    error.status = 404;
    error.code = GEMINI_WEB_SESSION_NOT_FOUND;
    throw error;
  }
  const expectedRevision = assertExpectedRevision(body.expectedRevision);

  const replacingCookie = body.cookieHeader !== undefined;
  const cookieHeader = replacingCookie
    ? normalizeCookieForProbe(body.cookieHeader)
    : current.cookieHeader;
  const linked = await connectionsForSession(sessionId);
  const linkedSlots = linked.map((row) => normalizeGeminiWebAuthUser(row.providerSpecificData?.authUser));
  const requestedSlots = body.authUsers === undefined ? linkedSlots : normalizeAuthUsers(body.authUsers);
  const metadataOnly = !replacingCookie && slotSetKey(requestedSlots) === slotSetKey(linkedSlots);
  const nextSlots = replacingCookie
    ? [...new Set([...linkedSlots, ...requestedSlots])]
    : (metadataOnly ? linkedSlots : requestedSlots);

  const existingBySlot = new Map(
    linked.map((row) => [normalizeGeminiWebAuthUser(row.providerSpecificData?.authUser), row])
  );
  const addingSlots = nextSlots.some((authUser) => !existingBySlot.has(authUser));
  if (addingSlots && body.authUsers !== undefined && !Object.hasOwn(body, "proxyPoolId")) {
    throw badRequest("proxyPoolId is required when adding a new slot");
  }
  const newSlotProxyPoolId = addingSlots ? await assertUsableProxyPool(body.proxyPoolId) : null;
  const newSlotProxyOptions = addingSlots ? await resolveProbeProxy(newSlotProxyPoolId) : null;

  const accounts = metadataOnly
    ? nextSlots.map((authUser) => ({ authUser }))
    : [];
  if (!metadataOnly) {
    for (const authUser of nextSlots) {
      const existing = existingBySlot.get(authUser);
      const isNew = !existing;
      const proxyPoolId = isNew
        ? newSlotProxyPoolId
        : normalizeProxyPoolId(existing.providerSpecificData?.proxyPoolId);
      const proxyOptions = isNew
        ? newSlotProxyOptions
        : await resolveConnectionProxyConfig(existing.providerSpecificData);
      const probed = await probeSlot({ cookieHeader, authUser, proxyPoolId, proxyOptions, signal });
      accounts.push({
        authUser,
        name: probed.account?.name,
        proxyPoolId: isNew ? proxyPoolId : undefined,
        models: probed.models,
        modelsVerifiedAt: probed.verifiedAt,
      });
    }
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
        ...(replacingCookie ? { cookieHeader, source: "paste" } : {}),
        ...(rotatedAt ? { lastRotatedAt: rotatedAt } : {}),
      },
      accounts,
      expectedRevision,
      verifiedMembers,
      signal,
    });
    return {
      session: redactSession(committed.session, committed.connections),
      connections: committed.connections.map(projectConnection),
    };
  } catch (error) {
    throw applyRepoErrorStatus(error);
  }
}

export async function removeGeminiWebSession(sessionId) {
  await ensureLegacyGeminiWebPromotion();
  try {
    await deleteGeminiWebSession(sessionId);
  } catch (error) {
    applyRepoErrorStatus(error);
    if (error?.code === GEMINI_WEB_SESSION_IN_USE) error.code = "cookie_session_in_use";
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
