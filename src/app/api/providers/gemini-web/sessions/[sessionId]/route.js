import { NextResponse } from "next/server";
import { assertDashboardMutationOrigin } from "@/lib/mutationOrigin.js";
import {
  getGeminiWebSessionView,
  removeGeminiWebSession,
  updateGeminiWebSession,
} from "@/lib/geminiWebAccounts.js";

export const dynamic = "force-dynamic";

function errorResponse(error, request) {
  const status = request?.signal?.aborted ? 499 : Number(error?.status) || 500;
  const body = { error: error?.message || "Gemini Web session request failed" };
  if (error?.code) body.code = error.code;
  if (error?.existingSessionId) body.existingSessionId = error.existingSessionId;
  return NextResponse.json(body, { status });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

export async function GET(_request, { params }) {
  try {
    const { sessionId } = await params;
    const session = await getGeminiWebSessionView(sessionId);
    if (!session) {
      return NextResponse.json({ error: "Gemini Web session not found" }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request, { params }) {
  try {
    assertDashboardMutationOrigin(request);
    const { sessionId } = await params;
    const body = await readJsonBody(request);
    const result = await updateGeminiWebSession(sessionId, body || {}, { signal: request.signal });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, request);
  }
}

export async function DELETE(request, { params }) {
  try {
    assertDashboardMutationOrigin(request);
    const { sessionId } = await params;
    await removeGeminiWebSession(sessionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, request);
  }
}
