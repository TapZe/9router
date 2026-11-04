import { NextResponse } from "next/server";
import { setProviderConnectionPriorities } from "@/models";

// POST /api/providers/reorder - persist adjacent account ranks in one transaction
export async function POST(request) {
  try {
    const body = await request.json();
    const result = await setProviderConnectionPriorities(body?.items);
    if (!result.ok) {
      const status = result.error === "Connection not found" ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error reordering connections:", error);
    return NextResponse.json({ error: "Failed to reorder connections" }, { status: 500 });
  }
}
