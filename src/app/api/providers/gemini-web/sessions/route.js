import { NextResponse } from "next/server";
import {
  assertGeminiWebMutationOrigin,
  createGeminiWebSession,
  listGeminiWebSessionViews,
} from "@/lib/geminiWebAccounts.js";

export const dynamic = "force-dynamic";

function errorResponse(error) {
  const status = Number(error?.status) || 500;
  const body = { error: error?.message || "Gemini Web session request failed" };
  if (error?.code) body.code = error.code;
  if (error?.existingSessionId) body.existingSessionId = error.existingSessionId;
  return NextResponse.json(body, { status });
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
    assertGeminiWebMutationOrigin(request);
    const body = await request.json();
    const result = await createGeminiWebSession({
      name: body?.name,
      cookieHeader: body?.cookieHeader,
      authUsers: body?.authUsers,
      proxyPoolId: body?.proxyPoolId,
      signal: request.signal,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
