// Shared Gemini Web cookie jars.
//
// A jar is one stored Cookie header for a browser session; a routable account
// is a normal `providerConnections` row that references the jar plus its Google
// account slot. Jars live in the `kv` table (scope `geminiWebSessions`) so no
// schema migration is needed and the private record never leaks into a
// connection's JSON payload.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  getGeminiCookieValue,
  normalizeGeminiCookieInput,
  parseGeminiCookieHeader,
} from "open-sse/utils/geminiCookies.js";
import {
  reorderConnectionsInTransaction,
  upsertConnectionInTransaction,
} from "./connectionsRepo.js";

export const GEMINI_WEB_SESSION_KV_SCOPE = "geminiWebSessions";
export const GEMINI_WEB_SESSION_CONFLICT = "GEMINI_WEB_SESSION_CONFLICT";
export const GEMINI_WEB_SESSION_NOT_FOUND = "GEMINI_WEB_SESSION_NOT_FOUND";
export const GEMINI_WEB_SESSION_IN_USE = "GEMINI_WEB_SESSION_IN_USE";
export const GEMINI_WEB_COOKIE_INVALID = "GEMINI_WEB_COOKIE_INVALID";
export const GEMINI_WEB_SESSION_INVALID = "GEMINI_WEB_SESSION_INVALID";

const PROVIDER_ID = "gemini-web";
const PSID_COOKIE = "__Secure-1PSID";
const PSIDTS_COOKIE = "__Secure-1PSIDTS";
const SESSION_SOURCES = new Set(["paste", "web-login", "legacy", "rotation", "bootstrap"]);

function typedError(code, message, extra = null) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function normalizeSource(source) {
  if (source === undefined || source === null || source === "") return "paste";
  const value = String(source);
  if (!SESSION_SOURCES.has(value)) {
    throw typedError(GEMINI_WEB_SESSION_INVALID, `Unsupported Gemini Web session source: ${value}`);
  }
  return value;
}

/** `""` is the legacy root slot; `"0"` is the explicit `/u/0/` slot. */
export function normalizeGeminiWebAuthUser(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return String(numeric);
  }
  throw typedError(GEMINI_WEB_SESSION_INVALID, "Invalid Gemini Web account slot");
}

function authUserOf(connection) {
  return normalizeGeminiWebAuthUser(connection?.providerSpecificData?.authUser);
}

function normalizeCookieHeader(raw) {
  const header = normalizeGeminiCookieInput(raw);
  if (!header) throw typedError(GEMINI_WEB_COOKIE_INVALID, "Gemini Web cookie header is empty");
  fingerprintOf(header);
  return header;
}

function fingerprintOf(header) {
  const psid = getGeminiCookieValue(header, PSID_COOKIE);
  if (!psid || !psid.trim()) {
    throw typedError(GEMINI_WEB_COOKIE_INVALID, "Gemini Web cookie header is missing __Secure-1PSID");
  }
  return crypto.createHash("sha256").update(psid, "utf8").digest("hex").slice(0, 12);
}

function psidOf(header) {
  return getGeminiCookieValue(header, PSID_COOKIE);
}

function psidtsOf(header) {
  return getGeminiCookieValue(header, PSIDTS_COOKIE);
}

