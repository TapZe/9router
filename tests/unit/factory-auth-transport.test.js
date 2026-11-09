import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { refreshFactoryToken } from "../../open-sse/services/tokenRefresh/providers.js";
import factory from "../../src/lib/oauth/providers/factory.js";
import { FACTORY_CONFIG } from "../../src/lib/oauth/constants/oauth.js";

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
  it("device code request posts to WorkOS through proxyAwareFetch with no connection proxy", async () => {
    proxyAwareFetch.mockResolvedValue(ok({ device_code: "dc", user_code: "UC", expires_in: 300, interval: 5 }));

    const code = await factory.requestDeviceCode();

    expect(code).toMatchObject({ device_code: "dc", user_code: "UC" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const [url, init, proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.workos.com/user_management/authorize/device");
    expect(init.body.get("client_id")).toBe("client_01HNM792M5G5G1A2THWPXKFMXB");
    expect(proxyOptions ?? null).toBeNull();
  });

  it("device code poll posts to WorkOS through proxyAwareFetch with no connection proxy", async () => {
    proxyAwareFetch.mockResolvedValue(ok({ access_token: "acc", refresh_token: "ref" }));

    const result = await factory.pollToken(FACTORY_CONFIG, "dc");

    expect(result).toEqual({ ok: true, data: { access_token: "acc", refresh_token: "ref" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const [url, init, proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.workos.com/user_management/authenticate");
    expect(init.body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(proxyOptions ?? null).toBeNull();
  });

  it("whoami after sign-in goes through proxyAwareFetch with no connection proxy", async () => {
    proxyAwareFetch.mockResolvedValue(ok({ org_id: "org_w", region: "global", inferenceRegion: "us" }));

    const extra = await factory.postExchange({ access_token: "eyJhbGciOiJSUzI1NiJ9.e30.sig" });

    expect(extra).toMatchObject({ orgId: "org_w", inferenceRegion: "us" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const [url, init, proxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://api.factory.ai/api/cli/whoami");
    expect(init.headers.Authorization).toBe("Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig");
    expect(proxyOptions ?? null).toBeNull();
  });
});
