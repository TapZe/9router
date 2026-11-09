import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { refreshTokenByProvider } from "../../open-sse/services/tokenRefresh.js";
import { refreshAccessToken } from "../../open-sse/services/tokenRefresh/providers.js";

// proxyFetch is mocked, so nothing patches globalThis.fetch: Factory's own
// refresh reaches the mocked proxyAwareFetch, the generic path the global.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const originalFetch = globalThis.fetch;

describe("Factory token refresh routing", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    globalThis.fetch = vi.fn(async () => { throw new Error("generic refresh path used"); });
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  // Only refreshFactoryToken retries a 429, sends a WorkOS organization_id,
  // and returns providerSpecificData. The generic path does none of these.
  it("dispatches factory to refreshFactoryToken, not the generic refresh", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(json(429, { error: "rate_limited" }))
      .mockResolvedValueOnce(json(200, { access_token: "acc", refresh_token: "rot", expires_in: 3600 }));

    const refreshed = await refreshTokenByProvider("factory", {
      refreshToken: "routing_refresh_token",
      providerSpecificData: { orgId: "org_routing_1" },
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(proxyAwareFetch.mock.calls[1][1].body.get("organization_id")).toBe("org_routing_1");
    expect(refreshed).toMatchObject({ accessToken: "acc", refreshToken: "rot", providerSpecificData: { orgId: "org_routing_1" } });
  });

  // Pins the generic path for "factory" (no caller uses it): the plain
  // default form refresh with client_id and no client_secret, since Factory
  // has no client secret. A Factory-specific profile adds nothing here.
  it("generic refresh for factory is the plain default form refresh", async () => {
    globalThis.fetch = vi.fn(async () => json(200, { access_token: "g-acc", expires_in: 60 }));

    const out = await refreshAccessToken("factory", "generic_refresh_token", {}, null);

    expect(out).toEqual({ accessToken: "g-acc", refreshToken: "generic_refresh_token", expiresIn: 60 });
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://api.workos.com/user_management/authenticate");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "generic_refresh_token",
      client_id: "client_01HNM792M5G5G1A2THWPXKFMXB",
    });
  });
});
