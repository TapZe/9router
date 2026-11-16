// Interactive web login capture for web-cookie providers.
//
// Opens a persistent HEADED Chrome window at the provider's login page using a
// per-provider profile under <DATA_DIR>/browser-profiles/web-login/. The user
// logs in by hand (and clears any Cloudflare challenge in that window); we
// poll the context until every required token from webLoginConfig is present,
// then serialize the whole cookie jar as a paste-equivalent credential.
//
// The profile persists, so a repeat login usually finds the session still
// alive and resolves in one poll — and a warm profile keeps cf_clearance.
//
// Providers with `explicitCapture` (Gemini Web) stop at a `captured` state
// instead: one browser session can carry several Google accounts, so the
// caller chooses the tab/slot, then acknowledges the save. The browser only
// closes after that acknowledgement, which lets the operator add every account
// of a shared Google login in one window.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { join } from "node:path";
import { loadRuntimeDep } from "./lazyRuntime.js";
import { getWebLoginConfig } from "./webLoginConfig.js";
import { getWritableDataDir } from "../utils/writableDataDir.js";
import { pruneProfileCaches, formatBytes } from "./browserProfileCache.js";
import { resolveSystemChromeExecutable } from "../executors/browserExecutableCheck.js";
import { normalizeGeminiCookieInput } from "../utils/geminiCookies.js";

const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 300000;
const VERIFY_TIMEOUT_MS = 60000;
// A captured-but-unsaved session must not hold a Chrome window forever.
const CAPTURE_HOLD_TIMEOUT_MS = 300000;

// Shared browser profiles: one Google login in a profile makes every
// "Continue with Google" provider login a single click.
function profileDir(profileName) {
  return path.join(getWritableDataDir(), "browser-profiles", sanitizeProfileName(profileName));
}

function matchesDomain(cookieDomain, cookie) {
  const want = String(cookieDomain || "").replace(/^\./, "").toLowerCase();
  const host = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
  return !want || host === want || host.endsWith(`.${want}`);
}

/** Direct cookie value, or the joined `.0/.1/…` chunks (NextAuth/Supabase split large values). */
function findCookieValue(jar, source) {
  for (const name of [source.name, ...(source.names || [])]) {
    if (!name) continue;
    const direct = jar.get(name);
    if (direct) return direct;
    const chunks = new Map();
    for (const [cookieName, value] of jar) {
      if (!cookieName.startsWith(`${name}.`)) continue;
      const idx = Number(cookieName.split(".").pop());
      if (Number.isInteger(idx)) chunks.set(idx, value);
    }
    const joined = [];
    for (let i = 0; chunks.has(i); i++) joined.push(chunks.get(i));
    if (joined.length) return joined.join("");
  }
  return null;
}

/**
 * Read the required tokens from a live browser context.
 * Returns { ready, cookieHeader, localStorageValues }.
 * Exported so the login flow can be exercised without a real browser.
 */
export async function harvest(context, config) {
  const cookies = (await context.cookies()).filter((cookie) => matchesDomain(config.cookieDomain, cookie));
  const jar = new Map(cookies.map((cookie) => [cookie.name, cookie.value]));
  const localStorageValues = {};
  for (const page of context.pages()) {
    if (localStorageValues[config.tokenSources[0]?.name]) break;
    try {
      const url = page.url();
      if (!/^https?:/.test(url)) continue;
      const found = await page.evaluate((names) => {
        const out = {};
        for (const name of names) {
          const value = window.localStorage?.getItem(name);
          if (value) out[name] = value;
        }
        return out;
      }, config.tokenSources.filter((source) => source.type === "localStorage").map((source) => source.name));
      Object.assign(localStorageValues, found);
    } catch {
      // Page may be mid-navigation; try the next page.
    }
  }
  const ready = config.tokenSources.every((source) => {
    const value = source.type === "cookie"
      ? findCookieValue(jar, source)
      : (localStorageValues[source.name] || null);
    // Optional sources enrich the credential without gating completion.
    if (source.optional) return true;
    if (!value) return false;
    if (source.validateCookie) return source.validateCookie(value);
    if (source.validateToken) return source.validateToken(value);
    if (config.validateToken) return config.validateToken(value);
    if (config.validateCookie) return config.validateCookie(value);
    return true;
  });
  const cookieHeader = cookies
    .filter((cookie) => cookie.value)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return { ready, cookieHeader, localStorageValues };
}

