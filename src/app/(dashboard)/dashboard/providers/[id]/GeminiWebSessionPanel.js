"use client";

// Gemini Web account acquisition and management.
//
// Gemini is the only provider here whose credential is a shared Google cookie
// jar that several routable accounts (slots) point at. Everything that touches
// that jar — new session, extra slots, cookie replacement, browser capture and
// per-account metadata — goes through this one panel, so the generic API-key
// and edit modals never see a linked Gemini row.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Modal, Select } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const GEMINI_WEB_PROVIDERS = new Set(["gemini-web", "gweb"]);
const NO_PROXY = "__none__";
const SLOT_RE = /^(?:0|[1-9]\d*)$/;
const PSID_COOKIE = "__Secure-1PSID";
const PSIDTS_COOKIE = "__Secure-1PSIDTS";
const BROWSER_POLL_MS = 2000;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

const BROWSER_ACTIVE = new Set(["running", "captured", "saving"]);

export function isGeminiWebProvider(providerId) {
  return GEMINI_WEB_PROVIDERS.has(String(providerId || ""));
}

export function slotBadgeLabel(authUser) {
  return authUser === "" || authUser === null || authUser === undefined ? "Default" : `Slot ${authUser}`;
}

/**
 * "0, 2, 2" -> ["0","2"]. The literal `default` is the legacy root account
 * (/app without /u/N/) and becomes the canonical empty slot.
 */
export function parseAuthUsersInput(text) {
  const slots = [];
  for (const part of String(text ?? "").split(",")) {
    const value = part.trim();
    if (!value) continue;
    const slot = value.toLowerCase() === "default" ? "" : value;
    if (slot !== "" && (!SLOT_RE.test(slot) || !Number.isSafeInteger(Number(slot)))) {
      return { slots: [], error: `"${value}" is not a Google account slot` };
    }
    if (!slots.includes(slot)) slots.push(slot);
  }
  if (slots.length === 0) return { slots: [], error: "Enter at least one Google account slot" };
  return { slots, error: null };
}

/**
 * Validate a pasted full Cookie header before it leaves the page. The server
 * re-parses it; this only turns the common mistakes into an immediate message.
 */
export function cookieHeaderProblem(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "Paste the complete Cookie request header";
  if (CONTROL_CHAR_RE.test(text)) return "The header contains control characters";
  const header = text.replace(/^cookie:[ \t]*/i, "").trim();
  const names = new Set();
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) return "The header is not a list of name=value cookies";
    names.add(trimmed.slice(0, index).trim().toLowerCase());
  }
  if (!names.has(PSID_COOKIE.toLowerCase())) return `Missing ${PSID_COOKIE}`;
  if (!names.has(PSIDTS_COOKIE.toLowerCase())) return `Missing ${PSIDTS_COOKIE}`;
  return null;
}

// Stable UTC rendering: locale formatting would differ between the server
// render and the browser and could also leak more precision than needed.
function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function proxyLabel(poolId, proxyPools) {
  if (!poolId) return "No proxy";
  const pool = (proxyPools || []).find((entry) => entry.id === poolId);
  return pool ? pool.name : `${poolId} (missing)`;
}

/**
 * Session/slot badges shared by both connection-row implementations. Slot
 * numbers belong to one browser profile and can move when Google accounts are
 * removed or reordered, so the tooltip states that instead of implying a
 * stable per-account ID.
 */
export function GeminiWebAccountBadges({ connection, session = null }) {
  if (!connection || !isGeminiWebProvider(connection.provider)) return null;
  const authUser = connection.providerSpecificData?.authUser ?? "";
  const unverified = !connection.testStatus || connection.testStatus === "unknown";
  const slotTitle = translate(
    "The slot belongs to this browser session. It can change when Google accounts are removed or reordered."
  );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span title={slotTitle}>
        <Badge variant="info" size="sm">{slotBadgeLabel(authUser)}</Badge>
      </span>
      {session ? (
        <span title={`Cookie session ${session.name || session.id} · ${session.fingerprint || ""}`}>
          <Badge variant="default" size="sm">{session.name || "Shared cookies"}</Badge>
        </span>
      ) : (
        <span title={translate("Cookie session id is missing — capture the cookie again")}>
          <Badge variant="default" size="sm">{translate("No session")}</Badge>
        </span>
      )}
      {unverified && (
        <span title={translate("No successful test yet. Unverified is not the same as invalid.")}>
          <Badge variant="warning" size="sm">{translate("Unverified")}</Badge>
        </span>
      )}
    </span>
  );
}

