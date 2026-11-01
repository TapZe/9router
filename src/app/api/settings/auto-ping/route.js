import { NextResponse } from "next/server";
import { updateAccountAutoPing } from "@/lib/db/index.js";
import { AUTO_PING_SETTINGS_KEYS } from "@/shared/services/quotaPingSchedule";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
};

const ALLOWED_BODY_KEYS = new Set(["provider", "connectionId", "reactive", "schedule"]);
const ALLOWED_SCHEDULE_KEYS = new Set(["enabled", "anchor", "timezone", "windowHours", "slotsPerDay"]);
const VALIDATION_ERROR_CODES = new Set([
  "INVALID_PROVIDER",
  "INVALID_CONNECTION_ID",
  "INVALID_REACTIVE",
  "INVALID_SCHEDULE",
  "PROVIDER_MISMATCH",
  "AUTHTYPE_MISMATCH",
]);

export async function PATCH(request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON body" },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Body must be a JSON object" },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    // Whitelist check on own properties rejects extra fields, __proto__, constructor, etc.
    for (const key of Object.keys(body)) {
      if (!ALLOWED_BODY_KEYS.has(key)) {
        return NextResponse.json(
          { error: `Unexpected field: ${key}` },
          { status: 400, headers: RESPONSE_HEADERS },
        );
      }
    }

    const { provider, connectionId, reactive, schedule } = body;

    if (!provider || typeof provider !== "string" || !Object.hasOwn(AUTO_PING_SETTINGS_KEYS, provider)) {
      return NextResponse.json(
        { error: `Unsupported provider: ${provider}` },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    if (!connectionId || typeof connectionId !== "string" || !connectionId.trim()) {
      return NextResponse.json(
        { error: "connectionId is required and must be a non-empty string" },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    if (typeof reactive !== "boolean") {
      return NextResponse.json(
        { error: "reactive must be a boolean" },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }

    if (schedule !== null && schedule !== undefined) {
      if (typeof schedule !== "object" || Array.isArray(schedule)) {
        return NextResponse.json(
          { error: "schedule must be an object or null" },
          { status: 400, headers: RESPONSE_HEADERS },
        );
      }

      for (const key of Object.keys(schedule)) {
        if (!ALLOWED_SCHEDULE_KEYS.has(key)) {
          return NextResponse.json(
            { error: `Unexpected schedule field: ${key}` },
            { status: 400, headers: RESPONSE_HEADERS },
          );
        }
      }

      if (
        (schedule.enabled !== undefined && typeof schedule.enabled !== "boolean") ||
        (schedule.anchor !== undefined && typeof schedule.anchor !== "string") ||
        (schedule.timezone !== undefined && typeof schedule.timezone !== "string") ||
        (schedule.windowHours !== undefined && typeof schedule.windowHours !== "number") ||
        (schedule.slotsPerDay !== undefined && typeof schedule.slotsPerDay !== "number")
      ) {
        return NextResponse.json(
          { error: "Invalid schedule field types" },
          { status: 400, headers: RESPONSE_HEADERS },
        );
      }
    }

    const { config, settings } = await updateAccountAutoPing({
      provider,
      connectionId,
      reactive,
      schedule: schedule ?? null,
    });

    if (settings) {
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((err) => console.warn("[AutoPing] scheduler config failed:", err.message));
    }

    return NextResponse.json(config, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      return NextResponse.json({ error: error.message }, { status: 404, headers: RESPONSE_HEADERS });
    }
    if (VALIDATION_ERROR_CODES.has(error.code)) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: RESPONSE_HEADERS });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: RESPONSE_HEADERS });
  }
}
