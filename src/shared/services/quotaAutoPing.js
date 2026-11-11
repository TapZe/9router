// Quota auto-ping scheduler: warms 5h windows by sending tiny opt-in requests right after reset.
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getClaudeUsage } from "open-sse/services/usage/claude.js";
import { getCodexUsage } from "open-sse/services/usage/codex.js";
import { getFactoryUsage } from "open-sse/services/usage/factory.js";
import { getExecutor } from "open-sse/executors/index.js";
import { CLAUDE_CLI_SPOOF_HEADERS } from "open-sse/providers/shared.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { QUOTA_AUTOPING_CONFIG } from "@/shared/constants/config";
import { getDuePingSlot, normalizePingSchedule } from "@/shared/services/quotaPingSchedule";

const C = QUOTA_AUTOPING_CONFIG;
const CLAUDE_PING_URL = "https://api.anthropic.com/v1/messages?beta=true";

const providerHandlers = {
  claude: {
    getUsage: (connection, proxyOptions, signal) => getClaudeUsage(connection.accessToken, proxyOptions, { signal }),
    sendPing: sendClaudePing,
  },
  codex: {
    getUsage: (connection, proxyOptions, signal) => getCodexUsage(connection.accessToken, proxyOptions, signal),
    sendPing: sendCodexPing,
  },
  factory: {
    // Factory usage needs the connection's orgId/regional endpoint, not just the token.
    getUsage: (connection, proxyOptions, signal) => getFactoryUsage(connection.accessToken, connection.providerSpecificData, proxyOptions, signal),
    sendPing: sendFactoryPing,
  },
};

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__quotaAutoPing ??= {
  interval: null,
  resetCache: {},
  failureCache: {},
  inFlightConnections: new Set(),
  inFlightScans: new Set(),
});

function cacheKey(provider, connectionId) {
  return `${provider}:${connectionId}`;
}

function normalizeResetKey(resetAt) {
  const ms = new Date(resetAt).getTime();
  if (!Number.isFinite(ms)) return resetAt;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function getResetDriftMs(previousResetAt, nextResetAt) {
  const previousMs = new Date(previousResetAt).getTime();
  const nextMs = new Date(nextResetAt).getTime();
  if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) return 0;
  return nextMs - previousMs;
}

function toFiniteNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isQuotaExhausted(quota) {
  if (!quota || quota.unlimited === true) return false;
  const remaining = toFiniteNumber(quota.remaining);
  if (remaining !== null) return remaining <= 0;

  const used = toFiniteNumber(quota.used);
  const total = toFiniteNumber(quota.total);
  return total !== null && total > 0 && used !== null && used >= total;
}

function wasPingedRecently(connection, intervalMs, nowMs = Date.now()) {
  if (!intervalMs) return false;
  const lastPingAtMs = new Date(connection.lastPingAt).getTime();
  return Number.isFinite(lastPingAtMs) && nowMs - lastPingAtMs < intervalMs;
}

function hasExhaustedBlockingQuota(quotas, providerConfig) {
  if (!quotas || !Array.isArray(providerConfig?.blockingQuotaKeys)) return false;
  return providerConfig.blockingQuotaKeys.some((key) => isQuotaExhausted(quotas[key]));
}

function shouldPingForReset(providerConfig, cachedReset, resetAt, now) {
  if (providerConfig.pingWhenResetAtSlides) {
    return Boolean(cachedReset) && getResetDriftMs(cachedReset, resetAt) >= (providerConfig.resetAtDriftMs || 0);
  }

  const resetMs = new Date(resetAt).getTime();
  // Factory keeps reporting the last window end after it passes; an end at or
  // before now means no live window, so a request must start the next one.
  if (providerConfig.pingWhenWindowInactive) {
    return !Number.isFinite(resetMs) || now >= resetMs;
  }

  return Number.isFinite(resetMs) && now >= resetMs - C.pingLeadMs;
}

