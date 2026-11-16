import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetGeminiWebSessionCache,
  resolveGeminiWebSession,
} from "../../open-sse/executors/gemini-web/session.js";
import {
  BOOTSTRAP_HTML,
  SYNTHETIC_COOKIE,
  modelDiscoveryBody,
  modelEntry,
} from "../fixtures/gemini-web/wireFixtures.js";

const NOW = Date.parse("2026-11-16T08:00:00.000Z");
const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ROTATION_BACKOFF_MS = 10 * 60 * 1000;
const STALE = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();

const DISCOVERY_BODY = modelDiscoveryBody({
  tiers: [8],
  entries: [modelEntry("auto-model-id", "Auto", "Auto", 1)],
});

function googleTransport({ rotate, app } = {}) {
  const rotateCalls = [];
  const appCalls = [];
  const transport = vi.fn(async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.origin === "https://accounts.google.com") {
      rotateCalls.push({ url: String(url), options });
      return rotate ? rotate(rotateCalls.length) : new Response("{}", { status: 200 });
    }
    if (parsed.origin === "https://www.google.com") {
      return new Response("warm", { status: 200 });
    }
    if (parsed.pathname.endsWith("/app")) {
      appCalls.push({ url: String(url), options });
      return app ? app(appCalls.length) : new Response(BOOTSTRAP_HTML, { status: 200 });
    }
    if (parsed.searchParams.has("rpcids")) {
      return new Response(DISCOVERY_BODY, { status: 200 });
    }
    if (parsed.pathname === "/") return new Response("primed", { status: 200 });
    throw new Error(`unexpected Gemini Web request: ${url}`);
  });
  return { transport, rotateCalls, appCalls };
}

function makeCredentials({
  authUser = "0",
  sessionId = "session-alpha",
  cookieHeader = SYNTHETIC_COOKIE,
  lastRotatedAt = STALE,
  revision = 1,
} = {}) {
  let record = {
    id: sessionId,
    name: "Synthetic",
    cookieHeader,
    fingerprint: "synthetic-fingerprint",
    revision,
    source: "paste",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastRotatedAt,
  };

  const read = vi.fn(async () => record);
  const commit = vi.fn(async (patch) => {
    record = {
      ...record,
      revision: record.revision + 1,
      cookieHeader: patch.cookieHeader ?? record.cookieHeader,
      lastRotatedAt: patch.lastRotatedAt ?? record.lastRotatedAt,
    };
    return record;
  });

  return {
    credentials: {
      connectionId: `conn-${sessionId}`,
      apiKey: cookieHeader,
      providerSpecificData: { authUser },
      geminiWebSession: { id: sessionId, read, commit },
    },
    read,
    commit,
    record: () => record,
  };
}

function rotatedCookie(value) {
  return new Response("{}", {
    status: 200,
    headers: [
      [
        "set-cookie",
        `__Secure-1PSIDTS=${value}; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; Domain=.google.com; Secure; HttpOnly`,
      ],
    ],
  });
}

