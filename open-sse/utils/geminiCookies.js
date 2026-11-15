const INVALID_COOKIE_CODE = "GEMINI_WEB_COOKIE_INVALID";
const DEFAULT_COOKIE_NAME = "__Secure-1PSID";
const PSID_COOKIE_NAME = "__Secure-1PSID";
const PSIDTS_COOKIE_NAME = "__Secure-1PSIDTS";
// RFC 6265 cookie-name is an HTTP token: no separators, whitespace or control bytes.
const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const COOKIE_PREFIX_RE = /^cookie:[ \t]*/i;

function invalidCookie() {
  const error = new Error("Invalid Gemini cookie header");
  error.code = INVALID_COOKIE_CODE;
  return error;
}

function assertCookieName(name) {
  if (!COOKIE_NAME_RE.test(name)) throw invalidCookie();
}

function assertCookieValue(value) {
  if (CONTROL_CHAR_RE.test(value)) throw invalidCookie();
}

function pairsFromJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidCookie();
  }
  const source =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.cookies && typeof parsed.cookies === "object" && !Array.isArray(parsed.cookies)
        ? parsed.cookies
        : parsed
      : null;
  if (!source) throw invalidCookie();

  const pairs = [];
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const trimmed = value.trim();
    assertCookieName(name);
    assertCookieValue(trimmed);
    pairs.push([name, trimmed]);
  }
  if (pairs.length === 0) throw invalidCookie();
  return pairs;
}

function pairsFromHeader(text) {
  const pairs = [];
  for (const part of text.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) throw invalidCookie();
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    assertCookieName(name);
    assertCookieValue(value);
    pairs.push([name, value]);
  }
  if (pairs.length === 0) throw invalidCookie();
  return pairs;
}

function cookieNameRank(name) {
  const lower = name.toLowerCase();
  if (lower === PSID_COOKIE_NAME.toLowerCase()) return 0;
  if (lower === PSIDTS_COOKIE_NAME.toLowerCase()) return 1;
  return 2;
}

function compareCookieNames(a, b) {
  const rankDiff = cookieNameRank(a) - cookieNameRank(b);
  if (rankDiff !== 0) return rankDiff;
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// One canonical spelling per jar: trimmed pairs, deterministic order, values untouched.
function canonicalCookieHeader(pairs) {
  const byName = new Map();
  for (const [name, value] of pairs) byName.set(name, value);
  const names = [...byName.keys()].sort(compareCookieNames);
  return names.map((name) => `${name}=${byName.get(name)}`).join("; ");
}

/**
 * Parse and validate a Gemini cookie header into name/value pairs.
 *
 * Stored jars are canonical, but legacy values can arrive in any order; both go
 * through the same parser so ordering can never decide whether two jars match.
 */
export function parseGeminiCookieHeader(header) {
  const out = {};
  if (typeof header !== "string") return out;
  const text = header.trim();
  if (!text) return out;
  for (const [name, value] of pairsFromHeader(text)) out[name] = value;
  return out;
}

/** Case-insensitive lookup of one cookie value in a header. */
export function getGeminiCookieValue(header, cookieName) {
  const wanted = String(cookieName || "").toLowerCase();
  for (const [name, value] of Object.entries(parseGeminiCookieHeader(header))) {
    if (name.toLowerCase() === wanted) return value;
  }
  return null;
}

/**
 * Normalize a pasted Gemini cookie header, bare PSID, or browser-export JSON.
 *
 * A pasted `Cookie:` prefix is removed and the result is canonicalized so equal
 * jars compare equal. Control characters and malformed names are rejected
 * rather than forwarded upstream.
 */
export function normalizeGeminiCookieInput(raw, cookieName = DEFAULT_COOKIE_NAME) {
  if (raw === null || raw === undefined) return "";
  const text = String(raw);
  if (CONTROL_CHAR_RE.test(text)) throw invalidCookie();
  let trimmed = text.trim();
  if (!trimmed) return "";

  if (COOKIE_PREFIX_RE.test(trimmed)) trimmed = trimmed.replace(COOKIE_PREFIX_RE, "").trim();
  if (!trimmed) throw invalidCookie();

  let pairs;
  if (trimmed.startsWith("{")) {
    pairs = pairsFromJson(trimmed);
  } else if (trimmed.includes("=")) {
    pairs = pairsFromHeader(trimmed);
  } else {
    assertCookieName(cookieName);
    assertCookieValue(trimmed);
    pairs = [[cookieName, trimmed]];
  }
  return canonicalCookieHeader(pairs);
}

/**
 * Normalize a pasted Gemini credential for the connection test and make sure it
 * actually carries a non-empty `__Secure-1PSID` cookie. Returns `null` when no
 * PSID is present so callers can reject before any network call.
 */
export function normalizeGeminiValidationCookie(raw) {
  const cookie = normalizeGeminiCookieInput(raw);
  if (!cookie) return null;
  const psid = getGeminiCookieValue(cookie, PSID_COOKIE_NAME);
  if (!psid || psid.trim().length === 0) return null;
  return cookie;
}