function connectionFromRow(row) {
  if (!row) return null;
  return {
    ...parseJson(row.data, {}),
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readSession(db, id) {
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [
    GEMINI_WEB_SESSION_KV_SCOPE,
    String(id ?? ""),
  ]);
  const record = row ? parseJson(row.value, null) : null;
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

function readAllSessions(db) {
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [GEMINI_WEB_SESSION_KV_SCOPE]);
  const list = rows
    .map((row) => parseJson(row.value, null))
    .filter((record) => record && typeof record === "object" && !Array.isArray(record));
  list.sort((a, b) => {
    const left = String(a.createdAt || "");
    const right = String(b.createdAt || "");
    if (left !== right) return left < right ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  return list;
}

function writeSession(db, record) {
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [GEMINI_WEB_SESSION_KV_SCOPE, record.id, stringifyJson(record)]
  );
}

function removeSession(db, id) {
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [GEMINI_WEB_SESSION_KV_SCOPE, String(id)]);
}

function listLinkedConnections(db, sessionId) {
  return db
    .all(`SELECT * FROM providerConnections WHERE provider = ?`, [PROVIDER_ID])
    .map(connectionFromRow)
    .filter((connection) => connection?.providerSpecificData?.geminiWebSessionId === sessionId)
    .sort((a, b) => {
      const priorityDiff = (a.priority || 0) - (b.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

function nextConnectionPriority(db) {
  const row = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [
    PROVIDER_ID,
  ]);
  return (Number(row?.m) || 0) + 1;
}

function findSessionByPsid(db, psid, excludeId = null) {
  const sessions = readAllSessions(db);
  return sessions.find((session) => session.id !== excludeId && psidOf(session.cookieHeader) === psid) || null;
}

function samePersistedFields(current, next) {
  return (
    current.name === next.name &&
    current.cookieHeader === next.cookieHeader &&
    current.source === next.source &&
    (current.lastRotatedAt ?? null) === (next.lastRotatedAt ?? null)
  );
}

function membershipSignature(connections) {
  return connections
    .map((connection) => `${connection.id}\u0000${authUserOf(connection)}`)
    .sort()
    .join("\u0001");
}

function assertVerifiedMembership(db, sessionId, verifiedMembers) {
  const current = listLinkedConnections(db, sessionId);
  const currentById = new Map(current.map((connection) => [connection.id, authUserOf(connection)]));
  const pendingSlots = new Set(
    verifiedMembers.filter((member) => !member.connectionId).map((member) => member.authUser)
  );

  for (const [connectionId, authUser] of currentById) {
    const verified = verifiedMembers.find((member) => member.connectionId === connectionId);
    if (verified) {
      if (verified.authUser !== authUser) {
        throw typedError(
          GEMINI_WEB_SESSION_CONFLICT,
          "Gemini Web account membership changed during verification"
        );
      }
      continue;
    }
    // A slot verified as "to be created" may already exist when an identical
    // concurrent commit landed first; it still counts as the verified member.
    if (pendingSlots.has(authUser)) continue;
    throw typedError(
      GEMINI_WEB_SESSION_CONFLICT,
      "Gemini Web account membership changed during verification"
    );
  }

  for (const member of verifiedMembers) {
    if (member.connectionId && !currentById.has(member.connectionId)) {
      throw typedError(
        GEMINI_WEB_SESSION_CONFLICT,
        "Gemini Web account membership changed during verification"
      );
    }
  }
}

function normalizeAccountList(accounts) {
  if (!Array.isArray(accounts)) {
    throw typedError(GEMINI_WEB_SESSION_INVALID, "Gemini Web accounts must be an array");
  }
  const seen = new Set();
  const list = [];
  for (const account of accounts) {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw typedError(GEMINI_WEB_SESSION_INVALID, "Invalid Gemini Web account entry");
    }
    const authUser = normalizeGeminiWebAuthUser(account.authUser);
    if (seen.has(authUser)) continue;
    seen.add(authUser);
    const proxyPoolId =
      typeof account.proxyPoolId === "string" && account.proxyPoolId ? account.proxyPoolId : null;
    list.push({
      authUser,
      name: typeof account.name === "string" && account.name.trim() ? account.name.trim() : null,
      proxyPoolId,
      models: Array.isArray(account.models) ? account.models : null,
      modelsVerifiedAt: normalizeTimestamp(account.modelsVerifiedAt),
    });
  }
  return list;
}

function normalizeVerifiedMembers(verifiedMembers) {
  if (verifiedMembers === undefined || verifiedMembers === null) return [];
  if (!Array.isArray(verifiedMembers)) {
    throw typedError(GEMINI_WEB_SESSION_INVALID, "verifiedMembers must be an array");
  }
  return verifiedMembers.map((member) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw typedError(GEMINI_WEB_SESSION_INVALID, "Invalid verified member");
    }
    const connectionId =
      typeof member.connectionId === "string" && member.connectionId ? member.connectionId : null;
    return { connectionId, authUser: normalizeGeminiWebAuthUser(member.authUser) };
  });
}

function sanitizePublicModels(models) {
  if (!Array.isArray(models)) {
    throw typedError(GEMINI_WEB_SESSION_INVALID, "Gemini Web models must be an array");
  }
  return models.map((model) => {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id) throw typedError(GEMINI_WEB_SESSION_INVALID, "Gemini Web model id is required");
    const name = typeof model.name === "string" ? model.name : "";
    return { id, name };
  });
}

