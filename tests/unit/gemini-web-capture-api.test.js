import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The fake browser and mocked account commits never touch a real profile or a
// real Google session; DATA_DIR still points at a disposable root.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-web-login-api-"));
process.env.DATA_DIR = dataDir;

const mocks = vi.hoisted(() => ({
  createGeminiWebSession: vi.fn(),
  updateGeminiWebSession: vi.fn(),
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

// Keep the real origin guard; replace only the Google-verifying commits.
vi.mock("@/lib/geminiWebAccounts.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createGeminiWebSession: mocks.createGeminiWebSession,
    updateGeminiWebSession: mocks.updateGeminiWebSession,
  };
});

const { GET, POST, DELETE } = await import("../../src/app/api/providers/web-login/route.js");
const {
  getWebLoginStatus,
  __setWebLoginRuntimeForTests,
  __resetWebLoginSessionsForTests,
} = await import("../../open-sse/services/webLogin.js");

const PROVIDER = "gemini-web";
const FULL_HEADER =
  "__Secure-1PSID=psid-api-0001; __Secure-1PSIDTS=psidts-api-0001; AEC=aec-api-0001; NID=nid-api-0001";

const GOOGLE_COOKIES = [
  { name: "__Secure-1PSID", value: "psid-api-0001", domain: ".google.com" },
  { name: "__Secure-1PSIDTS", value: "psidts-api-0001", domain: ".google.com" },
  { name: "AEC", value: "aec-api-0001", domain: ".google.com" },
  { name: "NID", value: "nid-api-0001", domain: ".google.com" },
];

function makePage(url) {
  return {
    url: () => url,
    goto: async () => {},
    waitForTimeout: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    evaluate: async () => ({}),
  };
}

function makeContext({ pages, cookies = GOOGLE_COOKIES }) {
  const context = {
    closed: false,
    cookies: async () => cookies,
    pages: () => pages,
    newPage: async () => {
      const page = makePage("about:blank");
      pages.push(page);
      return page;
    },
    close: async () => {
      context.closed = true;
    },
  };
  return context;
}

const browser = { launches: 0 };

function installRuntime(context) {
  __setWebLoginRuntimeForTests({
    now: () => 1_700_000_000_000,
    pollIntervalMs: 1,
    loadPlaywright: async () => ({ chromium: {} }),
    executablePath: "/fake/chrome",
    launchContext: async () => {
      browser.launches += 1;
      return context;
    },
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

function statusRequest() {
  const url = new URL("http://localhost/api/providers/web-login?provider=gemini-web");
  return { url: url.toString(), headers: new Headers(), nextUrl: url };
}

function mutationRequest(body, { signal } = {}) {
  const url = new URL("http://localhost/api/providers/web-login");
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function cancelRequest() {
  const url = new URL("http://localhost/api/providers/web-login?provider=gemini-web");
  return {
    url: url.toString(),
    headers: new Headers({ Origin: "http://localhost" }),
    nextUrl: url,
  };
}

async function startLogin(body = {}) {
  const response = await POST(mutationRequest({
    provider: PROVIDER,
    profile: "api-test",
    authUsers: ["0", "2"],
    ...body,
  }));
  expect(response.status).toBe(202);
  const status = await response.json();
  await waitFor(() => getWebLoginStatus(PROVIDER)?.context);
  return status;
}

async function capture({ pageId, authUsers } = {}) {
  const response = await POST(mutationRequest({
    provider: PROVIDER,
    action: "capture",
    ...(authUsers ? { authUsers } : {}),
    ...(pageId ? { pageId } : {}),
  }));
  const body = await response.json();
  expect(response.status).toBe(200);
  return body;
}

function save({ signal } = {}) {
  return POST(mutationRequest({ provider: PROVIDER, action: "save" }, { signal }));
}

beforeEach(() => {
  browser.launches = 0;
  mocks.createGeminiWebSession.mockReset();
  mocks.updateGeminiWebSession.mockReset();
  mocks.createGeminiWebSession.mockResolvedValue({
    session: { id: "session-new" },
    connections: [{ id: "conn-0" }, { id: "conn-2" }],
  });
  mocks.updateGeminiWebSession.mockResolvedValue({
    session: { id: "session-alpha" },
    connections: [{ id: "conn-2" }],
  });
  __resetWebLoginSessionsForTests();
});

afterEach(async () => {
  const { cancelWebLogin } = await import("../../open-sse/services/webLogin.js");
  cancelWebLogin(PROVIDER);
  __resetWebLoginSessionsForTests();
  __setWebLoginRuntimeForTests(null);
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Gemini capture API save boundary", () => {
  it("keeps repeated GET polling read-only and commits once on explicit save", async () => {
    const pages = [
      makePage("https://gemini.google.com/u/0/app"),
      makePage("https://gemini.google.com/u/2/app"),
    ];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({ name: "Shared Google" });

    const captured = await capture();
    expect(captured.status).toBe("captured");
    expect(captured.capturedAuthUser).toBeNull();
    expect(captured.authUsers).toEqual(["0", "2"]);

    for (let i = 0; i < 3; i += 1) {
      const response = await GET(statusRequest());
      const status = await response.json();
      expect(response.status).toBe(200);
      expect(status.status).toBe("captured");
      expect(status.authUsers).toEqual(["0", "2"]);
    }
    expect(mocks.createGeminiWebSession).not.toHaveBeenCalled();
    expect(mocks.updateGeminiWebSession).not.toHaveBeenCalled();
    expect(context.closed).toBe(false);

    const saved = await (await save()).json();
    expect(saved).toMatchObject({
      status: "success",
      sessionId: "session-new",
      connectionIds: ["conn-0", "conn-2"],
    });
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(1);
    const createArgs = mocks.createGeminiWebSession.mock.calls[0][0];
    expect(createArgs).toMatchObject({
      name: "Shared Google",
      cookieHeader: FULL_HEADER,
      authUsers: ["0", "2"],
      proxyPoolId: null,
    });
    expect(mocks.updateGeminiWebSession).not.toHaveBeenCalled();

    // A repeated save returns the acknowledged result instead of re-committing.
    const repeated = await (await save()).json();
    expect(repeated.status).toBe("success");
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(1);
    await waitFor(() => context.closed);
  });

  it("saves an existing session only when POST save supplies its revision", async () => {
    const pages = [makePage("https://gemini.google.com/u/2/app")];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({
      profile: "api-update",
      name: "Existing Google",
      geminiWebSessionId: "session-alpha",
      expectedRevision: 7,
      authUsers: ["2"],
    });

    expect(await capture()).toMatchObject({
      status: "captured",
      capturedAuthUser: "2",
      authUsers: ["2"],
    });

    const polled = await (await GET(statusRequest())).json();
    expect(polled.status).toBe("captured");
    expect(mocks.updateGeminiWebSession).not.toHaveBeenCalled();

    const saved = await (await save()).json();
    expect(saved).toMatchObject({ status: "success", sessionId: "session-alpha" });
    expect(mocks.updateGeminiWebSession).toHaveBeenCalledTimes(1);
    const [sessionId, body] = mocks.updateGeminiWebSession.mock.calls[0];
    expect(sessionId).toBe("session-alpha");
    expect(body).toMatchObject({
      expectedRevision: 7,
      cookieHeader: FULL_HEADER,
      authUsers: ["2"],
      proxyPoolId: null,
    });
    expect(mocks.createGeminiWebSession).not.toHaveBeenCalled();
    await waitFor(() => context.closed);
  });

  it("rejects an existing-session start without a positive integer revision before opening a browser", async () => {
    for (const expectedRevision of [undefined, "3", 0]) {
      const response = await POST(mutationRequest({
        provider: PROVIDER,
        geminiWebSessionId: "session-alpha",
        expectedRevision,
        authUsers: ["2"],
      }));
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.code).toBe("WEB_LOGIN_REVISION_INVALID");
    }
    expect(browser.launches).toBe(0);
    expect(getWebLoginStatus(PROVIDER)).toBeNull();
    expect(mocks.createGeminiWebSession).not.toHaveBeenCalled();
    expect(mocks.updateGeminiWebSession).not.toHaveBeenCalled();
  });

  it("cancels without committing while the explicit save is verifying", async () => {
    const pages = [makePage("https://gemini.google.com/u/2/app")];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({ profile: "api-cancel", authUsers: ["2"] });
    await capture();

    mocks.createGeminiWebSession.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error("Cancelled"), { status: 499 }));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    }));

    const savePromise = save();
    await waitFor(() => getWebLoginStatus(PROVIDER).status === "saving");

    const cancelled = await (await DELETE(cancelRequest())).json();
    expect(cancelled.cancelled).toBe(true);

    const saved = await (await savePromise).json();
    expect(saved.status).toBe("cancelled");
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(1);
    expect(getWebLoginStatus(PROVIDER).credential).toBeUndefined();
    await waitFor(() => context.closed);
  });

  it("retries a failed verification from a fresh capture and saves once", async () => {
    const pages = [makePage("https://gemini.google.com/u/2/app")];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({ profile: "api-retry", authUsers: ["2"] });
    await capture();

    mocks.createGeminiWebSession.mockRejectedValueOnce(
      Object.assign(new Error("Google rejected the cookies"), { status: 400 })
    );

    const failed = await (await save()).json();
    expect(failed.status).toBe("running");
    expect(failed.error).toContain("Slot 2");
    expect(getWebLoginStatus(PROVIDER).credential).toBeUndefined();
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(1);

    const recaptured = await capture();
    expect(recaptured.status).toBe("captured");

    const saved = await (await save()).json();
    expect(saved.status).toBe("success");
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(2);
    await waitFor(() => context.closed);
  });

  it("aborts an in-flight explicit save when the save request disconnects", async () => {
    const pages = [makePage("https://gemini.google.com/u/2/app")];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({ profile: "api-disconnect", authUsers: ["2"] });
    await capture();

    mocks.createGeminiWebSession.mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error("The request was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    }));

    const controller = new AbortController();
    const pending = save({ signal: controller.signal });
    await waitFor(() => getWebLoginStatus(PROVIDER).status === "saving");
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(1);

    controller.abort();
    const view = await (await pending).json();

    expect(view.status).toBe("cancelled");
    expect(view.connectionIds).toEqual([]);
    expect(getWebLoginStatus(PROVIDER).status).toBe("cancelled");
    expect(getWebLoginStatus(PROVIDER).credential).toBeUndefined();
    expect(mocks.createGeminiWebSession).toHaveBeenCalledTimes(1);
    await waitFor(() => context.closed);
  });

  it("keeps a save that committed before the request disconnected", async () => {
    const pages = [makePage("https://gemini.google.com/u/2/app")];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({ profile: "api-commit-then-drop", authUsers: ["2"] });
    await capture();

    const controller = new AbortController();
    // The repository write lands, then the client disappears before the
    // response reaches it. The committed session must stay successful.
    mocks.createGeminiWebSession.mockImplementationOnce(async () => {
      controller.abort();
      return { session: { id: "session-new" }, connections: [{ id: "conn-2" }] };
    });

    const view = await (await save({ signal: controller.signal })).json();
    expect(view).toMatchObject({ status: "success", sessionId: "session-new" });
    expect(getWebLoginStatus(PROVIDER).status).toBe("success");
    await waitFor(() => context.closed);
  });

  it("lets a duplicate save join the in-flight commit without cancelling it", async () => {
    const pages = [makePage("https://gemini.google.com/u/2/app")];
    const context = makeContext({ pages });
    installRuntime(context);
    await startLogin({ profile: "api-dedupe", authUsers: ["2"] });
    await capture();

    let releaseCommit;
    const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
    let commits = 0;
    mocks.createGeminiWebSession.mockImplementationOnce(async () => {
      commits += 1;
      await commitGate;
      return { session: { id: "session-new" }, connections: [{ id: "conn-2" }] };
    });

    const first = save();
    await waitFor(() => getWebLoginStatus(PROVIDER).status === "saving");

    const controller = new AbortController();
    controller.abort();
    const duplicate = save({ signal: controller.signal });

    releaseCommit();
    const [firstView, duplicateView] = await Promise.all([
      first.then((response) => response.json()),
      duplicate.then((response) => response.json()),
    ]);

    expect(firstView.status).toBe("success");
    expect(duplicateView.status).toBe("success");
    expect(commits).toBe(1);
    await waitFor(() => context.closed);
  });
});
