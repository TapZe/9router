import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

const STILL_PENDING = Symbol("refresh did not finish");

function untilAborted(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function within(pending) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((resolve) => { timer = setTimeout(() => resolve(STILL_PENDING), 250); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let refreshFunctions;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("OAUTH_REFRESH_TIMEOUT_MS", "20");
  refreshFunctions = await import("../../open-sse/services/tokenRefresh/providers.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(["codex", "factory"])("%s shared credential refresh deadline", (provider) => {
  function refresh(token) {
    const { refreshCodexToken, refreshFactoryToken } = refreshFunctions;
    return provider === "codex"
      ? refreshCodexToken(token)
      : refreshFactoryToken(token, {});
  }

  it("finishes a stalled token request without revoking the account or retrying a spent token", async () => {
    const fetch = vi.fn((url, options) => untilAborted(options.signal));
    vi.stubGlobal("fetch", fetch);

    const result = await within(refresh(`${provider}-stalled-headers`));

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline active while reading the token response body", async () => {
    const fetch = vi.fn(async (url, options) => ({
      ok: true,
      json: () => untilAborted(options.signal),
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await within(refresh(`${provider}-stalled-body`));

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
