import { auth, authenticationRequired } from "@/lib/auth";
import { databaseConfigured, query } from "@/lib/db";

export type AppRole = "VIEWER" | "LAWYER" | "APPROVER" | "ADMIN";
export type Principal = {
  userId: string;
  name: string;
  email?: string | null;
  role: AppRole;
  demo: boolean;
};

const ROLE_RANK: Record<AppRole, number> = { VIEWER: 10, LAWYER: 20, APPROVER: 30, ADMIN: 40 };

export class AccessError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function demoAccessAllowed() {
  if (authenticationRequired()) return false;
  if (process.env.ALLOW_DEMO_ACCESS === "true") return true;
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.VERCEL_ENV === "preview";
}

export async function getPrincipal(request: Request): Promise<Principal> {
  if (demoAccessAllowed()) {
    return { userId: "demo-user", name: "Demo Legal User", email: null, role: "ADMIN", demo: true };
  }

  if (!authenticationRequired()) {
    throw new AccessError("Production access is disabled until AUTH_REQUIRED=true and SSO is configured.", 503);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AccessError("Authentication required.", 401);

  let role: AppRole = "VIEWER";
  if (databaseConfigured()) {
    const result = await query<{ role: AppRole }>(
      "select role from app_user_roles where user_id = $1 and active = true limit 1",
      [session.user.id]
    );
    role = result.rows[0]?.role ?? "VIEWER";
  }

  return {
    userId: session.user.id,
    name: session.user.name || "Authenticated user",
    email: session.user.email,
    role,
    demo: false
  };
}

export async function requireRole(request: Request, minimum: AppRole) {
  const principal = await getPrincipal(request);
  if (ROLE_RANK[principal.role] < ROLE_RANK[minimum]) {
    throw new AccessError(`Role ${minimum} or higher is required.`, 403);
  }
  return principal;
}

export async function requireMatterAccess(request: Request, matterId: string, edit = false) {
  const principal = await getPrincipal(request);
  if (principal.demo) return principal;
  if (!databaseConfigured()) throw new AccessError("Matter access requires DATABASE_URL.", 503);
  if (principal.role === "ADMIN") return principal;
  if (edit && ROLE_RANK[principal.role] < ROLE_RANK.LAWYER) {
    throw new AccessError("Legal edit access required.", 403);
  }

  const result = await query<{ owner_user_id: string; restricted: boolean; member_access: string | null }>(
    `select m.owner_user_id, m.restricted,
            (select mm.access_level from matter_members mm where mm.matter_id = m.id and mm.user_id = $2 limit 1) as member_access
       from matters m
      where m.id = $1`,
    [matterId, principal.userId]
  );
  const matter = result.rows[0];
  if (!matter) throw new AccessError("Matter not found.", 404);

  const isOwner = matter.owner_user_id === principal.userId;
  const isMember = Boolean(matter.member_access);
  const globalLegalAccess = !matter.restricted && ROLE_RANK[principal.role] >= ROLE_RANK.LAWYER;
  if (!isOwner && !isMember && !globalLegalAccess) throw new AccessError("Matter access denied.", 403);

  if (edit && matter.member_access === "VIEW" && !isOwner) {
    throw new AccessError("Matter edit access denied.", 403);
  }
  return principal;
}

export function accessErrorResponse(error: unknown) {
  if (error instanceof AccessError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status });
  }
  return null;
}
