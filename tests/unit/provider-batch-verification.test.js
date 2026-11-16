import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  testSingleConnection: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));

vi.mock("../../src/app/api/providers/[id]/test/testUtils.js", () => ({
  testSingleConnection: mocks.testSingleConnection,
}));

const { POST } = await import("../../src/app/api/providers/test-batch/route.js");

const CONNECTIONS = [
  { id: "gemini-valid", provider: "gemini-web", authType: "cookie", name: "Gemini valid" },
  { id: "gemini-invalid", provider: "gemini-web", authType: "cookie", name: "Gemini invalid" },
  { id: "gemini-unknown", provider: "gemini-web", authType: "cookie", name: "Gemini unknown" },
  { id: "gemini-unknown-valid", provider: "gemini-web", authType: "cookie", name: "Gemini unknown valid" },
  { id: "legacy-valid", provider: "openai", authType: "apikey", name: "Legacy valid" },
  { id: "legacy-invalid", provider: "openai", authType: "apikey", name: "Legacy invalid" },
];

const RESULTS = {
  "gemini-valid": { valid: true, verification: "valid", latencyMs: 12 },
  "gemini-invalid": { valid: false, verification: "invalid", error: "Session rejected", latencyMs: 20 },
  "gemini-unknown": {
    valid: false,
    verification: "unknown",
    error: "Gemini Web could not be verified",
    latencyMs: 8,
  },
  // Older non-Gemini identity probes can report valid:true while the
  // verification status is unknown; unknown still wins.
  "gemini-unknown-valid": {
    valid: true,
    verification: "unknown",
    latencyMs: 9,
  },
  "legacy-valid": { valid: true, latencyMs: 5 },
  "legacy-invalid": { valid: false, error: "Invalid API key", latencyMs: 6 },
};

function batchRequest(body) {
  return new Request("http://localhost/api/providers/test-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getProviderConnections.mockReset();
  mocks.testSingleConnection.mockReset();
  mocks.getProviderConnections.mockResolvedValue(CONNECTIONS);
  mocks.testSingleConnection.mockImplementation(async (id) => RESULTS[id]);
});

describe("Provider batch verification summary", () => {
  it("classifies valid, invalid and unknown without counting unknown as failed", async () => {
    const response = await POST(batchRequest({ mode: "all" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.summary).toEqual({
      total: 6,
      passed: 2,
      failed: 2,
      unverified: 2,
    });
    expect(payload.results).toHaveLength(6);

    const unknown = payload.results.find((entry) => entry.connectionId === "gemini-unknown");
    expect(unknown).toMatchObject({
      valid: false,
      verification: "unknown",
      error: "Gemini Web could not be verified",
    });
    const legacy = payload.results.find((entry) => entry.connectionId === "legacy-valid");
    expect(legacy.verification).toBeUndefined();
  });

  it("reports a contradictory valid:true unknown probe as unverified, never as OK", async () => {
    mocks.getProviderConnections.mockResolvedValue([CONNECTIONS[3]]);
    mocks.testSingleConnection.mockResolvedValue(RESULTS["gemini-unknown-valid"]);

    const payload = await (await POST(batchRequest({ mode: "provider", providerId: "gemini-web" }))).json();
    expect(payload.summary).toEqual({
      total: 1,
      passed: 0,
      failed: 0,
      unverified: 1,
    });
    expect(payload.results[0]).toMatchObject({ valid: false, verification: "unknown" });
  });

  it("tests cookie accounts alongside API keys in the dashboard's manual-auth group", async () => {
    const payload = await (await POST(batchRequest({ mode: "apikey" }))).json();

    expect(payload.summary).toEqual({
      total: 6,
      passed: 2,
      failed: 2,
      unverified: 2,
    });
    expect(payload.results.map((entry) => entry.connectionId).sort()).toEqual(
      CONNECTIONS.map((connection) => connection.id).sort()
    );
  });

  it("keeps legacy totals and failure counting when no verification field exists", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      CONNECTIONS[4],
      CONNECTIONS[5],
    ]);

    const payload = await (await POST(batchRequest({ mode: "apikey" }))).json();
    expect(payload.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      unverified: 0,
    });
  });

  it("reports an all-unknown batch as unverified with no failures", async () => {
    mocks.getProviderConnections.mockResolvedValue([CONNECTIONS[2]]);
    mocks.testSingleConnection.mockResolvedValue(RESULTS["gemini-unknown"]);

    const payload = await (await POST(batchRequest({ mode: "provider", providerId: "gemini-web" }))).json();
    expect(payload.summary).toEqual({
      total: 1,
      passed: 0,
      failed: 0,
      unverified: 1,
    });
  });

  it("counts a thrown test as a failure rather than an unknown verification", async () => {
    mocks.getProviderConnections.mockResolvedValue([CONNECTIONS[5]]);
    mocks.testSingleConnection.mockRejectedValue(new Error("Network unreachable"));

    const payload = await (await POST(batchRequest({ mode: "all" }))).json();
    expect(payload.summary).toEqual({
      total: 1,
      passed: 0,
      failed: 1,
      unverified: 0,
    });
    expect(payload.results[0].diagnosis).toMatchObject({ type: "network_error", source: "local" });
  });

  it("returns zero counts for an empty group", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);

    const payload = await (await POST(batchRequest({ mode: "all" }))).json();
    expect(payload.summary).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      unverified: 0,
    });
  });
});