function rewriteCookieValue(header, cookieName, value) {
  const pairs = parseGeminiCookieHeader(header);
  const wanted = cookieName.toLowerCase();
  const parts = [];
  let replaced = false;
  for (const [name, existing] of Object.entries(pairs)) {
    if (name.toLowerCase() === wanted) {
      parts.push(`${name}=${value}`);
      replaced = true;
    } else {
      parts.push(`${name}=${existing}`);
    }
  }
  if (!replaced) parts.push(`${cookieName}=${value}`);
  return normalizeGeminiCookieInput(parts.join("; "));
}

function writeModelCatalog(db, connectionId, catalog) {
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [connectionId]);
  if (!row) return;
  const connection = connectionFromRow(row);
  upsertConnectionInTransaction(db, {
    ...connection,
    geminiWebModelCatalog: catalog,
    updatedAt: nowIso(),
  });
}

export async function listGeminiWebSessions() {
  const db = await getAdapter();
  return readAllSessions(db);
}

export async function getGeminiWebSession(id) {
  if (typeof id !== "string" || !id) return null;
  const db = await getAdapter();
  return readSession(db, id);
}

/**
 * Insert a jar or commit a revision-checked update.
 *
 * `expectedRevision` is required for updates: the record is re-read inside the
 * transaction, so a stale writer cannot overwrite a newer cookie.
 */
export async function saveGeminiWebSession(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw typedError(GEMINI_WEB_SESSION_INVALID, "Invalid Gemini Web session record");
  }
  const db = await getAdapter();
  const now = nowIso();
  let result;

  db.transaction(() => {
    if (typeof record.id === "string" && record.id) {
      const current = readSession(db, record.id);
      if (!current) {
        throw typedError(
          GEMINI_WEB_SESSION_NOT_FOUND,
          `Gemini Web session ${record.id} not found`
        );
      }
      const expected = options.expectedRevision;
      if (expected !== undefined && expected !== null && Number(current.revision) !== Number(expected)) {
        throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web session revision is stale");
      }

      const next = { ...current };
      if (record.name !== undefined) next.name = String(record.name ?? "").trim();
      if (record.cookieHeader !== undefined) {
        next.cookieHeader = normalizeCookieHeader(record.cookieHeader);
        next.fingerprint = fingerprintOf(next.cookieHeader);
      }
      if (record.source !== undefined) next.source = normalizeSource(record.source);
      if (Object.hasOwn(record, "lastRotatedAt")) {
        next.lastRotatedAt = normalizeTimestamp(record.lastRotatedAt);
      }

      if (samePersistedFields(current, next)) {
        result = current;
        return;
      }
      next.revision = Number(current.revision) + 1;
      next.updatedAt = now;
      writeSession(db, next);
      result = next;
      return;
    }

    const cookieHeader = normalizeCookieHeader(record.cookieHeader);
    const created = {
      id: uuidv4(),
      name: String(record.name ?? "").trim(),
      cookieHeader,
      fingerprint: fingerprintOf(cookieHeader),
      revision: 1,
      source: normalizeSource(record.source),
      createdAt: now,
      updatedAt: now,
      lastRotatedAt: normalizeTimestamp(record.lastRotatedAt),
    };
    writeSession(db, created);
    result = created;
  });

  return result;
}

/**
 * Commit a cookie replacement.
 *
 * Rotation/bootstrap updates additionally copy `__Secure-1PSIDTS` into every
 * jar that still presents the initiating jar's pre-update PSID and PSIDTS pair.
 * Other cookies, and jars whose PSIDTS already moved, are never rewritten.
 */
