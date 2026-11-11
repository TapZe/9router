/**
 * Kiro device-code poll when AWS SSO OIDC answers with a non-JSON body
 * (an HTML 5xx page, a proxy error page). pollToken read the body as JSON,
 * then tried to read it again as text, which throws "Body is unusable" and
 * turned the poll into an HTTP 500 instead of a readable login error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => ({ status: init?.status || 200, body }) },
}));
vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));
vi.mock("@/lib/localDb", () => ({ getProviderConnections: vi.fn(async () => []) }));

const originalFetch = global.fetch;

describe("POST /api/oauth/kiro/poll with a non-JSON AWS response", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { global.fetch = originalFetch; });

  it("returns the AWS body as a login error instead of HTTP 500", async () => {
    const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
    global.fetch = vi.fn().mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));

    const res = await POST(
      { json: async () => ({ deviceCode: "dc", extraData: { _region: "us-east-1", _clientId: "c", _clientSecret: "s" } }) },
      { params: Promise.resolve({ provider: "kiro", action: "poll" }) },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: false,
      pending: false,
      error: "invalid_response",
      errorDescription: "<html>502 Bad Gateway</html>",
    });
  });
});
