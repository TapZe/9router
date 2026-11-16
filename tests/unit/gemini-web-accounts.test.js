import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGeminiWebProvider } from "../../src/lib/geminiWebAccounts.js";
import { assertDashboardMutationOrigin } from "../../src/lib/mutationOrigin.js";

function request({ origin, referer, cookie, secFetch, host, forwardedHost, url = "http://127.0.0.1:20129/api/providers/gemini-web/sessions" } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (referer) headers.set("referer", referer);
  if (cookie) headers.set("cookie", cookie);
  if (secFetch) headers.set("sec-fetch-site", secFetch);
  if (host) headers.set("host", host);
  if (forwardedHost) headers.set("x-forwarded-host", forwardedHost);
  return { url, headers };
}

describe("Gemini Web mutation origin", () => {
  const previous = {
    BASE_URL: process.env.BASE_URL,
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("accepts the actual server origin when BASE_URL still names localhost", () => {
    process.env.BASE_URL = "http://localhost:20128";
    expect(() => assertDashboardMutationOrigin(request({
      url: "http://192.0.2.20:20128/api/providers/gemini-web/sessions",
      origin: "http://192.0.2.20:20128", cookie: "auth_token=synthetic",
    }))).not.toThrow();
  });

  it("accepts a public HTTPS same-origin browser save behind an internal proxy URL", () => {
    process.env.BASE_URL = "http://localhost:20128";
    expect(() => assertDashboardMutationOrigin(request({
      url: "http://localhost:20128/api/providers/gemini-web/sessions",
      origin: "https://router.example.test", cookie: "auth_token=synthetic", secFetch: "same-origin",
    }))).not.toThrow();
  });

  it("accepts the incoming Host for plain HTTP server deployments without Fetch Metadata", () => {
    process.env.BASE_URL = "http://localhost:20128";
    expect(() => assertDashboardMutationOrigin(request({
      url: "http://localhost:20128/api/providers/gemini-web/sessions",
      host: "192.0.2.20:20128", origin: "http://192.0.2.20:20128", cookie: "auth_token=synthetic",
    }))).not.toThrow();
  });

  it("accepts a same-origin Referer behind the proxy when Origin is absent", () => {
    process.env.BASE_URL = "http://localhost:20128";
    expect(() => assertDashboardMutationOrigin(request({
      referer: "https://router.example.test/dashboard/providers/gemini-web",
      cookie: "auth_token=synthetic", secFetch: "same-origin",
    }))).not.toThrow();
  });

  it.each(["cross-site", "same-site"])("rejects %s requests even when the configured origin matches", (secFetch) => {
    process.env.BASE_URL = "https://router.example.test";
    expect(() => assertDashboardMutationOrigin(request({ origin: "https://router.example.test", secFetch }))).toThrow(/not allowed/);
  });

  it.each(["null", "file:///app", "data:text/plain,test", "https://router.example.test/path", "https://user@router.example.test", "not-a-url"])(
    "rejects invalid Origin %s even with same-origin metadata", (origin) => {
      process.env.BASE_URL = "http://localhost:20128";
      expect(() => assertDashboardMutationOrigin(request({ origin, secFetch: "same-origin" }))).toThrow(/not allowed/);
    }
  );

  it("does not accept a forged forwarded host or a mismatched port", () => {
    process.env.BASE_URL = "http://localhost:20128";
    for (const values of [
      { origin: "https://evil.example", forwardedHost: "evil.example" },
      { origin: "http://192.0.2.20:20129", host: "192.0.2.20:20128" },
    ]) expect(() => assertDashboardMutationOrigin(request(values))).toThrow(/not allowed/);
  });

  it.each(["[", "evil.example/path", "user@evil.example", "evil.example,router.example.test"])(
    "does not accept malformed Host %s as a trusted origin", (host) => {
      process.env.BASE_URL = "http://localhost:20128";
      expect(() => assertDashboardMutationOrigin(request({ host, origin: "http://evil.example" }))).toThrow(/not allowed/);
    }
  );

  it("rejects a foreign Referer for cookie-authenticated requests", () => {
    process.env.BASE_URL = "http://localhost:20128";
    expect(() => assertDashboardMutationOrigin(request({
      referer: "https://evil.example/dashboard", cookie: "auth_token=synthetic",
    }))).toThrow(/not allowed/);
  });

  it("still requires provenance for cookie-authenticated browser requests but permits metadata-free CLI", () => {
    expect(() => assertDashboardMutationOrigin(request({ cookie: "auth_token=synthetic", secFetch: "same-origin" }))).toThrow(/not allowed/);
    expect(() => assertDashboardMutationOrigin(request())).not.toThrow();
  });

  it("accepts the configured same origin and rejects a foreign or null Origin", () => {
    process.env.BASE_URL = "http://127.0.0.1:20129";
    expect(() => assertDashboardMutationOrigin(request({ origin: "http://127.0.0.1:20129" }))).not.toThrow();
    expect(() => assertDashboardMutationOrigin(request({ origin: "null" }))).toThrow(/not allowed/);
    expect(() => assertDashboardMutationOrigin(request({ origin: "https://evil.example" }))).toThrow(/not allowed/);
    expect(() => assertDashboardMutationOrigin(request({ origin: "http://127.0.0.1:20128" }))).toThrow(/not allowed/);
    if (previous.BASE_URL === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previous.BASE_URL;
  });

  it("accepts a same-origin Referer when Origin is absent, and rejects cookie-auth without provenance", () => {
    process.env.BASE_URL = "http://127.0.0.1:20129";
    expect(() => assertDashboardMutationOrigin(request({
      referer: "http://127.0.0.1:20129/dashboard/providers/gemini-web",
    }))).not.toThrow();
    expect(() => assertDashboardMutationOrigin(request({
      cookie: "auth_token=abc",
      secFetch: "cross-site",
    }))).toThrow(/not allowed/);
    if (previous.BASE_URL === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previous.BASE_URL;
  });

  it("treats gemini-web and gweb as the same provider family", () => {
    expect(isGeminiWebProvider("gemini-web")).toBe(true);
    expect(isGeminiWebProvider("gweb")).toBe(true);
    expect(isGeminiWebProvider("gemini")).toBe(false);
  });
});