export async function commitGeminiWebCookieUpdate(id, params = {}) {
  const { cookieHeader, expectedRevision, source, lastRotatedAt } = params;
  const sessionId = String(id ?? "");
  const nextHeader = normalizeCookieHeader(cookieHeader);
  const nextSource = source === undefined || source === null || source === "" ? null : normalizeSource(source);
  const hasRotationTime = Object.hasOwn(params, "lastRotatedAt");
  const rotatedAt = hasRotationTime ? normalizeTimestamp(lastRotatedAt) : null;
  const db = await getAdapter();
  const now = nowIso();
  let result;

  db.transaction(() => {
    const current = readSession(db, sessionId);
    if (!current) {
      throw typedError(GEMINI_WEB_SESSION_NOT_FOUND, `Gemini Web session ${sessionId} not found`);
    }
    if (Number(current.revision) !== Number(expectedRevision)) {
      throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web session revision is stale");
    }

    const previousPsid = psidOf(current.cookieHeader);
    const previousPsidts = psidtsOf(current.cookieHeader);
    const nextPsid = psidOf(nextHeader);
    const nextPsidts = psidtsOf(nextHeader);

    const updated = {
      ...current,
      cookieHeader: nextHeader,
      fingerprint: fingerprintOf(nextHeader),
      source: nextSource ?? current.source,
    };
    if (hasRotationTime) updated.lastRotatedAt = rotatedAt;
    if (samePersistedFields(current, updated)) {
      result = current;
    } else {
      updated.revision = Number(current.revision) + 1;
      updated.updatedAt = now;
      writeSession(db, updated);
      result = updated;
    }

    const rotatesSharedCookies = nextSource === "rotation" || nextSource === "bootstrap";
    if (
      !rotatesSharedCookies ||
      nextPsid !== previousPsid ||
      !nextPsidts ||
      nextPsidts === previousPsidts
    ) {
      return;
    }

    for (const target of readAllSessions(db)) {
      if (target.id === current.id) continue;
      if (psidOf(target.cookieHeader) !== previousPsid) continue;
      if (psidtsOf(target.cookieHeader) !== previousPsidts) continue;
      const rewritten = rewriteCookieValue(target.cookieHeader, PSIDTS_COOKIE, nextPsidts);
      if (rewritten === target.cookieHeader) continue;
      writeSession(db, {
        ...target,
        cookieHeader: rewritten,
        fingerprint: fingerprintOf(rewritten),
        revision: Number(target.revision) + 1,
        updatedAt: now,
      });
    }
  });

  return result;
}

export async function deleteGeminiWebSession(id) {
  const sessionId = String(id ?? "");
  const db = await getAdapter();
  let deleted = false;

  db.transaction(() => {
    const current = readSession(db, sessionId);
    if (!current) return;
    if (listLinkedConnections(db, sessionId).length > 0) {
      throw typedError(
        GEMINI_WEB_SESSION_IN_USE,
        "Gemini Web session still has linked accounts"
      );
    }
    removeSession(db, sessionId);
    deleted = true;
  });

  return deleted;
}

/**
 * Remove one routable account row and leave its jar and sibling slots usable.
 *
 * Returns false when the connection is already gone so callers can answer idempotently.
 */
export async function detachGeminiWebAccount(connectionId) {
  const id = String(connectionId ?? "");
  const db = await getAdapter();
  const now = nowIso();
  let detached = false;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    const connection = connectionFromRow(row);
    const sessionId = connection.providerSpecificData?.geminiWebSessionId;

    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderConnectionsInTransaction(db, row.provider);

    if (typeof sessionId === "string" && sessionId) {
      const jar = readSession(db, sessionId);
      if (jar) {
        writeSession(db, {
          ...jar,
          revision: Number(jar.revision) + 1,
          updatedAt: now,
        });
      }
    }
    detached = true;
  });

  return detached;
}