function appWithRotatedCookie(value) {
  return new Response(BOOTSTRAP_HTML, {
    status: 200,
    headers: [
      [
        "set-cookie",
        `__Secure-1PSIDTS=${value}; Path=/; Domain=.gemini.google.com; Secure; HttpOnly`,
      ],
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  resetGeminiWebSessionCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Gemini Web PSIDTS rotation policy", () => {
  it("does not re-request rotation for every generation when a successful attempt returns no PSIDTS", async () => {
    const harness = googleTransport();
    const session = makeCredentials();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);
    expect(session.commit).not.toHaveBeenCalled();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);

    vi.setSystemTime(new Date(NOW + ROTATION_INTERVAL_MS - 1));
    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);

    vi.setSystemTime(new Date(NOW + ROTATION_INTERVAL_MS));
    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(2);
  });

  it("treats an unchanged PSIDTS response as one successful attempt, not a rotation", async () => {
    const harness = googleTransport({
      rotate: () => rotatedCookie("synthetic-psidts-value"),
    });
    const session = makeCredentials();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });

    expect(harness.rotateCalls).toHaveLength(1);
    expect(session.commit).not.toHaveBeenCalled();
    expect(session.record().lastRotatedAt).toBe(STALE);
  });

  it("persists a real PSIDTS rotation with cookie CAS and then stops rotating", async () => {
    const harness = googleTransport({
      rotate: () => rotatedCookie("rotated-psidts-value"),
    });
    const session = makeCredentials();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });

    expect(harness.rotateCalls).toHaveLength(1);
    expect(session.commit).toHaveBeenCalledTimes(1);
    expect(session.commit.mock.calls[0][0]).toMatchObject({
      source: "rotation",
      expectedRevision: 1,
      lastRotatedAt: new Date(NOW).toISOString(),
    });
    expect(session.commit.mock.calls[0][0].cookieHeader).toContain(
      "__Secure-1PSIDTS=rotated-psidts-value"
    );
    expect(harness.appCalls[0].options.headers.cookie).toContain(
      "__Secure-1PSIDTS=rotated-psidts-value"
    );

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);
    expect(session.commit).toHaveBeenCalledTimes(1);
  });

  it("still persists a PSIDTS rotated by bootstrap when RotateCookies returned nothing", async () => {
    const harness = googleTransport({
      app: () => appWithRotatedCookie("bootstrap-psidts-value"),
    });
    const session = makeCredentials();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });

    expect(harness.rotateCalls).toHaveLength(1);
    expect(session.commit).toHaveBeenCalledTimes(1);
    expect(session.commit.mock.calls[0][0]).toMatchObject({
      source: "bootstrap",
      expectedRevision: 1,
    });
    expect(session.commit.mock.calls[0][0].cookieHeader).toContain(
      "__Secure-1PSIDTS=bootstrap-psidts-value"
    );
  });

  it("backs off a failed rotation for ten minutes and retries once afterwards", async () => {
    const harness = googleTransport({
      rotate: () => new Response("nope", { status: 500 }),
    });
    const session = makeCredentials();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);
    expect(session.commit).not.toHaveBeenCalled();

    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);

    vi.setSystemTime(new Date(NOW + ROTATION_BACKOFF_MS - 1));
    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(1);

    vi.setSystemTime(new Date(NOW + ROTATION_BACKOFF_MS));
    await resolveGeminiWebSession(session.credentials, { transport: harness.transport });
    expect(harness.rotateCalls).toHaveLength(2);
  });

  it("keeps rotation state isolated per jar and account slot", async () => {
    const alphaHarness = googleTransport();
    const alpha = makeCredentials({ authUser: "0", sessionId: "session-alpha" });
    await resolveGeminiWebSession(alpha.credentials, { transport: alphaHarness.transport });
    expect(alphaHarness.rotateCalls).toHaveLength(1);

    const bravoHarness = googleTransport({
      rotate: () => rotatedCookie("bravo-rotated-psidts"),
    });
    const bravo = makeCredentials({ authUser: "2", sessionId: "session-bravo" });
    await resolveGeminiWebSession(bravo.credentials, { transport: bravoHarness.transport });

    expect(bravoHarness.rotateCalls).toHaveLength(1);
    expect(bravo.commit).toHaveBeenCalledTimes(1);
  });

  it("propagates caller cancellation during rotation without suppressing the next attempt", async () => {
    const controller = new AbortController();
    const cancelled = googleTransport({
      rotate: () => {
        controller.abort(new Error("client cancelled"));
        throw Object.assign(new Error("client cancelled"), { name: "AbortError" });
      },
    });
    const session = makeCredentials();

    await expect(
      resolveGeminiWebSession(session.credentials, {
        transport: cancelled.transport,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(session.commit).not.toHaveBeenCalled();

    const retryHarness = googleTransport({
      rotate: () => rotatedCookie("after-cancel-psidts"),
    });
    await resolveGeminiWebSession(session.credentials, { transport: retryHarness.transport });
    expect(retryHarness.rotateCalls).toHaveLength(1);
    expect(session.commit).toHaveBeenCalledTimes(1);
  });
});