// providerId -> session
const sessions = new Map();

// One Chromium lock per profile dir: a second launch on the same persistent
// profile fails, so refuse up front with an actionable message.
const busyProfiles = new Map(); // profileName -> session

// Stable, opaque ids for the pages of one context. Capture responses never
// echo a URL, so the dashboard cannot learn arbitrary browsing history.
let pageIds = new WeakMap();
let pageIdCounter = 0;

// Injectable clock/launcher so the capture state machine can be exercised
// without Chrome or wall-clock waits. Production falls back to these.
const defaultRuntime = {
  now: () => Date.now(),
  pollIntervalMs: POLL_INTERVAL_MS,
  loadPlaywright: () => loadRuntimeDep("playwright-core"),
  executablePath: () => resolveSystemChromeExecutable(),
  launchContext: (chromium, dir, executablePath) => launchLoginBrowser(chromium, dir, executablePath),
};
let testRuntime = null;

function runtime() {
  return testRuntime || defaultRuntime;
}

function nowMs() {
  return runtime().now();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function webLoginError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

const ACTIVE_STATUSES = new Set(["running", "captured", "saving"]);
const TERMINAL_STATUSES = new Set(["success", "error", "timeout", "cancelled"]);

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function slotLabel(authUser) {
  return authUser === "" || authUser === null || authUser === undefined ? "Default" : `Slot ${authUser}`;
}

function isAuthUserValue(value) {
  // "" is the legacy root account (/app without /u/N/).
  if (typeof value !== "string" || !/^(?:|0|[1-9]\d*)$/.test(value)) return false;
  if (value === "") return true;
  return Number.isSafeInteger(Number(value));
}

/** Accepts ["0","2"], "0,2" or a single slot; returns canonical unique strings. */
function normalizeAuthUsers(authUsers) {
  const raw = Array.isArray(authUsers)
    ? authUsers
    : typeof authUsers === "string" ? authUsers.split(",") : [authUsers];
  const out = [];
  for (const entry of raw) {
    if (entry === null || entry === undefined) continue;
    const value = String(entry).trim();
    if (!isAuthUserValue(value)) {
      throw webLoginError(`Invalid Google account slot "${value}"`, "WEB_LOGIN_SLOT_INVALID", 400);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * An existing cookie session is updated against the revision the caller saw.
 * Missing, malformed or unsafe input is a rejected request, never a silent
 * create-like write with no concurrency guard.
 */
function normalizeExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw webLoginError(
      "Saving into an existing cookie session requires its positive expectedRevision",
      "WEB_LOGIN_REVISION_INVALID",
      400
    );
  }
  return value;
}

/**
 * The slots Save will verify and link. Explicit slots chosen by the caller win;
 * otherwise a captured tab supplies the lone slot. A tab is never allowed to
 * override a slot set the caller confirmed.
 */
function slotsToSave(session) {
  if (Array.isArray(session.authUsers) && session.authUsers.length > 0) return [...session.authUsers];
  return session.capturedAuthUser === null || session.capturedAuthUser === undefined
    ? []
    : [session.capturedAuthUser];
}

function sanitizeError(value) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function saveErrorMessage(slots, error) {
  const label = Array.isArray(slots) && slots.length > 0
    ? slots.map(slotLabel).join(", ")
    : slotLabel(null);
  return `${label}: ${sanitizeError(error?.message) || "verification failed"}`;
}

function pageId(page) {
  let id = pageIds.get(page);
  if (!id) {
    pageIdCounter += 1;
    id = `page-${pageIdCounter}`;
    pageIds.set(page, id);
  }
  return id;
}

/**
 * Account slot encoded in a Gemini tab URL: the /u/N/ path segment wins, an
 * `authuser` query is the fallback, and no marker means the root account "".
 * Disagreeing markers are a conflict rather than a guess.
 */
function pageSlot(config, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (config.capturePageHost && parsed.hostname !== config.capturePageHost) return null;

  const base = config.captureAppPath || "/app";
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const slotMatch = new RegExp(`^/u/([^/]+)${escaped}(?:/|$)`).exec(parsed.pathname);
  const isRootApp = parsed.pathname === base || parsed.pathname.startsWith(`${base}/`);
  if (!slotMatch && !isRootApp) return null;

  const pathSlot = slotMatch ? slotMatch[1] : null;
  const rawQuerySlot = parsed.searchParams.get("authuser");
  const querySlot = rawQuerySlot === "" ? null : rawQuerySlot;
  if (pathSlot !== null && !isAuthUserValue(pathSlot)) return { invalid: true };
  if (querySlot !== null && !isAuthUserValue(querySlot)) return { invalid: true };
  if (pathSlot !== null && querySlot !== null && pathSlot !== querySlot) return { conflict: true };
  if (pathSlot !== null) return { slot: pathSlot };
  if (querySlot !== null) return { slot: querySlot };
  return { slot: "" };
}

function capturePages(config, context) {
  const pages = [];
  let current;
  try {
    current = context.pages();
  } catch {
    return pages;
  }
  for (const page of current) {
    let url;
    try {
      url = page.url();
    } catch {
      continue;
    }
    const derived = pageSlot(config, url);
    if (!derived) continue;
    pages.push({ page, id: pageId(page), ...derived });
  }
  return pages;
}

function publicPages(session) {
  if (!session.config?.explicitCapture || !session.context) return [];
  return capturePages(session.config, session.context).map((entry) => ({
    id: entry.id,
    slot: entry.slot ?? null,
  }));
}

function publicView(session) {
  return {
    provider: session.providerId,
    status: session.status,
    profile: session.profile || null,
    error: session.error || null,
    sessionId: session.savedSessionId || session.geminiWebSessionId || null,
    connectionIds: Array.isArray(session.savedConnectionIds) ? [...session.savedConnectionIds] : [],
    capturedAuthUser: session.capturedAuthUser ?? null,
    authUsers: slotsToSave(session),
    pages: publicPages(session),
  };
}

async function sleepTick(page, rt) {
  try {
    await page.waitForTimeout(rt.pollIntervalMs);
  } catch {
    await delay(rt.pollIntervalMs);
  }
}

export function getWebLoginStatus(providerId) {
  return sessions.get(providerId) || null;
}

/** Status safe to hand to the dashboard: no cookie, token or page URL. */
export function getPublicWebLoginStatus(providerId) {
  const session = sessions.get(providerId);
  return session ? publicView(session) : null;
}

/** Existing browser profiles the user can pick from (shared across providers). */
export function listWebLoginProfiles() {
  const root = path.join(getWritableDataDir(), "browser-profiles");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "web-login")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Cancel a running, captured or saving login. Saving is resolved by the save
 * promise, which owns its own state transition so a half-written capture is
 * never reported as cancelled after it was committed.
 */
export function cancelWebLogin(providerId) {
  const session = sessions.get(providerId);
  if (!session || isTerminalStatus(session.status)) return false;
  session.cancelled = true;
  try { session.saveAbort?.abort(); } catch { /* already aborted */ }
  if (session.status !== "saving") {
    session.status = "cancelled";
    session.credential = undefined;
    session.capturedAuthUser = null;
  }
  return true;
}

/** "default" unless the user picked/created a named profile. */
function sanitizeProfileName(name) {
  const cleaned = String(name || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  return cleaned || "default";
}

export async function startWebLogin(providerId, profileName = "default", options = {}) {
  const config = getWebLoginConfig(providerId);
  if (!config) throw new Error(`No web-login config for provider "${providerId}"`);
  const existing = sessions.get(providerId);
  if (existing && isActiveStatus(existing.status)) {
    // Gemini stores the target session, revision and slot set on the running
    // login; silently replacing them would save accounts into the wrong jar.
    if (config.explicitCapture) {
      throw webLoginError(
        "A browser login is already running for this provider — capture or cancel it first",
        "WEB_LOGIN_SESSION_ACTIVE",
        409
      );
    }
    return existing;
  }
  const profile = sanitizeProfileName(profileName);
  if (busyProfiles.has(profile)) {
    const busy = busyProfiles.get(profile);
    throw new Error(`Profile "${profile}" is already open for ${busy.providerId} — finish that login first or pick another profile`);
  }

  const session = {
    providerId,
    profile,
    config,
    status: "running",
    startedAt: config.explicitCapture ? nowMs() : Date.now(),
    cancelled: false,
  };

  if (config.explicitCapture) {
    session.deadlineAt = session.startedAt + LOGIN_TIMEOUT_MS;
    session.name = options?.name ? String(options.name) : null;
    session.geminiWebSessionId = options?.geminiWebSessionId ? String(options.geminiWebSessionId) : null;
    // Creation has no prior revision; updating an existing jar must carry the
    // exact revision the caller saw or the save would race another writer.
    session.expectedRevision = session.geminiWebSessionId
      ? normalizeExpectedRevision(options?.expectedRevision)
      : null;
    const requestedSlots = options?.authUsers === undefined ? [] : normalizeAuthUsers(options.authUsers);
    session.authUsers = requestedSlots.length > 0 ? requestedSlots : null;
  }

  sessions.set(providerId, session);
  busyProfiles.set(profile, session);
  // Fire-and-forget: callers poll getWebLoginStatus().
  runLogin(session, config)
    .catch((error) => {
      session.status = "error";
      session.error = sanitizeError(error?.message) || "Login failed";
    })
    .finally(() => {
      if (busyProfiles.get(profile) === session) busyProfiles.delete(profile);
    });
  return session;
}

/**
 * Turn the current browser pages into a pending credential.
 *
 * Owns option validation so the route only forwards `{ authUsers, pageId }`.
 * Serializes the whole configured jar (Gemini needs every Google cookie, not
 * just the signed-in tokens) and records the slot chosen by the tab URL.
 */
export async function captureWebLogin(providerId, { authUsers, pageId: requestedPageId } = {}) {
  const session = sessions.get(providerId);
  if (!session) throw webLoginError("No login session for this provider", "WEB_LOGIN_NOT_FOUND", 404);
  const config = session.config;
  if (!config?.explicitCapture) {
    throw webLoginError("This provider captures cookies automatically", "WEB_LOGIN_CAPTURE_UNSUPPORTED", 400);
  }
  if (session.status === "saving") {
    throw webLoginError("The captured session is being verified", "WEB_LOGIN_SESSION_SAVING", 409);
  }
  if (isTerminalStatus(session.status)) {
    throw webLoginError("The login session is no longer active", "WEB_LOGIN_SESSION_INACTIVE", 409);
  }

  const normalizedAuthUsers = authUsers === undefined ? null : normalizeAuthUsers(authUsers);

  const context = session.context;
  if (!context) throw webLoginError("The browser window is still opening", "WEB_LOGIN_NOT_READY", 409);

  const pages = capturePages(config, context);
  if (pages.length === 0) {
    throw webLoginError(
      "Open the Gemini app for the Google account you want to add",
      "WEB_LOGIN_PAGE_UNAVAILABLE",
      409
    );
  }

  let target = null;
  const wantsPage = requestedPageId !== undefined && requestedPageId !== null && String(requestedPageId).trim() !== "";
  if (wantsPage) {
    target = pages.find((entry) => entry.id === String(requestedPageId));
    if (!target) {
      throw webLoginError("The selected browser tab is no longer available", "WEB_LOGIN_PAGE_UNKNOWN", 409);
    }
  } else if (pages.length === 1) {
    target = pages[0];
  }
  // One shared Google jar serves every tab, so a tab selection is only
  // informative. Multiple tabs without a selection still capture the jar once.

  if (target?.conflict) {
    throw webLoginError("That tab names two different Google account slots", "WEB_LOGIN_SLOT_CONFLICT", 409);
  }
  if (target?.invalid) {
    throw webLoginError("That tab names an invalid Google account slot", "WEB_LOGIN_SLOT_INVALID", 400);
  }

  let found;
  try {
    found = await harvest(context, config);
  } catch {
    throw webLoginError("The browser window could not be read", "WEB_LOGIN_CAPTURE_FAILED", 502);
  }
  if (!found.ready) {
    throw webLoginError("Sign in to Gemini in the browser window first", "WEB_LOGIN_NOT_READY", 409);
  }

  let credential = found.cookieHeader;
  if (config.fullCookieJar) {
    try {
      credential = normalizeGeminiCookieInput(credential);
    } catch {
      throw webLoginError("The captured cookies are malformed", "WEB_LOGIN_CAPTURE_FAILED", 400);
    }
  }
  if (!credential) {
    throw webLoginError("The browser window carried no cookies", "WEB_LOGIN_CAPTURE_FAILED", 502);
  }

  if (normalizedAuthUsers && normalizedAuthUsers.length > 0) session.authUsers = normalizedAuthUsers;
  session.credential = credential;
  session.capturedAuthUser = target ? target.slot : null;
  session.capturedAt = nowMs();
  session.captureDeadlineAt = session.capturedAt + CAPTURE_HOLD_TIMEOUT_MS;
  session.error = null;
  session.status = "captured";
  return publicView(session);
}

/**
 * Begin the save of a captured session. Sets `saving` synchronously, runs the
 * supplied commit exactly once and resolves to the public status.
 *
 * The interactive five-minute window is paused while `captured` or `saving`;
 * a failed verification clears the captured credential and re-arms a fresh
 * window so the operator can recapture without reopening the browser.
 *
 * `authUsers` is the slot set confirmed at Save time. It replaces the slots
 * recorded before capture so the commit can never save a different set than
 * the one the operator acknowledged.
 *
 * `signal` is the Save request's lifetime. A disconnected caller stops its own
 * verification; a caller that merely joins an in-flight save (promise dedupe)
 * must not be able to abort work it did not start.
 */
export function beginWebLoginSave(providerId, { commit, authUsers, signal } = {}) {
  const session = sessions.get(providerId);
  if (!session) return Promise.reject(webLoginError("No login session for this provider", "WEB_LOGIN_NOT_FOUND", 404));
  if (session.savePromise) return session.savePromise;
  if (typeof commit !== "function") {
    return Promise.reject(webLoginError("A save handler is required", "WEB_LOGIN_SAVE_INVALID", 500));
  }
  if (session.status !== "captured") return Promise.resolve(publicView(session));
  if (signal?.aborted) {
    return Promise.reject(webLoginError("The save was abandoned before it started", "WEB_LOGIN_CANCELLED", 499));
  }

  let slots;
  try {
    if (authUsers !== undefined) {
      const normalized = normalizeAuthUsers(authUsers);
      if (normalized.length === 0) {
        throw webLoginError("Choose at least one account slot before saving", "WEB_LOGIN_SLOT_REQUIRED", 400);
      }
      session.authUsers = normalized;
    }
    slots = slotsToSave(session);
    if (slots.length === 0) {
      throw webLoginError("Choose at least one account slot before saving", "WEB_LOGIN_SLOT_REQUIRED", 400);
    }
  } catch (error) {
    return Promise.reject(error);
  }

  session.status = "saving";
  session.callerCancelled = false;
  session.saveAbort = new AbortController();
  session.savePromise = runSave(session, commit, slots, signal);
  return session.savePromise;
}

async function runSave(session, commit, slots, callerSignal) {
  const slot = session.capturedAuthUser;
  const credential = session.credential;
  const controller = session.saveAbort;
  // A client that goes away owns only its own request. This flag is consulted
  // after commit failure, never after commit success, so a write that already
  // landed stays committed.
  const abandon = () => {
    session.callerCancelled = true;
    try { controller?.abort(); } catch { /* already aborted */ }
  };
  if (callerSignal) callerSignal.addEventListener("abort", abandon, { once: true });
  try {
    // Yield before committing so a cancel arriving in the same tick wins.
    await Promise.resolve();
    if (session.cancelled) throw webLoginError("Cancelled", "WEB_LOGIN_CANCELLED", 499);

    const saved = await withTimeout(
      Promise.resolve().then(() => commit({
        providerId: session.providerId,
        cookieHeader: credential,
        authUser: slot,
        cookieSessionId: session.geminiWebSessionId,
        expectedRevision: session.expectedRevision,
        authUsers: slots,
        signal: session.saveAbort?.signal,
      })),
      VERIFY_TIMEOUT_MS
    );
    // A cancel that raced the verification still wins: the commit re-checks
    // its abort signal before writing, and this keeps the reported state honest.
    if (session.cancelled) throw webLoginError("Cancelled", "WEB_LOGIN_CANCELLED", 499);

    session.status = "success";
    session.savedSessionId = saved?.sessionId || session.geminiWebSessionId || null;
    session.savedConnectionIds = Array.isArray(saved?.connectionIds) ? saved.connectionIds : [];
    session.credential = undefined;
    session.capturedAuthUser = null;
    session.captureDeadlineAt = null;
    session.saveAbort = null;
    session.error = null;
    return publicView(session);
  } catch (error) {
    try { session.saveAbort?.abort(); } catch { /* already aborted */ }
    session.saveAbort = null;
    session.credential = undefined;
    session.capturedAuthUser = null;
    session.captureDeadlineAt = null;
    session.savePromise = null;

    if (session.cancelled || session.callerCancelled || error?.code === "WEB_LOGIN_CANCELLED") {
      session.status = "cancelled";
      return publicView(session);
    }

    // Keep the browser open and the same tab/original target so the operator
    // can fix the account (wrong slot, signed-out tab) and capture again.
    session.status = "running";
    session.error = saveErrorMessage(slots, error);
    session.deadlineAt = nowMs() + LOGIN_TIMEOUT_MS;
    return publicView(session);
  } finally {
    // The request outlives the save; drop the listener so a later disconnect
    // cannot reach a controller owned by a different save.
    if (callerSignal) callerSignal.removeEventListener("abort", abandon);
  }
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(webLoginError("Verification timed out", "WEB_LOGIN_VERIFY_TIMEOUT", 504));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

// Chromium leaves Singleton* lock files when a launch is killed; a stale lock
// makes every next launch fail with "ProcessSingleton". Remove and retry once.
function clearStaleSingletonLocks(dir) {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { rmSync(join(dir, name), { force: true }); } catch { /* best-effort */ }
  }
}

async function launchLoginBrowser(chromium, dir, executablePath) {
  try {
    return await chromium.launchPersistentContext(dir, {
      headless: false,
      executablePath,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (error) {
    if (!/ProcessSingleton|SingletonLock/i.test(String(error?.message || ""))) throw error;
    clearStaleSingletonLocks(dir);
    return await chromium.launchPersistentContext(dir, {
      headless: false,
      executablePath,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }
}

async function finishLogin(session, context, dir) {
  session.context = null;
  try { await context?.close?.(); } catch { /* already closed */ }
  clearStaleSingletonLocks(dir);
  // Chrome's caches balloon far past the session data we keep; drop them
  // while the profile is closed and rebuilding is free.
  const pruned = pruneProfileCaches(dir);
  if (pruned.freedBytes > 0) {
    console.log("[webLogin] pruned", formatBytes(pruned.freedBytes), "from profile", session.profile);
  }
}

async function runLogin(session, config) {
  if (config.explicitCapture) return runCaptureLogin(session, config);
  return runAutoCaptureLogin(session, config);
}

async function runAutoCaptureLogin(session, config) {
  const { chromium } = await loadRuntimeDep("playwright-core");
  const executablePath = resolveSystemChromeExecutable();
  if (!executablePath) {
    throw new Error("No Chrome/Chromium executable found — set CHROME_PATH or install Google Chrome");
  }
  const dir = profileDir(session.profile);
  mkdirSync(dir, { recursive: true });

  const context = await launchLoginBrowser(chromium, dir, executablePath);

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (session.cancelled) {
        session.status = "cancelled";
        return;
      }
      await page.waitForTimeout(POLL_INTERVAL_MS);
      const found = await harvest(context, config);
      if (!found.ready) continue;

      if (config.credentialFrom === "localStorageValue") {
        const source = config.tokenSources[0];
        let val = found.localStorageValues[source.name];
        try {
          const parsed = JSON.parse(val);
          if (parsed && typeof parsed.value === "string") val = parsed.value;
        } catch {
          // not JSON, keep raw
        }
        session.credential = val;
      } else {
        session.credential = found.cookieHeader;
      }
      session.status = "success";
      return;
    }
    session.status = "timeout";
    session.error = "Login window timed out after 5 minutes — try again";
  } finally {
    await finishLogin(session, context, dir);
  }
}

async function runCaptureLogin(session, config) {
  const rt = runtime();
  const dir = profileDir(session.profile);
  let context = null;
  try {
    const { chromium } = await rt.loadPlaywright();
    const executablePath = typeof rt.executablePath === "function"
      ? rt.executablePath()
      : rt.executablePath;
    if (!executablePath) {
      throw new Error("No Chrome/Chromium executable found — set CHROME_PATH or install Google Chrome");
    }
    mkdirSync(dir, { recursive: true });
    context = await rt.launchContext(chromium, dir, executablePath);
    session.context = context;

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    while (true) {
      if (session.cancelled) {
        session.status = "cancelled";
        return;
      }
      if (isTerminalStatus(session.status)) return;

      const now = rt.now();
      if (session.status === "saving") {
        await sleepTick(page, rt);
        continue;
      }
      if (session.status === "captured") {
        if (session.captureDeadlineAt && now >= session.captureDeadlineAt) {
          session.status = "timeout";
          session.error = "The captured session was not saved within 5 minutes — try again";
          session.credential = undefined;
          session.capturedAuthUser = null;
          return;
        }
        await sleepTick(page, rt);
        continue;
      }

      if (now >= session.deadlineAt) {
        session.status = "timeout";
        session.error = "Login window timed out after 5 minutes — try again";
        return;
      }

      await sleepTick(page, rt);
    }
  } finally {
    await finishLogin(session, context, dir);
  }
}

/** Test seam: swap the clock/launcher. Pass null to restore production. */
export function __setWebLoginRuntimeForTests(overrides) {
  testRuntime = overrides || null;
}

/** Test seam: drop every session and pending browser without touching users. */
export function __resetWebLoginSessionsForTests() {
  for (const session of sessions.values()) {
    session.cancelled = true;
    try { session.context?.close?.(); } catch { /* best-effort */ }
  }
  sessions.clear();
  busyProfiles.clear();
  pageIds = new WeakMap();
  pageIdCounter = 0;
}