function resolveLegacyCookieHeader(connection) {
  const providerSpecificData = connection?.providerSpecificData;
  const direct = [connection?.apiKey, connection?.cookie].find(
    (value) => typeof value === "string" && value.trim().length > 0
  );
  try {
    if (direct) {
      const header = normalizeGeminiCookieInput(direct);
      return psidOf(header) ? header : "";
    }
    if (!providerSpecificData || typeof providerSpecificData !== "object") return "";
    const cookie = providerSpecificData.cookie;
    if (typeof cookie === "string" && cookie.trim()) {
      const header = normalizeGeminiCookieInput(cookie);
      return psidOf(header) ? header : "";
    }
    const psid = providerSpecificData[PSID_COOKIE];
    const psidts = providerSpecificData[PSIDTS_COOKIE];
    if (typeof psid !== "string" || !psid.trim()) return "";
    const parts = [normalizeGeminiCookieInput(psid, PSID_COOKIE)];
    if (typeof psidts === "string" && psidts.trim()) {
      parts.push(normalizeGeminiCookieInput(psidts, PSIDTS_COOKIE));
    }
    const header = normalizeGeminiCookieInput(parts.join("; "));
    return psidOf(header) ? header : "";
  } catch {
    // A malformed legacy value is a recapture case, not a reason to abort the
    // whole migration: the row stays intact and is reported as skipped.
    return "";
  }
}

/**
 * Move legacy per-row credentials into shared jars.
 *
 * Rows keep their id, name, priority, enabled state and unrelated data. Rows
 * with no usable cookie stay untouched and are reported so the dashboard can
 * ask for a recapture. Running it twice creates and changes nothing.
 */
export async function migrateLegacyGeminiWebConnections() {
  const db = await getAdapter();
  const now = nowIso();
  const createdSessionIds = [];
  const migratedConnectionIds = [];
  const skippedConnectionIds = [];

  db.transaction(() => {
    const sessions = readAllSessions(db);
    const sessionsByHeader = new Map(sessions.map((session) => [session.cookieHeader, session]));
    const rows = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [PROVIDER_ID]);

    for (const row of rows) {
      const connection = connectionFromRow(row);
      const existingSessionId = connection.providerSpecificData?.geminiWebSessionId;
      if (typeof existingSessionId === "string" && existingSessionId) continue;

      const cookieHeader = resolveLegacyCookieHeader(connection);
      if (!cookieHeader) {
        skippedConnectionIds.push(row.id);
        continue;
      }

      let session = sessionsByHeader.get(cookieHeader);
      if (!session) {
        session = {
          id: uuidv4(),
          name: connection.name || "Gemini Web session",
          cookieHeader,
          fingerprint: fingerprintOf(cookieHeader),
          revision: 1,
          source: "legacy",
          createdAt: now,
          updatedAt: now,
          lastRotatedAt: null,
        };
        writeSession(db, session);
        sessionsByHeader.set(cookieHeader, session);
        createdSessionIds.push(session.id);
      }

      const providerSpecificData = {
        ...(connection.providerSpecificData || {}),
        geminiWebSessionId: session.id,
        authUser: "",
      };
      delete providerSpecificData.cookie;
      delete providerSpecificData[PSID_COOKIE];
      delete providerSpecificData[PSIDTS_COOKIE];

      const migrated = {
        ...connection,
        providerSpecificData,
        updatedAt: now,
      };
      delete migrated.apiKey;
      delete migrated.cookie;
      upsertConnectionInTransaction(db, migrated);
      migratedConnectionIds.push(row.id);
    }
  });

  return { createdSessionIds, migratedConnectionIds, skippedConnectionIds };
}

/**
 * Atomically bind a jar and its routable account rows after probes succeeded.
 *
 * Existing pairs keep their name, priority and proxy; new children get a UUID,
 * the next priority and the explicitly resolved proxy for their slot.
 */
