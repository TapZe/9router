import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupGeminiWebDb } from "../helpers/geminiWebDb.js";

const browser = vi.hoisted(() => ({ session: null, start: vi.fn(), cancel: vi.fn() }));
vi.mock("open-sse/services/webLogin.js", () => ({
  startWebLogin: browser.start,
  getWebLoginStatus: () => browser.session,
  getPublicWebLoginStatus: () => null,
  cancelWebLogin: browser.cancel,
  listWebLoginProfiles: () => ["synthetic"],
  captureWebLogin: vi.fn(),
  beginWebLoginSave: vi.fn(),
}));
vi.mock("open-sse/services/webIdentity.js", () => ({
  fetchWebIdentity: async () => ({ status: "valid", email: "synthetic@example.test" }),
}));
vi.mock("next/server", () => ({ NextResponse: class extends Response {
  static json(body, init = {}) { return new Response(JSON.stringify(body), { status: init.status || 200, headers: { "content-type": "application/json" } }); }
} }));

const fixture = await setupGeminiWebDb();
const database = await import("../../src/lib/db/index.js");
const { GET, POST, DELETE } = await import("../../src/app/api/providers/web-login/route.js");
const origin = "http://127.0.0.1:20129";
function request(method, crossSite = false) {
  const url = new URL(origin + "/api/providers/web-login?provider=grok-web");
  const headers = new Headers(crossSite
    ? { cookie: "auth_token=synthetic", "sec-fetch-site": "cross-site", referer: "https://evil.example/" }
    : { origin, "sec-fetch-site": "same-origin", referer: origin + "/dashboard/providers/grok-web" });
  if (method === "POST") {
    headers.set("content-type", "text/plain");
    return new Request(url, { method, headers, body: JSON.stringify({ provider: "grok-web", profile: "synthetic" }) });
  }
  return { url: url.toString(), nextUrl: url, headers };
}
beforeEach(() => {
  fixture.clear();
  browser.start.mockReset(); browser.cancel.mockReset();
  browser.start.mockResolvedValue({ profile: "synthetic", status: "running" });
  browser.cancel.mockReturnValue(true);
  browser.session = { status: "success", profile: "synthetic", credential: "sso=synthetic-cookie" };
});
afterAll(() => fixture.teardown());

describe("web-login browser provenance across providers", () => {
  it("rejects cross-site legacy auto-save without changing the pending login or accounts", async () => {
    const response = await GET(request("GET", true));
    expect(response.status).toBe(403);
    expect(await database.getProviderConnections()).toEqual([]);
    expect(browser.session).toMatchObject({ status: "success", credential: "sso=synthetic-cookie" });
    expect(browser.session.savedConnectionId).toBeUndefined();
  });
  it("keeps same-origin legacy auto-save and idempotent polling working", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ provider: "grok-web", status: "success", email: "synthetic@example.test" });
    expect(await database.getProviderConnectionById(body.connectionId)).toMatchObject({ provider: "grok-web", apiKey: "sso=synthetic-cookie", email: "synthetic@example.test" });
    expect(browser.session.credential).toBeUndefined();
    expect((await GET(request("GET"))).status).toBe(200);
    expect(await database.getProviderConnections()).toHaveLength(1);
  });
  it("rejects a cross-site simple POST before opening a non-Gemini browser", async () => {
    const response = await POST(request("POST", true));
    expect(response.status).toBe(403);
    expect(browser.start).not.toHaveBeenCalled();
  });
  it("keeps same-origin non-Gemini browser start working", async () => {
    const response = await POST(request("POST"));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ provider: "grok-web", profile: "synthetic", status: "running" });
  });
  it("rejects cross-site cancellation while preserving same-origin cancellation", async () => {
    expect((await DELETE(request("DELETE", true))).status).toBe(403);
    expect(browser.cancel).not.toHaveBeenCalled();
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
  });
});
