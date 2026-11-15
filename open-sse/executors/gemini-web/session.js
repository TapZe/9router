// Gemini Web account sessions: jar resolution, PSIDTS rotation and the
// bootstrap cache.
//
// A jar is one stored Cookie header for a browser session; a routable account
// is that jar plus a Google account slot. Bootstrap state is cached per
// (connection, jar, slot, cookie revision, effective proxy) because Google's
// tokens are per account, and rotating a shared jar must never race another
// request for the same account.

import { createHash } from "node:crypto";

import { withCredentialRefreshLock } from "../../services/oauthCredentialManager.js";
import { getGeminiCookieValue, normalizeGeminiCookieInput } from "../../utils/geminiCookies.js";
import {
  GEMINI_WEB_ENDPOINTS,
  GEMINI_WEB_LIMITS,
  GEMINI_WEB_USER_AGENT,
  geminiWebError,
  normalizeAuthUser,
  throwIfAborted,
  upstreamError,
} from "./config.js";
import { bootstrapGeminiWeb } from "./protocol.js";
import { fetchGeminiWeb as defaultTransport } from "./transport.js";

const PSID_COOKIE = "__Secure-1PSID";
const PSIDTS_COOKIE = "__Secure-1PSIDTS";

const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const BOOTSTRAP_CACHE_LIMIT = 100;
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROTATION_BACKOFF_MS = 10 * 60 * 1000;

/** Cached bootstrap state keyed by the full request identity. */
const bootstrapCache = new Map();
/** Per-account rotation backoff after a failed attempt. */
const rotationBackoff = new Map();


function psidOf(header) {
  return getGeminiCookieValue(header, PSID_COOKIE) || "";
}

function psidtsOf(header) {
  return getGeminiCookieValue(header, PSIDTS_COOKIE) || "";
}

