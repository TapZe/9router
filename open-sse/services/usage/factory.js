import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseResetTime, toFiniteNumber } from "./shared.js";
import { resolveFactoryApiBase, FACTORY_CLIENT_VERSION, randomTraceparent } from "../../executors/factory.js";

function formatFactoryWindow(window) {
  if (!window || typeof window !== "object") return null;
  // Droid 1.10.0 hides a window Factory marks unlimited; it has no limit to show.
  if (window.unlimited) return null;
  const used = Math.max(0, Math.min(100, toFiniteNumber(window.usedPercent ?? window.used_percent, 0)));
  const resetAt = parseResetTime(
    window.windowEnd ||
    window.window_end ||
    (typeof window.secondsRemaining === "number" ? Date.now() + window.secondsRemaining * 1000 : null)
  );
  return {
    used,
    total: 100,
    remaining: Math.max(0, 100 - used),
    resetAt,
    unlimited: false,
  };
}

export async function getFactoryUsage(accessToken, providerSpecificData = null, proxyOptions = null, signal = null) {
  if (!accessToken) {
    return { error: "Missing access token" };
  }

  const base = resolveFactoryApiBase({ providerSpecificData });
  const url = `${base}/api/billing/limits`;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "X-Factory-Client": process.env.FACTORY_UPSTREAM_CLIENT_TYPE?.trim() || "cli",
    "X-Client-Version": FACTORY_CLIENT_VERSION,
    "User-Agent": `factory-cli/${FACTORY_CLIENT_VERSION}`,
    traceparent: randomTraceparent(),
  };

  const orgId = providerSpecificData?.orgId || process.env.FACTORY_ORG_ID?.trim();
  if (orgId) {
    headers["X-Factory-Org-Id"] = orgId;
  }

  try {
    const timeoutSignal = AbortSignal.timeout(10000);
    const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const res = await proxyAwareFetch(url, { headers, signal: effectiveSignal }, proxyOptions);
    if (!res.ok) {
      return { error: `Factory billing API error: HTTP ${res.status}` };
    }

    const data = await res.json();
    const limits = data.limits || {};
    const standard = limits.standard || {};
    const core = limits.core || {};

    const quotas = {};
    const addWindow = (key, window) => {
      const quota = formatFactoryWindow(window);
      if (quota) quotas[key] = quota;
    };

    // Standard tier windows
    addWindow("standard_5h", standard.fiveHour);
    addWindow("standard_weekly", standard.weekly);
    addWindow("standard_monthly", standard.monthly);

    // Core tier windows
    addWindow("core_5h", core.fiveHour);
    addWindow("core_weekly", core.weekly);
    addWindow("core_monthly", core.monthly);

    const extraUsage = typeof data.extraUsageBalanceCents === "number"
      ? {
          balance: data.extraUsageBalanceCents / 100,
          allowed: data.extraUsageAllowed ?? false,
          overagePreference: data.overagePreference,
        }
      : null;

    return {
      quotas,
      plan: data.planType || "standard",
      ...(extraUsage ? { extraUsage } : {}),
      ...(typeof data.usesTokenRateLimitsBilling === "boolean" ? { usesTokenRateLimitsBilling: data.usesTokenRateLimitsBilling } : {}),
      raw: data,
    };
  } catch (err) {
    return { error: err.message || "Failed to fetch Factory usage" };
  }
}
