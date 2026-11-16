import { NextResponse } from "next/server";
import { assertDashboardMutationOrigin } from "@/lib/mutationOrigin.js";
import {
  createGeminiWebSession,
  listGeminiWebSessionViews,
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

export async function GET() {
  try {
    const sessions = await listGeminiWebSessionViews();
    return NextResponse.json({ sessions });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request) {
  try {
    assertDashboardMutationOrigin(request);
    const body = await readJsonBody(request);
    const result = await createGeminiWebSession({
      name: body?.name,
      cookieHeader: body?.cookieHeader,
      authUsers: body?.authUsers,
      proxyPoolId: body?.proxyPoolId,
      signal: request.signal,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error, request);
  }
}