function readProviderSpecificString(providerSpecificData, keys) {
  if (
    !providerSpecificData ||
    typeof providerSpecificData !== "object" ||
    Array.isArray(providerSpecificData)
  ) {
    return "";
  }
  for (const key of keys) {
    const value = providerSpecificData[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Cookie header for credentials that predate the session store. The stored jar
 * wins whenever one exists; this only serves legacy rows.
 */
function legacyCookieHeader(credentials) {
  const direct = [credentials?.apiKey, credentials?.cookie]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  if (direct) return normalizeGeminiCookieInput(direct);

  const data = credentials?.providerSpecificData;
  const cookie = readProviderSpecificString(data, ["cookie"]);
  if (cookie) return normalizeGeminiCookieInput(cookie);

  const psid = readProviderSpecificString(data, [PSID_COOKIE]);
  const psidts = readProviderSpecificString(data, [PSIDTS_COOKIE]);
  return [
    psid ? normalizeGeminiCookieInput(psid, PSID_COOKIE) : "",
    psidts ? normalizeGeminiCookieInput(psidts, PSIDTS_COOKIE) : "",
  ]
    .filter(Boolean)
    .join("; ");
}

async function readJar(credentials) {
  const accessor = credentials?.geminiWebSession;
  if (!accessor || typeof accessor.read !== "function") return null;
  const record = await accessor.read();
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (typeof record.cookieHeader !== "string" || !record.cookieHeader.trim()) return null;
  return record;
}

/** Replace one cookie value in place, preserving the jar's other cookies. */
function rewriteCookie(header, cookieName, value) {
  const wanted = cookieName.toLowerCase();
  const parts = [];
  let replaced = false;
  for (const part of String(header ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const name = trimmed.slice(0, index).trim();
    if (name.toLowerCase() === wanted) {
      parts.push(`${name}=${value}`);
      replaced = true;
      continue;
    }
    parts.push(trimmed);
  }
  if (!replaced) parts.push(`${cookieName}=${value}`);
  return normalizeGeminiCookieInput(parts.join("; "));
}

function proxyIdentity(proxyOptions) {
  if (!proxyOptions || typeof proxyOptions !== "object") return "none";
  return [
    proxyOptions.connectionProxyEnabled ? "1" : "0",
    proxyOptions.connectionProxyUrl || "",
    proxyOptions.connectionNoProxy || "",
    proxyOptions.proxyPoolId || "",
    proxyOptions.vercelRelayUrl || "",
    proxyOptions.strictProxy ? "1" : "0",
  ].join("|");
}

/**
 * Bootstrap state identifies one account: the connection, its jar, the slot,
 * the jar revision and the effective proxy. The cookie digest keeps legacy
 * callers that pass a bare header (no jar record, so no revision) from ever
 * reusing another credential's tokens.
 */
function cacheKeyOf({ connectionId, sessionId, authUser, revision, cookie, proxyOptions }) {
  return JSON.stringify([
    connectionId || "",
    sessionId || "",
    authUser,
    revision === null || revision === undefined ? "" : String(revision),
    createHash("sha256").update(String(cookie || "")).digest("hex").slice(0, 16),
    proxyIdentity(proxyOptions),
  ]);
}

function readCache(key) {
  const entry = bootstrapCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    bootstrapCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  bootstrapCache.delete(key);
  bootstrapCache.set(key, entry);
  return entry.value;
}

function writeCache(key, value) {
  bootstrapCache.delete(key);
  bootstrapCache.set(key, { value, expiresAt: Date.now() + BOOTSTRAP_TTL_MS });
  while (bootstrapCache.size > BOOTSTRAP_CACHE_LIMIT) {
    const oldest = bootstrapCache.keys().next();
    if (oldest.done) break;
    bootstrapCache.delete(oldest.value);
  }
}

/** Drop every cached bootstrap token. Used by tests and explicit refreshes. */
export function resetGeminiWebSessionCache() {
  bootstrapCache.clear();
  rotationBackoff.clear();
}

export function publicGeminiWebModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter((model) => model && typeof model.id === "string" && model.id)
    .map((model) => ({ id: model.id, name: typeof model.name === "string" ? model.name : "" }));
}

async function recordCatalog(credentials, entry) {
  const recorder = credentials?.geminiWebSession?.recordModels;
  if (typeof recorder !== "function") return;
  if (entry.cookieRevision === null || entry.cookieRevision === undefined) return;
  const publicModels = publicGeminiWebModels(entry.session?.models);
  if (publicModels.length === 0) return;
  try {
    await recorder({
      authUser: entry.authUser,
      cookieRevision: entry.cookieRevision,
      models: publicModels,
      verifiedAt: new Date().toISOString(),
    });
  } catch {
    // The catalog is a derived cache; a stale revision must not fail the request.
  }
}

function rotationDue(record) {
  const header = record?.cookieHeader || "";
  if (!psidOf(header)) return false;
  if (!psidtsOf(header)) return true;
  const last = record?.lastRotatedAt ? Date.parse(record.lastRotatedAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= ROTATION_INTERVAL_MS;
}

/**
 * Read one rotated PSIDTS out of a RotateCookies response. Each Set-Cookie is
 * inspected separately: an Expires attribute contains a comma, so splitting
 * the combined header would corrupt the value.
 */
function readRotatedPsidts(response) {
  const getter = response?.headers?.getSetCookie;
  const cookies = typeof getter === "function" ? response.headers.getSetCookie() : [];
  for (const entry of Array.isArray(cookies) ? cookies : []) {
    const segments = String(entry).split(";");
    const pair = segments.shift() ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    if (pair.slice(0, index).trim().toLowerCase() !== PSIDTS_COOKIE.toLowerCase()) continue;
    const value = pair.slice(index + 1).trim();
    if (!value) continue;

    const attributes = segments.map((segment) => segment.trim().toLowerCase());
    if (!attributes.includes("secure")) continue;
    const domain = attributes.find((attribute) => attribute.startsWith("domain="));
    if (domain) {
      const host = domain.slice("domain=".length).trim();
      const allowed =
        host === "google.com" ||
        host === ".google.com" ||
        host === "accounts.google.com" ||
        host === ".accounts.google.com";
      if (!allowed) continue;
    }
    return value;
  }
  return null;
}

async function requestRotation({ cookie, signal, proxyOptions, transport }) {
  const fetchImpl = transport || defaultTransport;
  const proxy = { ...(proxyOptions || {}), strictProxy: true };
  return fetchImpl(
    GEMINI_WEB_ENDPOINTS.rotateCookies,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        origin: "https://accounts.google.com",
        referer: "https://accounts.google.com/",
        "user-agent": GEMINI_WEB_USER_AGENT,
        cookie,
      },
      body: "",
      redirect: "manual",
      strictTls: true,
      maxHeaderSize: GEMINI_WEB_LIMITS.maxHeaderSize,
      timeoutMs: GEMINI_WEB_LIMITS.bootstrapTimeoutMs,
      signal,
    },
    proxy
  );
}

async function commitOrReload(credentials, patch) {
  try {
    return await credentials.geminiWebSession.commit(patch);
  } catch (error) {
    // A concurrent manual replacement wins; reload its jar instead of overwriting.
    if (error?.code === "GEMINI_WEB_SESSION_CONFLICT") {
      const reloaded = await readJar(credentials);
      if (reloaded) return reloaded;
    }
    throw error;
  }
}

function rotationKey(credentials, authUser, psid) {
  const sessionId = credentials?.geminiWebSession?.id || "";
  const digest = createHash("sha256").update(psid).digest("hex");
  return `${sessionId}:${authUser}:${digest}`;
}

/**
 * Rotate the shared PSIDTS when it is due. Rotation only ever sends the two
 * account cookies, and a failure never blocks a session that still bootstraps.
 */
async function rotateIfDue({ credentials, record, authUser, signal, proxyOptions, transport }) {
  const commit = credentials?.geminiWebSession?.commit;
  if (!record || typeof commit !== "function") return { record, rotated: false };
  if (!rotationDue(record)) return { record, rotated: false };

  const psid = psidOf(record.cookieHeader);
  if (!psid) return { record, rotated: false };

  const key = rotationKey(credentials, authUser, psid);
  const backoffUntil = rotationBackoff.get(key);
  if (backoffUntil && backoffUntil > Date.now()) return { record, rotated: false };

  try {
    const updated = await withCredentialRefreshLock(
      "gemini-web-rotation",
      { connectionId: key },
      async () => {
        // Re-read inside the lock: a manual replacement may have landed.
        const fresh = (await readJar(credentials)) || record;
        if (!rotationDue(fresh)) return fresh;

        const currentPsid = psidOf(fresh.cookieHeader);
        const currentPsidts = psidtsOf(fresh.cookieHeader);
        const cookie = currentPsidts
          ? `${PSID_COOKIE}=${currentPsid}; ${PSIDTS_COOKIE}=${currentPsidts}`
          : `${PSID_COOKIE}=${currentPsid}`;

        const response = await requestRotation({ cookie, signal, proxyOptions, transport });
        if (response.status === 401 || response.status === 403) {
          throw geminiWebError(
            `Gemini Web cookie rotation was rejected with HTTP ${response.status}`,
            { status: response.status }
          );
        }
        if (!response.ok) {
          throw upstreamError(`Gemini Web cookie rotation failed with HTTP ${response.status}`);
        }

        const rotated = readRotatedPsidts(response);
        // A 200 without a new PSIDTS is a successful rotation with nothing to store.
        if (!rotated) return fresh;

        const merged = rewriteCookie(fresh.cookieHeader, PSIDTS_COOKIE, rotated);
        if (merged === fresh.cookieHeader) return fresh;

        return commitOrReload(credentials, {
          cookieHeader: merged,
          expectedRevision: fresh.revision,
          source: "rotation",
          lastRotatedAt: new Date().toISOString(),
        });
      }
    );
    rotationBackoff.delete(key);
    return { record: updated, rotated: true };
  } catch (error) {
    throwIfAborted(signal);
    rotationBackoff.set(key, Date.now() + ROTATION_BACKOFF_MS);
    return { record, rotated: false };
  }
}

/**
 * Resolve the jar and its bootstrap state for one account.
 *
 * @returns {Promise<{ session: object, authUser: string, cookieRevision: number|null, connectionId: string, sessionId: string }>}
 */
export async function resolveGeminiWebSession(credentials, options = {}) {
  const { forceRefresh = false, signal, proxyOptions, transport } = options;
  throwIfAborted(signal);

  const authUser = normalizeAuthUser(credentials?.providerSpecificData?.authUser);
  const stored = await readJar(credentials);
  const rotated = await rotateIfDue({ credentials, record: stored, authUser, signal, proxyOptions, transport });

  const jar = rotated.record;
  let cookieHeader;
  try {
    cookieHeader = jar?.cookieHeader || legacyCookieHeader(credentials);
  } catch {
    throw geminiWebError("Gemini Web cookie header is invalid", { status: 401 });
  }
  if (!cookieHeader) {
    throw geminiWebError("Missing Gemini cookies", { status: 401 });
  }

  const connectionId = credentials?.connectionId || "";
  const sessionId = credentials?.geminiWebSession?.id || "";
  const revision = jar?.revision ?? null;
  const key = cacheKeyOf({ connectionId, sessionId, authUser, revision, cookie: cookieHeader, proxyOptions });

  const cached = readCache(key);
  if (cached && !forceRefresh) return cached;

  return withCredentialRefreshLock("gemini-web-bootstrap", { connectionId: key }, async () => {
    const again = readCache(key);
    if (again && !forceRefresh) return again;

    const session = await bootstrapGeminiWeb({
      cookieHeader,
      authUser,
      signal,
      proxyOptions,
      transport,
    });

    let committedRevision = revision;
    const observedPsidts = psidtsOf(session.cookieHeader);
    const storedPsidts = psidtsOf(cookieHeader);
    const identityChanged = psidOf(session.cookieHeader) !== psidOf(cookieHeader);
    if (
      !rotated.rotated &&
      !identityChanged &&
      observedPsidts &&
      observedPsidts !== storedPsidts &&
      jar &&
      typeof credentials?.geminiWebSession?.commit === "function"
    ) {
      // Only PSIDTS is worth persisting; rollout cookies stay ephemeral.
      try {
        const updated = await commitOrReload(credentials, {
          cookieHeader: rewriteCookie(jar.cookieHeader, PSIDTS_COOKIE, observedPsidts),
          expectedRevision: jar.revision,
          source: "bootstrap",
          lastRotatedAt: new Date().toISOString(),
        });
        committedRevision = updated?.revision ?? committedRevision;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // A stale commit must not fail a session that just bootstrapped.
      }
    }

    const entry = {
      session,
      authUser,
      cookieRevision: committedRevision,
      connectionId,
      sessionId,
    };
    writeCache(key, entry);
    await recordCatalog(credentials, entry);
    return entry;
  });
}
