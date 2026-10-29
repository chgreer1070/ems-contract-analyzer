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
  // Better Auth 1.7 stores the Entra directory object id, not the old
  // app-specific subject. Setting this flag is the human acknowledgment that
  // the paused-sign-in cutover has already been checked. It is not a secret.
  if (process.env.MICROSOFT_ACCOUNT_IDENTIFIER !== "oid") {
    throw new Error("Production authentication requires MICROSOFT_ACCOUNT_IDENTIFIER=oid. Better Auth 1.7 stores the Microsoft Entra directory object id (oid) as the account id. The previous app-specific subject (sub) must be rewritten by scripts/microsoft-account-identifier-cutover.mjs while Microsoft sign-in is paused. Do not set this before that script reports it is safe to apply.");
  }
}

export const auth = betterAuth({
  ...(databaseConfigured() ? { database: getPool() } : {}),
  ...(process.env.BETTER_AUTH_SECRET ? { secret: process.env.BETTER_AUTH_SECRET } : {}),
  ...(process.env.BETTER_AUTH_URL ? { baseURL: process.env.BETTER_AUTH_URL } : {}),
  socialProviders: microsoftConfigured
    ? {
        microsoft: {
          clientId: process.env.MICROSOFT_CLIENT_ID as string,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
          tenantId: process.env.MICROSOFT_TENANT_ID as string,
          // Built-in Microsoft provider. Its account id is the verified Entra
          // directory object id. Profile fields must not replace that id.
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
