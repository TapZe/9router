import { NextResponse } from "next/server";
import { createProviderConnection, deleteProviderConnection, getProviderConnections, updateProviderConnection } from "@/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import {
  startWebLogin,
  getWebLoginStatus,
  getPublicWebLoginStatus,
  cancelWebLogin,
  listWebLoginProfiles,
  captureWebLogin,
  beginWebLoginSave,
} from "open-sse/services/webLogin.js";
import { getWebLoginConfig, listWebLoginProviders } from "open-sse/services/webLoginConfig.js";
import { fetchWebIdentity } from "open-sse/services/webIdentity.js";
import {
  assertGeminiWebMutationOrigin,
  createGeminiWebSession,
  updateGeminiWebSession,
} from "@/lib/geminiWebAccounts.js";

/**
 * Interactive web login: open a headed browser at the provider's login page,
 * let the user log in by hand, harvest cookies/localStorage, auto-create the
 * connection. The cookie itself never travels back to the client — only a
 * short preview does.
 */

// GET /api/providers/web-login            → supported provider list
// GET /api/providers/web-login?provider=x → session status (saves once on success)
export async function GET(request) {
  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider) {
    return NextResponse.json({ providers: listWebLoginProviders(), profiles: listWebLoginProfiles() });
  }
  if (provider === "gemini-web") {
    const publicStatus = getPublicWebLoginStatus(provider);
    if (!publicStatus) {
      return NextResponse.json({ error: "No login session for this provider" }, { status: 404 });
    }
    if (publicStatus.status === "captured") {
      try {
        assertGeminiWebMutationOrigin(request);
      } catch (error) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
      }
      const view = await beginWebLoginSave(provider, {
        commit: async (payload) => {
          if (payload.signal?.aborted) {
            const err = new Error("Cancelled");
            err.status = 499;
            throw err;
          }
          const slots = payload.authUsers == null ? [payload.authUser] : payload.authUsers;
          const saved = payload.cookieSessionId
            ? await updateGeminiWebSession(payload.cookieSessionId, {
                expectedRevision: payload.expectedRevision,
                cookieHeader: payload.cookieHeader,
                authUsers: slots,
                proxyPoolId: null,
              }, { signal: payload.signal })
            : await createGeminiWebSession({
                name: getWebLoginStatus(provider)?.name,
                cookieHeader: payload.cookieHeader,
                authUsers: slots,
                proxyPoolId: null,
                signal: payload.signal,
              });
          return {
            sessionId: saved.session?.id,
            connectionIds: (saved.connections || []).map((row) => row.id),
          };
        },
      });
      return NextResponse.json(view);
    }
    return NextResponse.json(publicStatus);
  }
  const session = getWebLoginStatus(provider);
  if (!session) {
    return NextResponse.json({ error: "No login session for this provider" }, { status: 404 });
  }

  if (session.status === "success" && !session.savedConnectionId) {
    try {
      const config = getWebLoginConfig(provider);
      const identity = await fetchWebIdentity(provider, session.credential);
      // A login that just finished in the browser is authoritative: an
      // "invalid" verdict here means the probe endpoint rejected the request
      // shape, not that the user's session is stale.
      if (identity.status === "invalid") {
        session.status = "error";
        session.error = identity.error || "The captured session was rejected";
        return NextResponse.json({
          provider,
          status: session.status,
          profile: session.profile || null,
          error: session.error,
        });
      }

      const providerName = AI_PROVIDERS[provider]?.name || provider;
      const email = identity.email || "";
      const name = email || providerName;
      session.accountEmail = email;
      const providerSpecificData = {
        authMethod: "web-login",
        ...(config?.credentialFrom === "localStorageValue" ? { tokenSource: "localStorage" } : {}),
      };

      // Re-login refreshes the credential in place. Match by account email so a
      // second Google account keeps its own row; providers that expose no email
      // fall back to the single web-login row this button created.
      const webLoginRows = (await getProviderConnections({ provider }))
        .filter((c) => c.providerSpecificData?.authMethod === "web-login")
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      const existing = email
        ? webLoginRows.find((c) => c.email === email)
        : webLoginRows.length === 1 ? webLoginRows[0] : null;

      if (existing) {
        const updated = await updateProviderConnection(existing.id, {
          apiKey: session.credential,
          name,
          email: email || existing.email || null,
          providerSpecificData: { ...existing.providerSpecificData, ...providerSpecificData },
          testStatus: "active",
          lastError: null,
          lastErrorAt: null,
          isActive: true,
        });
        session.savedConnectionId = updated?.id || existing.id;
        // Same account logged in twice used to leave a stale duplicate row.
        for (const duplicate of webLoginRows) {
          if (duplicate.id === existing.id || duplicate.email !== email || !email) continue;
          await deleteProviderConnection(duplicate.id);
        }
      } else {
        const connection = await createProviderConnection({
          provider,
          authType: "cookie",
          name,
          email: email || null,
          apiKey: session.credential,
          priority: 1,
          providerSpecificData,
          isActive: true,
          // Harvested from a live logged-in session, so the credential is known good.
          testStatus: "active",
          allowOverwrite: false,
        });
        session.savedConnectionId = connection.id;
      }
      session.credential = undefined; // drop the secret once persisted
    } catch (error) {
      session.status = "error";
      session.error = error?.code === "PROVIDER_NAME_CONFLICT"
        ? `A connection named "${error.existingName}" already exists — edit or delete it first`
        : error?.message || "Failed to save connection";
    }
  }

  return NextResponse.json({
    provider,
    status: session.status,
    profile: session.profile || null,
    error: session.error || null,
    connectionId: session.savedConnectionId || null,
    email: session.accountEmail || null,
    credentialPreview: session.credential ? `${session.credential.slice(0, 10)}…` : null,
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const provider = String(body?.provider || "").trim();
    const profile = String(body?.profile || "").trim() || "default";
    if (!getWebLoginConfig(provider)) {
      return NextResponse.json({ error: `Web login not supported for "${provider}"` }, { status: 400 });
    }
    if (provider === "gemini-web") {
      assertGeminiWebMutationOrigin(request);
      if (body?.action === "capture") {
        const status = await captureWebLogin(provider, {
          authUsers: body.authUsers,
          pageId: body.pageId,
        });
        return NextResponse.json(status);
      }
      const session = await startWebLogin(provider, profile, {
        name: body.name,
        geminiWebSessionId: body.geminiWebSessionId,
        expectedRevision: body.expectedRevision,
        authUsers: body.authUsers,
      });
      return NextResponse.json(getPublicWebLoginStatus(provider) || {
        provider,
        profile: session.profile,
        status: session.status,
      }, { status: 202 });
    }
    const session = await startWebLogin(provider, profile);
    return NextResponse.json({ provider, profile: session.profile, status: session.status }, { status: 202 });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return NextResponse.json({ error: error?.message || "Failed to start login", code: error?.code }, { status });
  }
}

// DELETE /api/providers/web-login?provider=x → cancel a running session
export async function DELETE(request) {
  const provider = request.nextUrl.searchParams.get("provider");
  if (!provider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  if (provider === "gemini-web") {
    try {
      assertGeminiWebMutationOrigin(request);
    } catch (error) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
  }
  return NextResponse.json({ cancelled: cancelWebLogin(provider) });
}