export async function commitGeminiWebAccountSet(params = {}) {
  const sessionInput =
    params.session && typeof params.session === "object" && !Array.isArray(params.session)
      ? params.session
      : {};
  const accounts = normalizeAccountList(params.accounts);
  const verifiedMembers = normalizeVerifiedMembers(params.verifiedMembers);
  const expectedRevision = params.expectedRevision;
  const db = await getAdapter();
  const now = nowIso();
  let result;

  db.transaction(() => {
    params.signal?.throwIfAborted();
    let jar;
    let created = false;
    let cookieChanged = false;
    let metadataChanged = false;

    if (typeof sessionInput.id === "string" && sessionInput.id) {
      const current = readSession(db, sessionInput.id);
      if (!current) {
        throw typedError(
          GEMINI_WEB_SESSION_NOT_FOUND,
          `Gemini Web session ${sessionInput.id} not found`
        );
      }
      if (
        expectedRevision !== undefined &&
        expectedRevision !== null &&
        Number(current.revision) !== Number(expectedRevision)
      ) {
        throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web session revision is stale");
      }
      assertVerifiedMembership(db, current.id, verifiedMembers);
      jar = current;
      if (sessionInput.name !== undefined) {
        const name = String(sessionInput.name ?? "").trim();
        if (name !== jar.name) {
          jar = { ...jar, name };
          metadataChanged = true;
        }
      }
    } else {
      const cookieHeader = normalizeCookieHeader(sessionInput.cookieHeader);
      const psid = psidOf(cookieHeader);
      const existing = findSessionByPsid(db, psid);
      if (existing && existing.cookieHeader !== cookieHeader) {
        throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web cookie session already exists", {
          existingSessionId: existing.id,
        });
      }
      if (existing) {
        assertVerifiedMembership(db, existing.id, verifiedMembers);
        jar = existing;
      } else {
        jar = {
          id: uuidv4(),
          name: String(sessionInput.name ?? "").trim(),
          cookieHeader,
          fingerprint: fingerprintOf(cookieHeader),
          revision: 1,
          source: normalizeSource(sessionInput.source),
          createdAt: now,
          updatedAt: now,
          lastRotatedAt: normalizeTimestamp(sessionInput.lastRotatedAt),
        };
        created = true;
      }
    }

    if (!created && sessionInput.cookieHeader !== undefined) {
      const cookieHeader = normalizeCookieHeader(sessionInput.cookieHeader);
      if (cookieHeader !== jar.cookieHeader) {
        if (psidOf(cookieHeader) !== psidOf(jar.cookieHeader)) {
          const conflicting = findSessionByPsid(db, psidOf(cookieHeader), jar.id);
          if (conflicting) {
            throw typedError(
              GEMINI_WEB_SESSION_CONFLICT,
              "Gemini Web cookie session already exists",
              { existingSessionId: conflicting.id }
            );
          }
        }
        jar = {
          ...jar,
          cookieHeader,
          fingerprint: fingerprintOf(cookieHeader),
          lastRotatedAt: Object.hasOwn(sessionInput, "lastRotatedAt")
            ? normalizeTimestamp(sessionInput.lastRotatedAt)
            : jar.lastRotatedAt,
        };
        cookieChanged = true;
      }
    }

    const linked = listLinkedConnections(db, jar.id);
    const membershipBefore = membershipSignature(linked);
    const connections = [];
    let nextPriority = nextConnectionPriority(db);

    for (const account of accounts) {
      const existing = linked.find((connection) => authUserOf(connection) === account.authUser);
      if (existing) {
        connections.push(existing);
        continue;
      }
      const providerSpecificData = {
        geminiWebSessionId: jar.id,
        authUser: account.authUser,
      };
      if (account.proxyPoolId) providerSpecificData.proxyPoolId = account.proxyPoolId;
      const connection = {
        id: uuidv4(),
        provider: PROVIDER_ID,
        authType: "cookie",
        name: account.name || jar.name || null,
        email: null,
        priority: nextPriority,
        isActive: true,
        apiKey: "",
        testStatus: "active",
        providerSpecificData,
        createdAt: now,
        updatedAt: now,
      };
      nextPriority += 1;
      upsertConnectionInTransaction(db, connection);
      connections.push(connection);
    }

    if (!created && (cookieChanged || metadataChanged || membershipSignature(connections) !== membershipBefore)) {
      jar = {
        ...jar,
        revision: Number(jar.revision) + 1,
        updatedAt: now,
      };
    }

    const catalogWrites = accounts.filter((account) => account.models);

    writeSession(db, jar);

    for (const connection of connections) {
      const account = catalogWrites.find(
        (entry) => entry.authUser === authUserOf(connection)
      );
      if (!account) continue;
      writeModelCatalog(db, connection.id, {
        sessionId: jar.id,
        authUser: account.authUser,
        cookieRevision: Number(jar.revision),
        models: sanitizePublicModels(account.models),
        verifiedAt: account.modelsVerifiedAt || now,
      });
    }

    result = { session: jar, connections };
  });

  return result;
}