GeminiWebAccountBadges.propTypes = {
  connection: PropTypes.object,
  session: PropTypes.object,
};

function sessionSlots(session) {
  return (session?.connections || []).map((entry) => entry.authUser ?? "");
}

function Step({ children }) {
  return <li className="flex gap-2 text-xs leading-relaxed text-text-muted"><span className="text-primary">›</span><span>{children}</span></li>;
}

Step.propTypes = { children: PropTypes.node };

export default function GeminiWebSessionPanel({
  isOpen,
  mode = "manage",
  connection = null,
  connections = [],
  proxyPools = [],
  onSaved,
  onClose,
}) {
  const [view, setView] = useState(mode);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");

  // Manual paste form. The header lives only in this state and is cleared the
  // moment it is saved; it is never echoed, previewed or persisted client-side.
  const [cookieHeader, setCookieHeader] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [slotsText, setSlotsText] = useState("0");
  const [proxyPoolId, setProxyPoolId] = useState(NO_PROXY);
  const [pasteTarget, setPasteTarget] = useState({ kind: "new", sessionId: null });
  const [renameSessionId, setRenameSessionId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  // Per-account metadata. `connection` seeds the account view when a row opens
  // the panel directly; the manage list can switch the target in place.
  const [accountConnection, setAccountConnection] = useState(connection);
  const [accountName, setAccountName] = useState("");
  const [accountPriority, setAccountPriority] = useState(1);
  const [accountProxyPoolId, setAccountProxyPoolId] = useState(NO_PROXY);

  // Interactive browser capture
  const [profiles, setProfiles] = useState(["default"]);
  const [profile, setProfile] = useState("default");
  const [browserTargetSessionId, setBrowserTargetSessionId] = useState("");
  const [browserSlotsText, setBrowserSlotsText] = useState("0");
  const [browserStatus, setBrowserStatus] = useState(null);
  const [browserPageId, setBrowserPageId] = useState("");
  const pollRef = useRef(null);

  const stopPolling = useCallback(() => {
    clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/providers/gemini-web/sessions", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load cookie sessions");
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      setSessionsError("");
    } catch (error) {
      setSessionsError(error?.message || "Failed to load cookie sessions");
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      // The pasted header is write-only state; drop it with the dialog.
      setCookieHeader("");
      return;
    }
    setView(mode);
    setFormError("");
    setNotice("");
    loadSessions();
  }, [isOpen, mode, loadSessions]);

  useEffect(() => {
    if (!isOpen) {
      stopPolling();
      return;
    }
    let cancelled = false;
    fetch("/api/providers/web-login", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data?.profiles)) return;
        const list = data.profiles.includes("default") ? data.profiles : ["default", ...data.profiles];
        setProfiles(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (connection) setAccountConnection(connection);
  }, [connection]);

  useEffect(() => {
    if (view !== "account" || !accountConnection) return;
    setAccountName(accountConnection.name || "");
    setAccountPriority(Number.isFinite(accountConnection.priority) ? accountConnection.priority : 1);
    setAccountProxyPoolId(accountConnection.providerSpecificData?.proxyPoolId || NO_PROXY);
  }, [view, accountConnection]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const geminiAccounts = useMemo(
    () => (connections || []).filter((entry) => isGeminiWebProvider(entry.provider) && entry.providerSpecificData?.geminiWebSessionId),
    [connections]
  );
  const sessionById = useMemo(() => new Map(sessions.map((entry) => [entry.id, entry])), [sessions]);

  const proxyOptions = useMemo(
    () => [{ value: NO_PROXY, label: "No proxy (global / direct)" }, ...(proxyPools || []).map((pool) => ({ value: pool.id, label: pool.name }))],
    [proxyPools]
  );

  const resetPasteForm = useCallback(() => {
    setCookieHeader("");
    setFormError("");
    setSlotsText("0");
    setProxyPoolId(NO_PROXY);
    setSessionName("");
    setPasteTarget({ kind: "new", sessionId: null });
  }, []);

  const openPaste = useCallback((target) => {
    setView("paste");
    setFormError("");
    setNotice("");
    setCookieHeader("");
    if (target?.kind === "replace") {
      setPasteTarget({ kind: "replace", sessionId: target.session.id });
      setSessionName(target.session.name || "");
    } else if (target?.kind === "addSlots") {
      setPasteTarget({ kind: "addSlots", sessionId: target.session.id });
      setSlotsText("");
      setProxyPoolId(NO_PROXY);
    } else {
      setPasteTarget({ kind: "new", sessionId: null });
      setSessionName("");
      setSlotsText("0");
      setProxyPoolId(NO_PROXY);
    }
  }, []);

  const openBrowser = useCallback((sessionId = "") => {
    setView("browser");
    setFormError("");
    setNotice("");
    setBrowserStatus(null);
    setBrowserPageId("");
    setBrowserTargetSessionId(sessionId);
    setBrowserSlotsText("0");
    if (!sessionId) setSessionName("");
  }, []);

  const closePanel = useCallback(() => {
    // A running Chrome window outlives this dialog; cancel it so the operator
    // never has to find the window by hand. The server ignores this when the
    // save already committed.
    const status = browserStatus?.status;
    const provider = browserStatus?.provider;
    if (provider && BROWSER_ACTIVE.has(status)) {
      fetch(`/api/providers/web-login?provider=${encodeURIComponent(provider)}`, { method: "DELETE" }).catch(() => {});
    }
    stopPolling();
    onClose?.();
  }, [browserStatus, onClose, stopPolling]);

  const finish = async (message) => {
    setNotice(message);
    await loadSessions();
    onSaved?.();
  };

  const submitPaste = async () => {
    setFormError("");
    const target = pasteTarget;
    const problem = target.kind === "addSlots" ? null : cookieHeaderProblem(cookieHeader);
    if (problem) {
      setFormError(problem);
      return;
    }

    setBusy(true);
    try {
      if (target.kind === "new") {
        const parsed = parseAuthUsersInput(slotsText);
        if (parsed.error) {
          setFormError(parsed.error);
          return;
        }
        const res = await fetch("/api/providers/gemini-web/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: sessionName.trim(),
            cookieHeader,
            authUsers: parsed.slots,
            proxyPoolId: proxyPoolId === NO_PROXY ? null : proxyPoolId,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFormError(
            data.code === "cookie_session_exists"
              ? `These cookies already belong to another cookie session${data.existingSessionId ? ` (${data.existingSessionId})` : ""}. Open that session and add slots there instead.`
              : data.error || "Failed to create the cookie session"
          );
          return;
        }
        const savedName = data.session?.name || sessionName || "untitled";
        resetPasteForm();
        setView("manage");
        await finish(`Cookie session "${savedName}" saved`);
        return;
      }

      const session = sessionById.get(target.sessionId);
      if (!session) {
        setFormError("The cookie session is no longer available");
        return;
      }
      const body = { expectedRevision: session.revision };
      if (target.kind === "replace") body.cookieHeader = cookieHeader;
      if (target.kind === "addSlots") {
        const parsed = parseAuthUsersInput(slotsText);
        if (parsed.error) {
          setFormError(parsed.error);
          return;
        }
        body.authUsers = parsed.slots;
        body.proxyPoolId = proxyPoolId === NO_PROXY ? null : proxyPoolId;
      }

      const res = await fetch(`/api/providers/gemini-web/sessions/${encodeURIComponent(session.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(
          data.code === "GEMINI_WEB_SESSION_CONFLICT"
            ? "Another change landed first — reopen the session and try again"
            : data.error || "Failed to update the cookie session"
        );
        return;
      }
      resetPasteForm();
      setView("manage");
      await finish(
        target.kind === "replace"
          ? "Cookies replaced and every linked slot revalidated"
          : "Google account slots added"
      );
    } catch (error) {
      setFormError(error?.message || "Failed to save the cookie session");
    } finally {
      setBusy(false);
    }
  };

  const submitAccount = async () => {
    if (!accountConnection) return;
    setFormError("");
    if (!accountName.trim()) {
      setFormError("Enter an account name");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(accountConnection.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountName.trim(),
          priority: Number(accountPriority) || 1,
          proxyPoolId: accountProxyPoolId === NO_PROXY ? null : accountProxyPoolId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Failed to save the account");
        return;
      }
      setView("manage");
      await finish("Account updated");
    } catch (error) {
      setFormError(error?.message || "Failed to save the account");
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (session) => {
    const name = renameValue.trim();
    setFormError("");
    if (!name) {
      setFormError("Enter a session name");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/providers/gemini-web/sessions/${encodeURIComponent(session.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: session.revision, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Failed to rename the session");
        return;
      }
      setRenameSessionId(null);
      await finish("Cookie session renamed");
    } catch (error) {
      setFormError(error?.message || "Failed to rename the session");
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async (session) => {
    setFormError("");
    if ((session.connections || []).length > 0) {
      setFormError("Delete the linked accounts first — only an empty cookie session can be removed");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`Delete cookie session "${session.name || session.id}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/providers/gemini-web/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormError(data.error || "Failed to delete the cookie session");
        return;
      }
      await finish("Cookie session deleted");
    } catch (error) {
      setFormError(error?.message || "Failed to delete the cookie session");
    } finally {
      setBusy(false);
    }
  };

  const pollBrowser = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/providers/web-login?provider=gemini-web", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          stopPolling();
          setBrowserStatus({ provider: "gemini-web", status: "error", error: data.error || "Login window unavailable" });
          return;
        }
        setBrowserStatus(data);
        if (data.status === "success") {
          stopPolling();
          await loadSessions();
          onSaved?.();
        } else if (["error", "timeout", "cancelled"].includes(data.status)) {
          stopPolling();
        }
      } catch {
        // transient network hiccup — keep polling
      }
    }, BROWSER_POLL_MS);
  }, [loadSessions, onSaved, stopPolling]);

  const startBrowser = async () => {
    setFormError("");
    const parsed = parseAuthUsersInput(browserSlotsText);
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const body = { provider: "gemini-web", profile, authUsers: parsed.slots };
      if (browserTargetSessionId) {
        const session = sessionById.get(browserTargetSessionId);
        if (!session) {
          setFormError("Choose an existing cookie session first");
          return;
        }
        body.geminiWebSessionId = session.id;
        body.expectedRevision = session.revision;
      } else {
        body.name = sessionName.trim() || undefined;
      }
      const res = await fetch("/api/providers/web-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Failed to open the login browser");
        return;
      }
      setBrowserStatus({ provider: "gemini-web", status: data.status || "running", pages: [] });
      setBrowserPageId("");
      pollBrowser();
    } catch (error) {
      setFormError(error?.message || "Failed to open the login browser");
    } finally {
      setBusy(false);
    }
  };

  const captureBrowser = async () => {
    setFormError("");
    const parsed = parseAuthUsersInput(browserSlotsText);
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/providers/web-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini-web", action: "capture", authUsers: parsed.slots, pageId: browserPageId || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Failed to capture the browser session");
        return;
      }
      setBrowserStatus((prev) => ({ ...prev, ...data }));
    } catch (error) {
      setFormError(error?.message || "Failed to capture the browser session");
    } finally {
      setBusy(false);
    }
  };

  const cancelBrowser = () => {
    fetch("/api/providers/web-login?provider=gemini-web", { method: "DELETE" }).catch(() => {});
    stopPolling();
    setBrowserStatus(null);
  };

  const slotsPreview = parseAuthUsersInput(slotsText);
  const browserPages = Array.isArray(browserStatus?.pages) ? browserStatus.pages : [];
  const activeBrowserSession = browserStatus && BROWSER_ACTIVE.has(browserStatus.status);

  const activeTab = view === "paste" && pasteTarget.kind === "addSlots" ? "manage" : view;

  const header = (
    <div className="flex flex-wrap gap-2 border-b border-border pb-3">
      {[
        ["manage", "Sessions"],
        ["paste", "Cookie header"],
        ["browser", "Browser"],
      ].map(([key, label]) => (
        <Button
          key={key}
          size="sm"
          variant={activeTab === key ? "primary" : "secondary"}
          onClick={() => {
            if (key === "paste") openPaste({ kind: "new" });
            else if (key === "browser") openBrowser("");
            else setView("manage");
          }}
        >
          {translate(label)}
        </Button>
      ))}
    </div>
  );

  const notices = (
    <>
      {formError && <p className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{formError}</p>}
      {notice && <p className="rounded border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">{notice}</p>}
      {sessionsError && <p className="text-xs text-red-500">{sessionsError}</p>}
    </>
  );

  const manageView = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="add" onClick={() => openPaste({ kind: "new" })}>{translate("New cookie session")}</Button>
        <Button size="sm" variant="secondary" icon="language" onClick={() => openBrowser("")}>{translate("Capture from browser")}</Button>
      </div>

      <p className="text-xs leading-relaxed text-text-muted">
        {translate(
          "One cookie session is one Google cookie jar. Every linked account is a slot inside that jar (/u/0/, /u/2/ …). Several accounts can share one session, and separate sessions are independent headers, for example different Google profiles."
        )}
      </p>

      {sessionsLoading && <div className="h-16 animate-pulse rounded bg-black/5 dark:bg-white/5" />}

      {!sessionsLoading && sessions.length === 0 && (
        <p className="rounded border border-dashed border-border px-3 py-4 text-xs text-text-muted">
          {translate("No cookie sessions yet. Paste a full Cookie header or capture one in the browser.")}
        </p>
      )}

      {sessions.map((session) => {
        const slots = sessionSlots(session);
        const linkedCount = (session.connections || []).length;
        return (
          <div key={session.id} className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{session.name || translate("Untitled session")}</span>
                  <span title={translate("Fingerprint of this cookie session's PSID")}>
                    <Badge variant="default" size="sm">{session.fingerprint || "no fingerprint"}</Badge>
                  </span>
                  <Badge variant="default" size="sm">rev {session.revision}</Badge>
                  <Badge variant={linkedCount > 0 ? "success" : "default"} size="sm">
                    {linkedCount === 1 ? "1 account" : `${linkedCount} accounts`}
                  </Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {slots.length === 0 && <span className="text-xs text-text-muted">{translate("No linked slots")}</span>}
                  {slots.map((slot) => (
                    <Badge key={`${session.id}-${slot || "root"}`} variant="info" size="sm">{slotBadgeLabel(slot)}</Badge>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-text-muted">
                  {session.source === "legacy" ? translate("Imported from an old connection · ") : null}
                  {translate("Updated")} {formatDate(session.updatedAt) || "-"}
                </p>
                {linkedCount === 0 && (
                  <p className="mt-2 text-xs text-text-muted">
                    {translate("Saved cookies are retained. Reconnect accounts by entering their slots. No cookie paste is needed.")}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" variant="secondary" onClick={() => openPaste({ kind: "replace", session })}>
                  {translate("Replace cookies")}
                </Button>
                <Button size="xs" variant="secondary" onClick={() => openPaste({ kind: "addSlots", session })}>
                  {translate(linkedCount === 0 ? "Reconnect accounts" : "Add slots")}
                </Button>
                <Button size="xs" variant="secondary" onClick={() => openBrowser(session.id)}>
                  {translate("Capture")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setRenameSessionId(session.id);
                    setRenameValue(session.name || "");
                  }}
                >
                  {translate("Rename")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || linkedCount > 0}
                  title={linkedCount > 0 ? translate("Detach the linked accounts first") : translate("Delete this empty cookie session")}
                  onClick={() => deleteSession(session)}
                >
                  {translate("Delete")}
                </Button>
              </div>
            </div>

            {renameSessionId === session.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  placeholder={translate("Session name")}
                />
                <Button size="xs" onClick={() => submitRename(session)} disabled={busy}>{translate("Save")}</Button>
                <Button size="xs" variant="ghost" onClick={() => setRenameSessionId(null)}>{translate("Cancel")}</Button>
              </div>
            )}

            {(session.connections || []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
                {(session.connections || []).map((entry) => (
                  <span key={entry.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted">
                    <span className="font-medium text-text-main">{entry.name || entry.id}</span>
                    <span>{slotBadgeLabel(entry.authUser ?? "")}</span>
                    <span>#{entry.priority}</span>
                    {entry.isActive === false && <span>disabled</span>}
                    {!entry.testStatus || entry.testStatus === "unknown"
                      ? <span className="text-yellow-600 dark:text-yellow-400">unverified</span>
                      : entry.testStatus !== "active" ? <span className="text-red-500">{entry.testStatus}</span> : null}
                    {entry.rateLimitedUntil ? <span className="text-orange-500">rate limited</span> : null}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-sm font-medium">{translate("Accounts")}</p>
        {geminiAccounts.length === 0 ? (
          <p className="text-xs text-text-muted">{translate("No Gemini accounts yet.")}</p>
        ) : (
          <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
            {geminiAccounts.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="truncate text-sm">{entry.name || entry.id}</span>
                  <GeminiWebAccountBadges
                    connection={entry}
                    session={sessionById.get(entry.providerSpecificData?.geminiWebSessionId) || null}
                  />
                  <span className="text-[11px] text-text-muted">#{entry.priority}</span>
                  <span className="text-[11px] text-text-muted">
                    {proxyLabel(entry.providerSpecificData?.proxyPoolId || null, proxyPools)}
                  </span>
                </div>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => {
                    setNotice("");
                    setFormError("");
                    setAccountConnection(entry);
                    setView("account");
                  }}
                >
                  {translate("Edit account")}
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
          {translate(
            "Slot numbers belong to this browser session and can change when Google accounts are removed or reordered. Routing priority stays in the normal connection list."
          )}
        </p>
      </div>
    </div>
  );

  const pasteView = (
    <div className="flex flex-col gap-4">
      {pasteTarget.kind === "addSlots" ? (
        <div className="rounded border border-border bg-background px-3 py-2">
          <p className="text-sm font-medium">{translate("Add accounts from saved cookies")}</p>
          <p className="mt-1 text-xs text-text-muted">
            {translate("Cookie session:")} {sessionById.get(pasteTarget.sessionId)?.name || translate("Untitled session")}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            {translate("Enter the Google account slots to reconnect. We will verify them using this session's saved cookies. You do not need to paste the cookie header again.")}
          </p>
        </div>
      ) : (<>
      <div>
        <p className="text-sm font-medium">{translate("Complete Cookie request header")}</p>
        <ol className="mt-1 flex flex-col gap-1">
          <Step>{translate("Open the Gemini tab for the account you want, press F12, open Network, then reload the page.")}</Step>
          <Step>{translate("Select the batchexecute?rpcids=otAQ7b request.")}</Step>
          <Step>{translate("Copy Request Headers → Cookie. Copy the whole value, not Set-Cookie.")}</Step>
          <Step>{translate("If the tab URL contains /u/2/, enter slot 2 below.")}</Step>
        </ol>
      </div>

      <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
        {translate(
          "This header authenticates your whole Google account, not only Gemini. Treat it like a password: it is never shown again or stored in the browser. Do not paste it into chat, URLs or issue trackers. Browser profiles and backups that contain this session are equally sensitive."
        )}
      </div>
      </>)}

      {pasteTarget.kind === "replace" && (
        <p className="text-xs text-text-muted">
          {translate("Replacing cookies revalidates every linked slot of this session:")}{" "}
          {slotPreviewForSession(sessionById.get(pasteTarget.sessionId))}
        </p>
      )}

      {pasteTarget.kind !== "addSlots" && (
      <div>
        <label className="mb-1 block text-xs text-text-muted" htmlFor="gemini-cookie-header">{translate("Cookie header")}</label>
        <textarea
          id="gemini-cookie-header"
          className="h-24 w-full resize-y rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] focus:border-primary focus:outline-none"
          value={cookieHeader}
          onChange={(event) => setCookieHeader(event.target.value)}
          placeholder="__Secure-1PSID=…; __Secure-1PSIDTS=…; NID=…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-[11px] text-text-muted">
          {translate("Requires both __Secure-1PSID and __Secure-1PSIDTS. The field is cleared after saving.")}
        </p>
      </div>
      )}

      {pasteTarget.kind === "new" && (
        <div>
          <label className="mb-1 block text-xs text-text-muted" htmlFor="gemini-session-name">{translate("Session name")}</label>
          <input
            id="gemini-session-name"
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            value={sessionName}
            onChange={(event) => setSessionName(event.target.value)}
            placeholder={translate("Personal Google, work Google, …")}
          />
        </div>
      )}

      {pasteTarget.kind !== "replace" && <div>
        <label className="mb-1 block text-xs text-text-muted" htmlFor="gemini-slots">{translate("Account slots")}</label>
        <input
          id="gemini-slots"
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
          value={slotsText}
          onChange={(event) => setSlotsText(event.target.value)}
          placeholder="0, 2"
        />
        <p className="mt-1 text-[11px] text-text-muted">
          {translate("Comma separated nonnegative numbers. Slot 0 is a real /u/0/ account; a legacy root header shows as Default in the list.")}
        </p>
        {slotsText.trim() && slotsPreview.error && <p className="mt-1 text-[11px] text-red-500">{slotsPreview.error}</p>}
        {!slotsPreview.error && slotsPreview.slots.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {slotsPreview.slots.map((slot) => <Badge key={slot || "default"} variant="info" size="sm">{slotBadgeLabel(slot)}</Badge>)}
          </div>
        )}
      </div>}

      {pasteTarget.kind !== "replace" && (
        <div>
          <label className="mb-1 block text-xs text-text-muted">{translate("Proxy for the new accounts")}</label>
          <Select value={proxyPoolId} onChange={(event) => setProxyPoolId(event.target.value)} options={proxyOptions} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={submitPaste} disabled={busy}>
          {busy ? translate("Saving…") : pasteTarget.kind === "replace" ? translate("Replace cookies") : pasteTarget.kind === "addSlots" ? translate("Reconnect accounts") : translate("Save session")}
        </Button>
        <Button variant="ghost" onClick={() => { resetPasteForm(); setView("manage"); }} disabled={busy}>
          {translate("Cancel")}
        </Button>
      </div>
    </div>
  );

  const browserView = (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-text-muted">
        {translate(
          "Chrome opens on a shared browser profile. Sign in to every Google account you need, then leave one Gemini tab open per account and capture each of them. A tab at /u/2/ is slot 2."
        )}
      </p>

      <div>
        <label className="mb-1 block text-xs text-text-muted">{translate("Browser profile")}</label>
        <Select
          value={profile}
          onChange={(event) => setProfile(event.target.value)}
          options={profiles.map((name) => ({ value: name, label: name }))}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-muted">{translate("Save into")}</label>
        <Select
          value={browserTargetSessionId}
          onChange={(event) => {
            setBrowserTargetSessionId(event.target.value);
            const session = sessionById.get(event.target.value);
            if (session) setBrowserSlotsText("");
          }}
          options={[
            { value: "", label: translate("New cookie session") },
            ...sessions.map((session) => ({ value: session.id, label: `${session.name || session.id} · rev ${session.revision}` })),
          ]}
        />
      </div>

      {!browserTargetSessionId && (
        <div>
          <label className="mb-1 block text-xs text-text-muted">{translate("New session name")}</label>
          <input
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            value={sessionName}
            onChange={(event) => setSessionName(event.target.value)}
            placeholder={translate("Work Google, personal Google, …")}
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs text-text-muted">{translate("Account slots to save")}</label>
        <input
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
          value={browserSlotsText}
          onChange={(event) => setBrowserSlotsText(event.target.value)}
          placeholder="0, 2"
        />
        <p className="mt-1 text-[11px] text-text-muted">
          {translate("Default is 0 for a new session. Added slots inherit the same browser cookie jar.")}
        </p>
      </div>

      {browserStatus && (
        <div className="rounded border border-border bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge
              variant={browserStatus.status === "success" ? "success" : browserStatus.status === "error" ? "error" : "info"}
              size="sm"
            >
              {browserStatus.status}
            </Badge>
            {browserStatus.capturedAuthUser !== null && browserStatus.capturedAuthUser !== undefined && (
              <span>{translate("Captured")} {slotBadgeLabel(browserStatus.capturedAuthUser)}</span>
            )}
            {browserStatus.profile && <span className="text-text-muted">{browserStatus.profile}</span>}
          </div>

          {browserStatus.error && <p className="mt-1 text-xs text-red-500">{browserStatus.error}</p>}

          {browserStatus.status === "running" && (
            <div className="mt-2">
              {browserPages.length === 0 ? (
                <p className="text-xs text-text-muted">{translate("Waiting for a signed-in Gemini tab…")}</p>
              ) : (
                <>
                  <p className="mb-1 text-xs text-text-muted">{translate("Choose the tab to capture:")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {browserPages.map((entry) => (
                      <Button
                        key={entry.id}
                        size="xs"
                        variant={browserPageId === entry.id ? "primary" : "secondary"}
                        onClick={() => setBrowserPageId(entry.id)}
                      >
                        {entry.slot == null ? translate("Unknown tab") : slotBadgeLabel(entry.slot)}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {browserStatus.status === "saving" && (
            <p className="mt-1 text-xs text-text-muted">{translate("Verifying every requested slot with Google…")}</p>
          )}

          {browserStatus.status === "success" && (
            <p className="mt-1 text-xs text-text-muted">
              {translate("Saved. The browser window closes on its own.")}
              {Array.isArray(browserStatus.connectionIds) && browserStatus.connectionIds.length > 0
                ? ` ${browserStatus.connectionIds.length} ${translate("account(s) linked")}.`
                : ""}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {!activeBrowserSession && (
          <Button onClick={startBrowser} disabled={busy} icon="language">{translate("Open browser")}</Button>
        )}
        {browserStatus?.status === "running" && (
          <Button onClick={captureBrowser} disabled={busy || (browserPages.length > 1 && !browserPageId)}>
            {translate("Capture selected tab")}
          </Button>
        )}
        {activeBrowserSession && (
          <Button variant="ghost" onClick={cancelBrowser} disabled={busy}>{translate("Cancel")}</Button>
        )}
        {browserStatus?.status === "success" && (
          <Button onClick={closePanel}>{translate("Done")}</Button>
        )}
      </div>
    </div>
  );

  const accountView = accountConnection ? (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="info" size="sm">{slotBadgeLabel(accountConnection.providerSpecificData?.authUser ?? "")}</Badge>
        <Badge variant="default" size="sm">
          {sessionById.get(accountConnection.providerSpecificData?.geminiWebSessionId)?.name || accountConnection.providerSpecificData?.geminiWebSessionId || translate("Missing session")}
        </Badge>
        <span className="text-[11px] text-text-muted">
          {accountConnection.testStatus === "active"
            ? translate("Verified")
            : !accountConnection.testStatus || accountConnection.testStatus === "unknown"
              ? translate("Unverified — a test could not confirm the session. This is not the same as invalid.")
              : accountConnection.testStatus}
        </span>
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-muted">{translate("Account name")}</label>
        <input
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
          value={accountName}
          onChange={(event) => setAccountName(event.target.value)}
        />
        <p className="mt-1 text-[11px] text-text-muted">
          {translate("New accounts use the verified Google name or email. You can replace that label here; future cookie updates keep your name.")}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-muted">{translate("Priority")}</label>
        <input
          type="number"
          min={1}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
          value={accountPriority}
          onChange={(event) => setAccountPriority(Number.parseInt(event.target.value, 10) || 1)}
        />
        <p className="mt-1 text-[11px] text-text-muted">
          {translate("Priority decides routing order in the normal connection list. This panel does not regroup rows.")}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs text-text-muted">{translate("Proxy")}</label>
        <Select
          value={accountProxyPoolId}
          onChange={(event) => setAccountProxyPoolId(event.target.value)}
          options={proxyOptions}
        />
        <p className="mt-1 text-[11px] text-text-muted">{proxyLabel(accountProxyPoolId === NO_PROXY ? null : accountProxyPoolId, proxyPools)}</p>
      </div>

      <p className="rounded border border-border px-3 py-2 text-[11px] leading-relaxed text-text-muted">
        {translate(
          "Cookies, PSID/PSIDTS and the account slot are managed through the cookie session above. This form never edits credentials."
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={submitAccount} disabled={busy}>{translate("Save account")}</Button>
        <Button variant="ghost" onClick={() => setView("manage")} disabled={busy}>{translate("Back")}</Button>
      </div>
    </div>
  ) : null;

  return (
    <Modal isOpen={isOpen} onClose={closePanel} title={translate("Gemini Web accounts")} size="lg">
      <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto pr-1">
        {view !== "account" && header}
        {notices}
        {view === "manage" && manageView}
        {view === "paste" && pasteView}
        {view === "browser" && browserView}
        {view === "account" && accountView}
      </div>
    </Modal>
  );
}

function slotPreviewForSession(session) {
  if (!session) return "—";
  const slots = sessionSlots(session);
  if (slots.length === 0) return "no linked slots";
  return slots.map((slot) => slotBadgeLabel(slot)).join(", ");
}

GeminiWebSessionPanel.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  mode: PropTypes.oneOf(["manage", "paste", "browser", "account"]),
  connection: PropTypes.object,
  connections: PropTypes.array,
  proxyPools: PropTypes.array,
  onSaved: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
