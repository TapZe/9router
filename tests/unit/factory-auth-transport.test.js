import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { refreshFactoryToken } from "../../open-sse/services/tokenRefresh/providers.js";

// The shared transport module is mocked, so nothing patches globalThis.fetch.
// A Factory auth request that still used the bare global would hit the
// throwing stub below instead of the shared helper.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const originalFetch = globalThis.fetch;

describe("Factory auth requests use the shared proxyAwareFetch, whatever the load order", () => {
  beforeEach(() => {
    proxyAwareFetch.mockReset();
    globalThis.fetch = vi.fn(async () => { throw new Error("bare global fetch used"); });
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("token refresh posts to WorkOS through proxyAwareFetch, with its deadline signal and no connection proxy", async () => {
    proxyAwareFetch.mockResolvedValue(ok({ access_token: "acc", refresh_token: "rot", expires_in: 3600 }));

    const refreshed = await refreshFactoryToken("transport_refresh_token", {});

    expect(refreshed).toMatchObject({ accessToken: "acc", refreshToken: "rot", expiresIn: 3600 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init, proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.workos.com/user_management/authenticate");
    expect(init.method).toBe("POST");
    expect(init.body.get("grant_type")).toBe("refresh_token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(proxyOptions ?? null).toBeNull();
  });
});