/**
 * Store the safe public model catalog for one verified account slot.
 *
 * Routing ids, tokens and cookies never enter the connection payload; only
 * `{ id, name }` survives, and the write is rejected unless the connection
 * still points at the verified session and slot at the verified revision.
 */
export async function recordGeminiWebModels(connectionId, params = {}) {
  const { sessionId, authUser, cookieRevision, models, verifiedAt } = params;
  const id = String(connectionId ?? "");
  const expectedSlot = normalizeGeminiWebAuthUser(authUser);
  const db = await getAdapter();
  let catalog = null;

  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) {
      throw typedError(GEMINI_WEB_SESSION_NOT_FOUND, `Gemini Web connection ${id} not found`);
    }
    const connection = connectionFromRow(row);
    if (connection.providerSpecificData?.geminiWebSessionId !== sessionId) {
      throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web connection jar changed");
    }
    if (authUserOf(connection) !== expectedSlot) {
      throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web connection slot changed");
    }
    const jar = readSession(db, sessionId);
    if (!jar) {
      throw typedError(GEMINI_WEB_SESSION_NOT_FOUND, `Gemini Web session ${sessionId} not found`);
    }
    if (Number(jar.revision) !== Number(cookieRevision)) {
      throw typedError(GEMINI_WEB_SESSION_CONFLICT, "Gemini Web session revision is stale");
    }

    catalog = {
      sessionId: jar.id,
      authUser: expectedSlot,
      cookieRevision: Number(cookieRevision),
      models: sanitizePublicModels(models),
      verifiedAt: normalizeTimestamp(verifiedAt) || nowIso(),
    };
    upsertConnectionInTransaction(db, {
      ...connection,
      geminiWebModelCatalog: catalog,
      updatedAt: nowIso(),
    });
  });

  return catalog;
}

/**
 * Validate a backup's session set before importDb touches anything.
 *
 * Returns the canonical records to write. Missing property (older backups) is
 * an empty set; malformed records, duplicate ids and conflicting fingerprints
 * are refused.
 */
export function validateGeminiWebSessionRecords(records) {
  if (records === undefined || records === null) return [];
  if (!Array.isArray(records)) {
    throw new Error("geminiWebSessions must be an array");
  }
  const seen = new Set();
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid geminiWebSessions record");
    }
    if (typeof record.id !== "string" || !record.id) {
      throw new Error("geminiWebSessions record is missing an id");
    }
    if (seen.has(record.id)) {
      throw new Error(`Duplicate geminiWebSessions record ${record.id}`);
    }
    seen.add(record.id);
    if (typeof record.name !== "string") {
      throw new Error(`geminiWebSessions ${record.id}: name must be a string`);
    }
    const cookieHeader = normalizeCookieHeader(record.cookieHeader);
    const fingerprint = fingerprintOf(cookieHeader);
    const revision = Number(record.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error(`geminiWebSessions ${record.id}: revision must be a positive integer`);
    }
    if (record.fingerprint !== undefined && record.fingerprint !== fingerprint) {
      throw new Error(`geminiWebSessions ${record.id}: fingerprint does not match cookie`);
    }
    if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
      throw new Error(`geminiWebSessions ${record.id}: timestamps are required`);
    }
    return {
      id: record.id,
      name: record.name,
      cookieHeader,
      fingerprint,
      revision,
      source: normalizeSource(record.source),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastRotatedAt: normalizeTimestamp(record.lastRotatedAt),
    };
  });
}
