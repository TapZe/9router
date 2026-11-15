import { describe, expect, it } from "vitest";
import { assertGeminiWebMutationOrigin, isGeminiWebProvider } from "../../src/lib/geminiWebAccounts.js";

function request({ origin, referer, cookie, secFetch, url = "http://127.0.0.1:20129/api/providers/gemini-web/sessions" } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (referer) headers.set("referer", referer);
  if (cookie) headers.set("cookie", cookie);
  if (secFetch) headers.set("sec-fetch-site", secFetch);
  return { url, headers };
}

describe("Gemini Web mutation origin", () => {
  const previous = {
    BASE_URL: process.env.BASE_URL,
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
  };

  it("accepts the configured same origin and rejects a foreign or null Origin", () => {
    process.env.BASE_URL = "http://127.0.0.1:20129";
    expect(() => assertGeminiWebMutationOrigin(request({ origin: "http://127.0.0.1:20129" }))).not.toThrow();
    expect(() => assertGeminiWebMutationOrigin(request({ origin: "null" }))).toThrow(/not allowed/);
    expect(() => assertGeminiWebMutationOrigin(request({ origin: "https://evil.example" }))).toThrow(/not allowed/);
    expect(() => assertGeminiWebMutationOrigin(request({ origin: "http://127.0.0.1:20128" }))).toThrow(/not allowed/);
    if (previous.BASE_URL === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previous.BASE_URL;
  });

  it("accepts a same-origin Referer when Origin is absent, and rejects cookie-auth without provenance", () => {
    process.env.BASE_URL = "http://127.0.0.1:20129";
    expect(() => assertGeminiWebMutationOrigin(request({
      referer: "http://127.0.0.1:20129/dashboard/providers/gemini-web",
    }))).not.toThrow();
    expect(() => assertGeminiWebMutationOrigin(request({
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
