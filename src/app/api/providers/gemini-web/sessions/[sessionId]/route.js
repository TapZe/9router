import { NextResponse } from "next/server";
import {
  assertGeminiWebMutationOrigin,
  getGeminiWebSessionView,
  removeGeminiWebSession,
  updateGeminiWebSession,
} from "@/lib/geminiWebAccounts.js";

export const dynamic = "force-dynamic";

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const body = { error: error?.message || "Gemini Web session request failed" };
  if (error?.code) body.code = error.code;
  if (error?.existingSessionId) body.existingSessionId = error.existingSessionId;
  return NextResponse.json(body, { status });
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
    assertGeminiWebMutationOrigin(request);
    const { sessionId } = await params;
    const body = await request.json();
    const result = await updateGeminiWebSession(sessionId, body || {}, { signal: request.signal });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request, { params }) {
  try {
    assertGeminiWebMutationOrigin(request);
    const { sessionId } = await params;
    await removeGeminiWebSession(sessionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
