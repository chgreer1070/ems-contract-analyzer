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

// Better Auth 1.7+ stores Microsoft accountId from Entra `oid` claim (not pairwise `sub`).
// Databases that already linked Microsoft users on 1.6 must complete
// `npm run db:migrate:microsoft-oid` before production traffic on 1.7.
// Direct upgrades from 1.6 to 1.7.3+ need no account.issuer schema column.
export const auth = betterAuth({
  ...(databaseConfigured() ? { database: getPool() } : {}),
  ...(process.env.BETTER_AUTH_SECRET ? { secret: process.env.BETTER_AUTH_SECRET } : {}),
  ...(process.env.BETTER_AUTH_URL ? { baseURL: process.env.BETTER_AUTH_URL } : {}),
  socialProviders: microsoftConfigured
    ? {
        microsoft: {
          clientId: process.env.MICROSOFT_CLIENT_ID as string,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
          // Concrete tenant GUID only — required for issuer validation and oid migration.
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
