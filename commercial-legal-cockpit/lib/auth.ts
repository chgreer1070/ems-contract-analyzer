import { betterAuth } from "better-auth";
import { getPool, databaseConfigured } from "@/lib/db";

const authRequired = process.env.AUTH_REQUIRED === "true";
const microsoftConfigured = Boolean(
  process.env.MICROSOFT_CLIENT_ID &&
  process.env.MICROSOFT_CLIENT_SECRET &&
  process.env.MICROSOFT_TENANT_ID
);

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

// Better Auth 1.7 Microsoft identity contract (not a silent 1.6 patch):
// - Account rows use the directory `oid` claim as `account.accountId` (stable), not the
//   pairwise app-specific `sub` used before 1.7.
// - A concrete tenant GUID is required so token `iss` is validated as
//   `${authority}/${tenantId}/v2.0` (multi-tenant aliases skip that fixed issuer check).
// Existing Microsoft account rows created under 1.6 must be migrated from `sub` to `oid`
// before production traffic; see OPERATIONS_RUNBOOK.md § Better Auth 1.7 upgrade.
export const auth = betterAuth({
  ...(databaseConfigured() ? { database: getPool() } : {}),
  ...(process.env.BETTER_AUTH_SECRET ? { secret: process.env.BETTER_AUTH_SECRET } : {}),
  ...(process.env.BETTER_AUTH_URL ? { baseURL: process.env.BETTER_AUTH_URL } : {}),
  socialProviders: microsoftConfigured
    ? {
        microsoft: {
          clientId: process.env.MICROSOFT_CLIENT_ID as string,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
          // Concrete Entra tenant GUID only — never common/organizations/consumers here.
          tenantId: process.env.MICROSOFT_TENANT_ID as string,
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
