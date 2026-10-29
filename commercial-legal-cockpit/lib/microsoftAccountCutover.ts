import { databaseConfigured, query } from "@/lib/db";

export const MICROSOFT_ACCOUNT_PROVIDERS = ["microsoft", "microsoft-entra-id"] as const;
export const MICROSOFT_ACCOUNT_CUTOVER_ID = "better-auth-1.7-microsoft-oid";

const pausedBody = {
  error: "Microsoft sign-in is paused until the Better Auth 1.7 directory-object account migration is recorded."
};

export function microsoftSignInAllowed(input: {
  accountTablePresent: boolean;
  microsoftAccountCount: number;
  cutoverRecorded: boolean;
}) {
  if (!input.accountTablePresent || input.microsoftAccountCount === 0) return true;
  return input.cutoverRecorded;
}

let allowedForProcess = false;

export function resetMicrosoftAccountCutoverAllowance() {
  allowedForProcess = false;
}

function paused() {
  return Response.json(pausedBody, { status: 503 });
}

export async function enforceMicrosoftAccountCutover() {
  if (process.env.AUTH_REQUIRED !== "true" || !databaseConfigured() || allowedForProcess) return null;
  try {
    const presence = await query<{ account_table: boolean; cutover_table: boolean }>(
      `select to_regclass('public.account') is not null as account_table,
              to_regclass('public.microsoft_account_subject_cutover') is not null as cutover_table`
    );
    const accountTablePresent = Boolean(presence.rows[0]?.account_table);
    const cutoverTablePresent = Boolean(presence.rows[0]?.cutover_table);
    let microsoftAccountCount = 0;
    if (accountTablePresent) {
      const counts = await query<{ n: number }>(
        `select count(*)::int as n from public.account where "providerId" = any($1::text[])`,
        [MICROSOFT_ACCOUNT_PROVIDERS]
      );
      microsoftAccountCount = Number(counts.rows[0]?.n ?? 0);
    }
    let cutoverRecorded = false;
    if (cutoverTablePresent && microsoftAccountCount > 0) {
      const marker = await query(
        `select 1 as present from public.microsoft_account_subject_cutover where cutover_id = $1`,
        [MICROSOFT_ACCOUNT_CUTOVER_ID]
      );
      cutoverRecorded = marker.rows.length > 0;
    }
    if (!microsoftSignInAllowed({ accountTablePresent, microsoftAccountCount, cutoverRecorded })) return paused();
    allowedForProcess = true;
    return null;
  } catch {
    return paused();
  }
}
