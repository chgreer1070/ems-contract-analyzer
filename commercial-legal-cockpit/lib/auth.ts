import { betterAuth } from "better-auth";
import { getPool, databaseConfigured } from "@/lib/db";

const authRequired = process.env.AUTH_REQUIRED === "true";

/**
 * Better Auth 1.7 keys Microsoft accounts on the verified Entra `oid` claim and
 * derives the trusted account issuer from a concrete tenant GUID. Ambiguous
 * tenants (`common` / `organizations` / `consumers`) skip issuer validation and
 * are rejected here so production SSO cannot silently accept cross-tenant tokens.
 * Existing 1.6 rows still store the pairwise `sub` as `account.accountId` and
 * must be migrated before production traffic on 1.7; see OPERATIONS_RUNBOOK.md.
 */
const AMBIGUOUS_MICROSOFT_TENANTS = new Set(["common", "organizations", "consumers"]);
const MICROSOFT_TENANT_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveMicrosoftTenantId(): string | null {
  const raw = process.env.MICROSOFT_TENANT_ID?.trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (AMBIGUOUS_MICROSOFT_TENANTS.has(normalized)) {
    throw new Error(
      "MICROSOFT_TENANT_ID must be a concrete Entra tenant GUID. Better Auth 1.7 rejects common/organizations/consumers so the Microsoft account issuer can be validated."
    );
  }
  if (!MICROSOFT_TENANT_GUID.test(raw)) {
    throw new Error("MICROSOFT_TENANT_ID must be a concrete Entra tenant GUID.");
  }
  return normalized;
}

const microsoftTenantId = resolveMicrosoftTenantId();
const microsoftConfigured = Boolean(
  process.env.MICROSOFT_CLIENT_ID &&
  process.env.MICROSOFT_CLIENT_SECRET &&
  microsoftTenantId
);

if (authRequired && process.env.NODE_ENV === "production") {
  const missing = [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET],
    ["BETTER_AUTH_URL", process.env.BETTER_AUTH_URL],
    ["MICROSOFT_CLIENT_ID", process.env.MICROSOFT_CLIENT_ID],
    ["MICROSOFT_CLIENT_SECRET", process.env.MICROSOFT_CLIENT_SECRET],
    ["MICROSOFT_TENANT_ID", microsoftTenantId]
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
          // Concrete tenant GUID required so Better Auth 1.7 can bind the ID-token issuer.
          tenantId: microsoftTenantId as string,
          authority: "https://login.microsoftonline.com",
          prompt: "select_account",
          // Avoid oversized base64 photo payloads in session/header paths.
          disableProfilePhoto: true
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
