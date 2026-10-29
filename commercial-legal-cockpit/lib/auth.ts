import { betterAuth } from "better-auth";
import { getPool, databaseConfigured } from "@/lib/db";

const authRequired = process.env.AUTH_REQUIRED === "true";
const ENTRA_TENANT_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVED_MICROSOFT_TENANTS = new Set(["common", "organizations", "consumers"]);
const microsoftConfigured = Boolean(
  process.env.MICROSOFT_CLIENT_ID &&
  process.env.MICROSOFT_CLIENT_SECRET &&
  process.env.MICROSOFT_TENANT_ID
);

const microsoftTenantId = microsoftConfigured
  ? (process.env.MICROSOFT_TENANT_ID as string).trim().toLowerCase()
  : "";

if (microsoftConfigured) {
  if (RESERVED_MICROSOFT_TENANTS.has(microsoftTenantId) || !ENTRA_TENANT_GUID.test(microsoftTenantId)) {
    throw new Error("MICROSOFT_TENANT_ID must be the Entra directory GUID. Better Auth 1.7 identifies Microsoft accounts by the directory object id (oid) for that tenant. The values common, organizations, and consumers are not accepted.");
  }
}

if (authRequired && process.env.NODE_ENV === "production") {
  const missing = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET],
    ["BETTER_AUTH_URL", process.env.BETTER_AUTH_URL],
    ["MICROSOFT_CLIENT_ID", process.env.MICROSOFT_CLIENT_ID],
    ["MICROSOFT_CLIENT_SECRET", process.env.MICROSOFT_CLIENT_SECRET],
    ["MICROSOFT_TENANT_ID", process.env.MICROSOFT_TENANT_ID]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Production authentication is enabled but missing: ${missing.join(", ")}`);
  }
}

// Better Auth 1.7 rejects its built-in development secret whenever NODE_ENV is
// production, including `next build`. The placeholder is used only while sign-in
// is not required. Real sign-in still requires BETTER_AUTH_SECRET.
const unconfiguredAuthSecret = "contracttwin-unconfigured-auth-placeholder-not-for-sign-in";

export const auth = betterAuth({
  ...(databaseConfigured() ? { database: getPool() } : {}),
  ...(process.env.BETTER_AUTH_SECRET
    ? { secret: process.env.BETTER_AUTH_SECRET }
    : authRequired
      ? {}
      : { secret: unconfiguredAuthSecret }),
  ...(process.env.BETTER_AUTH_URL ? { baseURL: process.env.BETTER_AUTH_URL } : {}),
  socialProviders: microsoftConfigured
    ? {
        microsoft: {
          clientId: process.env.MICROSOFT_CLIENT_ID as string,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
          tenantId: microsoftTenantId,
          authority: "https://login.microsoftonline.com",
          prompt: "select_account"
        }
      }
    : {}
});

export function authenticationRequired() {
  return authRequired;
}

export function isMicrosoftConfigured() {
  return microsoftConfigured;
}