function getConnectionSchedule(settings, providerConfig, connectionId) {
  const schedules = settings?.[providerConfig.settingsKey]?.schedules || {};
  return normalizePingSchedule(schedules[connectionId]);
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

function withTimeout(promise, ms, desc = "Operation") {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${desc} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function sendClaudePing(connection, providerConfig, proxyOptions, deps, signal) {
  if (signal?.aborted) return false;
  const res = await deps.proxyAwareFetch(CLAUDE_PING_URL, {
    method: "POST",
    headers: {
      ...CLAUDE_CLI_SPOOF_HEADERS,
      "Authorization": `Bearer ${connection.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: providerConfig.pingModel,
      max_tokens: providerConfig.pingMaxTokens,
      messages: [{ role: "user", content: providerConfig.pingText }],
    }),
    ...(signal ? { signal } : {}),
  }, proxyOptions);
  return res.ok && !signal?.aborted;
}

function buildCodexPingInput(text) {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }];
}

async function drainResponseBody(response, signal) {
  if (signal?.aborted) {
    try { await response?.body?.cancel?.(); } catch {}
    throw signal.reason || new Error("This operation was aborted");
  }

  const reader = response?.body?.getReader?.();
  if (reader) {
    const onAbort = () => {
      try { reader.cancel?.().catch?.(() => {}); } catch {}
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      while (true) {
        if (signal?.aborted) {
          throw signal.reason || new Error("This operation was aborted");
        }
        const { done } = await reader.read();
        if (done) return;
      }
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      reader.releaseLock?.();
    }
  }

  if (typeof response?.text === "function") {
    let onAbort;
    const abortPromise = signal
      ? new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason || new Error("This operation was aborted"));
          else {
            onAbort = () => reject(signal.reason || new Error("This operation was aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          }
        })
      : null;
    try {
      if (abortPromise) {
        await Promise.race([response.text(), abortPromise]);
      } else {
        await response.text();
      }
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }
}

async function sendCodexPing(connection, providerConfig, proxyOptions, deps, signal) {
  if (signal?.aborted) return false;
  const executor = deps.getExecutor("codex");
  const { response } = await executor.execute({
    model: providerConfig.pingModel,
    stream: true,
    credentials: {
      accessToken: connection.accessToken,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    signal,
    body: {
      model: providerConfig.pingModel,
      input: buildCodexPingInput(providerConfig.pingText),
      instructions: providerConfig.pingInstructions,
      reasoning: providerConfig.pingReasoningEffort
        ? { effort: providerConfig.pingReasoningEffort, summary: "auto" }
        : undefined,
      store: false,
      stream: true,
    },
  });
  if (signal?.aborted) {
    try { await response?.body?.cancel?.(); } catch {}
    return false;
  }
  if (!response?.ok) {
    try { await response?.body?.cancel?.(); } catch {}
    return false;
  }

  // Codex only starts the 5h window after the streaming response completes.
  await drainResponseBody(response, signal);
  return !signal?.aborted;
}

async function sendFactoryPing(connection, providerConfig, proxyOptions, deps, signal) {
  if (signal?.aborted) return false;
  const executor = deps.getExecutor("factory");
  const { response } = await executor.execute({
    model: providerConfig.pingModel,
    stream: true,
    credentials: {
      accessToken: connection.accessToken,
      connectionId: connection.id,
      providerSpecificData: connection.providerSpecificData,
    },
    proxyOptions,
    log: console,
    signal,
    body: {
      model: providerConfig.pingModel,
      messages: [{ role: "user", content: providerConfig.pingText }],
      max_tokens: providerConfig.pingMaxTokens,
      stream: true,
    },
  });
  if (signal?.aborted) {
    try { await response?.body?.cancel?.(); } catch {}
    return false;
  }
  if (!response?.ok) {
    try { await response?.body?.cancel?.(); } catch {}
    return false;
  }

  // Factory starts the 5h window only once the streaming response completes.
  await drainResponseBody(response, signal);
  return !signal?.aborted;
}

function shouldSkipAfterFailure(state, key, nowMs = Date.now()) {
  const failedAt = state.failureCache[key];
  return failedAt && nowMs - failedAt < C.failureCooldownMs;
}

async function pingConnection(conn, provider, providerConfig, handler, deps, state = g, schedule = null, reactive = true) {
  state.inFlightConnections ??= new Set();
  const key = cacheKey(provider, conn.id);
  if (state.inFlightConnections.has(key)) return;
  state.inFlightConnections.add(key);

  const attemptTimeoutMs = C.attemptTimeoutMs;
  const controller = new AbortController();

  let timer = null;
  let onTimeoutAbort;
  const callerTimeoutPromise = new Promise((resolve) => {
    if (attemptTimeoutMs > 0) {
      timer = setTimeout(() => {
        controller.abort(new Error(`AutoPing attempt timed out after ${attemptTimeoutMs}ms`));
        if (state.failureCache) state.failureCache[key] = Date.now();
        resolve();
      }, attemptTimeoutMs);
    }
    onTimeoutAbort = () => {
      if (state.failureCache) state.failureCache[key] = Date.now();
      resolve();
    };
    controller.signal.addEventListener("abort", onTimeoutAbort, { once: true });
  });

  const attemptPromise = (async () => {
    try {
      await doPingConnection(conn, provider, providerConfig, handler, deps, state, schedule, reactive, controller, key);
    } catch (e) {
      if (state.failureCache) state.failureCache[key] = Date.now();
      console.warn(`[AutoPing] ${provider}:${conn.id}: ${e.message}`);
    } finally {
      clearTimeout(timer);
      if (onTimeoutAbort) {
        controller.signal.removeEventListener("abort", onTimeoutAbort);
      }
      state.inFlightConnections?.delete(key);
    }
  })();

  await Promise.race([attemptPromise, callerTimeoutPromise]);
}

async function doPingConnection(conn, provider, providerConfig, handler, deps, state, schedule, reactive, controller, key) {
  const signal = controller.signal;
  if (signal.aborted) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    return;
  }

  const cachedReset = state.resetCache?.[key];
  if (!schedule && !providerConfig.pingWhenResetAtSlides && cachedReset && Date.now() < new Date(cachedReset).getTime() - C.refreshAheadMs) return;

  if (shouldSkipAfterFailure(state, key)) return;

  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
  if (signal.aborted) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    return;
  }
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  let onRefreshAbort;
  const abortPromise = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error("Attempt aborted"));
    } else {
      onRefreshAbort = () => reject(signal.reason || new Error("Attempt aborted"));
      signal.addEventListener("abort", onRefreshAbort, { once: true });
    }
  });

  try {
    const refreshPromise = deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    const r = await Promise.race([refreshPromise, abortPromise]);
    if (signal.aborted) {
      if (state.failureCache) state.failureCache[key] = Date.now();
      return;
    }
    connection = r.connection;
  } catch (e) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    if (!signal.aborted) {
      console.warn(`[AutoPing] ${provider}:${conn.id}: refresh failed: ${e.message}`);
    }
    return;
  } finally {
    if (onRefreshAbort) {
      signal.removeEventListener("abort", onRefreshAbort);
    }
  }

  if (signal.aborted) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    return;
  }

  let usage;
  try {
    usage = await handler.getUsage(connection, proxyOptions, signal);
  } catch (e) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    if (!signal.aborted) {
      console.warn(`[AutoPing] ${provider}:${conn.id}: usage fetch failed: ${e.message}`);
    }
    return;
  }

  if (signal.aborted) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    return;
  }

  const quotas = usage?.quotas || {};
  const quota = quotas?.[providerConfig.quotaKey];
  if (!quota) return;
  let resetAt = quota.resetAt || null;
  if (!resetAt && !providerConfig.pingWhenWindowInactive) return;

  if (resetAt && state.resetCache) state.resetCache[key] = resetAt;

  if (providerConfig.skipWhenBlockingQuotaExhausted && hasExhaustedBlockingQuota(quotas, providerConfig)) return;
  if (!providerConfig.pingWhenWindowInactive && isQuotaExhausted(quota)) return;

  const now = Date.now();
  let resetKey = resetAt ? normalizeResetKey(resetAt) : null;

  let catchingUpReset = false;
  const dueSlot = schedule ? getDuePingSlot(schedule, now) : null;
  const slotPending = Boolean(dueSlot) && connection.lastPingedSlotKey !== dueSlot.key;

  if (slotPending) {
    if (wasPingedRecently(connection, providerConfig.minPingIntervalMs, now)) return;
  } else {
    if (!reactive) return;
    if (!resetAt && !providerConfig.pingWhenWindowInactive) return;

    const lastPingedResetKey = (connection.lastPingedResetKey || connection.lastPingedResetAt)
      ? normalizeResetKey(connection.lastPingedResetKey || connection.lastPingedResetAt)
      : null;

    // A tick may miss Claude's short lead window and observe the next reset.
    // Catch up the unpinged cached deadline, without marking that next cycle
    // as pinged. Keep the fresh reset in resetCache for subsequent ticks.
    // Lead-window mode only: Codex (sliding reset) and Factory (inactive
    // window) never ping for a reset that has already passed.
    if (!providerConfig.pingWhenResetAtSlides && !providerConfig.pingWhenWindowInactive && cachedReset
      && lastPingedResetKey !== normalizeResetKey(cachedReset)
      && shouldPingForReset(providerConfig, cachedReset, cachedReset, now)) {
      resetAt = cachedReset;
      resetKey = normalizeResetKey(cachedReset);
      catchingUpReset = true;
    }

    if (!shouldPingForReset(providerConfig, cachedReset, resetAt, now)) return;
    if (wasPingedRecently(connection, providerConfig.minPingIntervalMs, now)) return;
    if (resetKey && lastPingedResetKey === resetKey) return;
  }

  if (signal.aborted) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    return;
  }

  // Retain a caught-up deadline on HTTP failures or thrown transport errors so
  // the failure cooldown delays its retry rather than discarding the cycle.
  if (catchingUpReset) state.resetCache[key] = resetAt;
  let ok = false;
  try {
    ok = await handler.sendPing(connection, providerConfig, proxyOptions, deps, signal);
  } catch (e) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    if (!signal.aborted) {
      console.warn(`[AutoPing] ${provider}:${connection.id}: ping exception: ${e.message}`);
    }
    return;
  }

  if (signal.aborted) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    return;
  }

  if (!ok) {
    if (state.failureCache) state.failureCache[key] = Date.now();
    console.warn(`[AutoPing] ${provider}:${connection.id}: ping failed (${slotPending ? `slot ${dueSlot.key}` : `reset ${resetAt}`})`);
    return;
  }

  if (catchingUpReset) state.resetCache[key] = quota.resetAt;
  if (state.failureCache) delete state.failureCache[key];
  const pingedAt = new Date().toISOString();
  await deps.updateProviderConnection(connection.id, {
    ...(!slotPending ? { lastPingedResetAt: resetAt, lastPingedResetKey: resetKey } : (resetAt ? { lastPingedResetAt: resetAt, lastPingedResetKey: resetKey } : {})),
    ...(slotPending ? { lastPingedSlotKey: dueSlot.key } : {}),
    lastPingAt: pingedAt,
    updatedAt: pingedAt,
  });
  console.log(`[AutoPing] ${provider}:${connection.id}: ping sent (${slotPending ? `slot ${dueSlot.key}` : `reset ${resetAt}`})`);
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    proxyAwareFetch,
    getExecutor,
  };
}

export async function runQuotaAutoPingTick(deps = createDefaultDeps(), state = g) {
  state.resetCache ??= {};
  state.failureCache ??= {};
  state.inFlightConnections ??= new Set();
  state.inFlightScans ??= new Set();

  const scanTimeoutMs = C.scanTimeoutMs;

  try {
    const settings = await withTimeout(deps.getSettings(), scanTimeoutMs, "getSettings");

    await Promise.allSettled(
      Object.entries(C.providers).map(async ([provider, providerConfig]) => {
        const handler = providerHandlers[provider];
        if (!handler) return;

        const enabledMap = settings?.[providerConfig.settingsKey]?.connections || {};
        const scheduleMap = settings?.[providerConfig.settingsKey]?.schedules || {};
        if (Object.keys(enabledMap).length === 0 && Object.keys(scheduleMap).length === 0) return;

        if (state.inFlightScans.has(provider)) return;
        state.inFlightScans.add(provider);

        let targets = [];
        try {
          const conns = await withTimeout(
            deps.getProviderConnections({ provider, isActive: true }),
            scanTimeoutMs,
            `getProviderConnections(${provider})`
          );

          targets = (conns || []).filter((conn) => (
            conn.authType === "oauth"
            && (enabledMap[conn.id] === true || normalizePingSchedule(scheduleMap[conn.id]) !== null)
          ));
        } catch (e) {
          console.warn(`[AutoPing] ${provider} scan error:`, e.message);
          return;
        } finally {
          state.inFlightScans.delete(provider);
        }

        await Promise.allSettled(
          targets.map(async (conn) => {
            const connKey = cacheKey(provider, conn.id);
            if (state.inFlightConnections.has(connKey)) return;

            try {
              const schedule = getConnectionSchedule(settings, providerConfig, conn.id);
              const reactive = enabledMap[conn.id] === true;
              await pingConnection(conn, provider, providerConfig, handler, deps, state, schedule, reactive);
            } catch (e) {
              if (state.failureCache) state.failureCache[connKey] = Date.now();
              console.warn(`[AutoPing] ${provider}:${conn.id}: ${e.message}`);
            }
          })
        );
      })
    );
  } catch (e) {
    console.warn("[AutoPing] tick error:", e.message);
  }
}

export function startQuotaAutoPing() {
  if (g.interval) return;
  console.log("[AutoPing] scheduler started");
  runQuotaAutoPingTick().catch(() => {});
  g.interval = setInterval(() => { runQuotaAutoPingTick().catch(() => {}); }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaAutoPing() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[AutoPing] scheduler stopped");
}

// An opted-in account or a single enabled schedule is enough to need the scheduler.
export function hasAnyAutoPingEnabled(settings) {
  return Object.values(C.providers).some((providerConfig) => {
    const config = settings?.[providerConfig.settingsKey];
    return Object.values(config?.connections || {}).some(Boolean)
      || Object.values(config?.schedules || {}).some((schedule) => normalizePingSchedule(schedule) !== null);
  });
}

export function configureQuotaAutoPing(settings) {
  if (hasAnyAutoPingEnabled(settings)) startQuotaAutoPing();
  else stopQuotaAutoPing();
}
