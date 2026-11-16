const BROWSER_FETCH_HEADERS = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];

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

export function assertDashboardMutationOrigin(request) {
  const expected = mutationOrigins(request);
  if (expected.size === 0) {
    const error = new Error("Dashboard mutation origin could not be determined");
    error.status = 403;
    error.code = "mutation_origin_denied";
    throw error;
  }

  const site = header(request, "sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    const error = new Error("Dashboard mutation origin is not allowed");
    error.status = 403;
    error.code = "mutation_origin_denied";
    throw error;
  }

  const originHeader = header(request, "origin").trim();
  if (originHeader) {
    const source = originOf(originHeader);
    if (originHeader !== source || !matchesMutationOrigin(request, expected, source)) {
      const error = new Error("Dashboard mutation origin is not allowed");
      error.status = 403;
      error.code = "mutation_origin_denied";
      throw error;
    }
    return;
  }

  const referer = header(request, "referer").trim();
  const refererOrigin = referer ? originOf(referer) : null;
  if (matchesMutationOrigin(request, expected, refererOrigin)) return;

  if (hasBrowserAuth(request) || hasBrowserMetadata(request)) {
    const error = new Error("Dashboard mutation origin is not allowed");
    error.status = 403;
    error.code = "mutation_origin_denied";
    throw error;
  }
}

