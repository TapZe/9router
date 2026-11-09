import { NextResponse } from "next/server";
import factory from "@/lib/oauth/providers/factory";
import { loadDroidCliCredentials } from "@/lib/oauth/utils/factoryCredentials";
import { createProviderConnection } from "@/models";

/**
 * GET /api/oauth/factory/auto-import
 * Check if local Factory Droid CLI credentials exist and discover identity.
 */
export async function GET() {
  try {
    const creds = await loadDroidCliCredentials();
    if (!creds || !creds.accessToken) {
      return NextResponse.json({
        found: false,
        error: "No local Factory Droid session detected in ~/.factory",
      });
    }

    const extra = await factory.postExchange({ access_token: creds.accessToken });
    if (!extra.orgId && creds.activeOrganizationId) {
      extra.orgId = creds.activeOrganizationId;
    }
    extra.isLocalCli = true;

    const mapped = factory.mapTokens(
      {
        access_token: creds.accessToken,
        refresh_token: creds.refreshToken,
      },
      extra
    );

    return NextResponse.json({
      found: true,
      email: mapped.email,
      displayName: mapped.displayName,
      orgId: mapped.providerSpecificData?.orgId || creds.activeOrganizationId || null,
      region: mapped.providerSpecificData?.region || null,
      hasRefreshToken: !!creds.refreshToken,
    });
  } catch (error) {
    return NextResponse.json({
      found: false,
      error: error.message || "Failed to inspect local Droid CLI credentials",
    });
  }
}

/**
 * POST /api/oauth/factory/auto-import
 * Import local Factory Droid CLI credentials directly into 9router connection.
 */
export async function POST() {
  try {
    const creds = await loadDroidCliCredentials();
    if (!creds || !creds.accessToken) {
      return NextResponse.json(
        { error: "No local Factory Droid session detected to import" },
        { status: 404 }
      );
    }

    const extra = await factory.postExchange({ access_token: creds.accessToken });
    if (!extra.orgId && creds.activeOrganizationId) {
      extra.orgId = creds.activeOrganizationId;
    }
    extra.isLocalCli = true;

    const tokens = factory.mapTokens(
      {
        access_token: creds.accessToken,
        refresh_token: creds.refreshToken,
      },
      extra
    );

    const connection = await createProviderConnection({
      provider: "factory",
      authType: "oauth",
      ...tokens,
      expiresAt: tokens.expiresAt || (tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
        : null),
      testStatus: "active",
    });

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
        displayName: connection.displayName,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to import Factory Droid credentials" },
      { status: 500 }
    );
  }
}
