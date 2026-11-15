import { AI_PROVIDERS } from "@/shared/constants/providers";

export function usesAwsCredentialForm(provider) {
  return AI_PROVIDERS[provider]?.credentialForm === "aws";
}

export function toProviderConnectionResponse(connection) {
  const { apiKey, accessToken, refreshToken, idToken, ...safe } = connection;

  if (!connection.providerSpecificData) return safe;

  if (connection.provider === "gemini-web" || connection.provider === "gweb") {
    const {
      cookie,
      __Secure_1PSID,
      ["__Secure-1PSID"]: psid,
      __Secure_1PSIDTS,
      ["__Secure-1PSIDTS"]: psidts,
      ...providerSpecificData
    } = connection.providerSpecificData;
    return { ...safe, providerSpecificData };
  }

  if (!usesAwsCredentialForm(connection.provider)) {
    return safe;
  }

  const { sessionToken, ...providerSpecificData } = connection.providerSpecificData;
  return { ...safe, providerSpecificData };
}
