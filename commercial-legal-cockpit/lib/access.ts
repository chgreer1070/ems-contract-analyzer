import { auth, authenticationRequired } from "@/lib/auth";
import { databaseConfigured, query } from "@/lib/db";

export type AppRole = "VIEWER" | "LAWYER" | "APPROVER" | "ADMIN";
export type MatterAccessLevel = "VIEW" | "EDIT" | "APPROVE";
export type MatterBoundResource =
  | "AGREEMENT_VERSION"
  | "ANALYSIS_RUN"
  | "DECISION"
  | "DECISION_CONDITION"
  | "DEPENDENCY"
  | "DOCUMENT"
  | "DOCUMENT_RELATION"
  | "ECONOMICS_RUN"
  | "FINDING"
  | "PROCESSING_JOB"
  | "TERM";
export type Principal = {
  userId: string;
  name: string;
  email?: string | null;
  role: AppRole;
  demo: boolean;
};

const ROLE_RANK: Record<AppRole, number> = { VIEWER: 10, LAWYER: 20, APPROVER: 30, ADMIN: 40 };
const MATTER_ACCESS_RANK: Record<MatterAccessLevel, number> = { VIEW: 10, EDIT: 20, APPROVE: 30 };
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RESOURCE_TABLE: Record<MatterBoundResource, string> = {
  AGREEMENT_VERSION: "agreement_versions",
  ANALYSIS_RUN: "analysis_runs",
  DECISION: "decisions",
  DECISION_CONDITION: "decision_conditions",
  DEPENDENCY: "term_dependencies",
  DOCUMENT: "documents",
  DOCUMENT_RELATION: "document_relations",
  ECONOMICS_RUN: "economics_runs",
  FINDING: "findings",
  PROCESSING_JOB: "processing_jobs",
  TERM: "contract_terms"
};

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
    return { userId: "demo-user", name: "Demo Legal User", email: null, role: "VIEWER", demo: true };
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

export async function requireMatterAccess(
  request: Request,
  matterId: string,
  required: boolean | MatterAccessLevel = false
) {
  const principal = await getPrincipal(request);
  if (principal.demo) throw new AccessError("Persistent matter access is disabled in demo mode.", 503);
  if (!databaseConfigured()) throw new AccessError("Matter access requires DATABASE_URL.", 503);

  const requiredAccess: MatterAccessLevel = typeof required === "boolean"
    ? (required ? "EDIT" : "VIEW")
    : required;
  if (requiredAccess === "EDIT" && ROLE_RANK[principal.role] < ROLE_RANK.LAWYER) {
    throw new AccessError("Legal edit access required.", 403);
  }
  if (requiredAccess === "APPROVE" && ROLE_RANK[principal.role] < ROLE_RANK.APPROVER) {
    throw new AccessError("Approver role is required.", 403);
  }
  if (!UUID_PATTERN.test(matterId)) {
    throw new AccessError("Matter not found or access denied.", 404);
  }

  const result = await query<{ owner_user_id: string; restricted: boolean; member_access: MatterAccessLevel | null }>(
    `select m.owner_user_id, m.restricted,
            (select mm.access_level from matter_members mm where mm.matter_id = m.id and mm.user_id = $2 limit 1) as member_access
       from matters m
      where m.id = $1`,
    [matterId, principal.userId]
  );
  const matter = result.rows[0];
  if (!matter) throw new AccessError("Matter not found or access denied.", 404);

  if (principal.role === "ADMIN") return principal;

  const isOwner = matter.owner_user_id === principal.userId;
  if (isOwner) return principal;

  if (matter.member_access) {
    if (MATTER_ACCESS_RANK[matter.member_access] >= MATTER_ACCESS_RANK[requiredAccess]) return principal;
    throw new AccessError("Matter not found or access denied.", 404);
  }

  const globalLegalAccess = requiredAccess !== "APPROVE"
    && !matter.restricted
    && ROLE_RANK[principal.role] >= ROLE_RANK.LAWYER;
  if (globalLegalAccess) return principal;

  throw new AccessError("Matter not found or access denied.", 404);
}

/**
 * Authorizes a matter-bound opaque resource without first disclosing which
 * matter owns it. Missing and inaccessible resources intentionally share the
 * same response so callers cannot use resource UUIDs as an existence oracle.
 */
export async function requireResourceMatterAccess(
  request: Request,
  resourceType: MatterBoundResource,
  resourceId: string,
  required: boolean | MatterAccessLevel = false
) {
  const principal = await getPrincipal(request);
  if (principal.demo) throw new AccessError("Persistent resource access is disabled in demo mode.", 503);
  if (!databaseConfigured()) throw new AccessError("Persistent resource access requires DATABASE_URL.", 503);

  const requiredAccess: MatterAccessLevel = typeof required === "boolean"
    ? (required ? "EDIT" : "VIEW")
    : required;
  if (requiredAccess === "EDIT" && ROLE_RANK[principal.role] < ROLE_RANK.LAWYER) {
    throw new AccessError("Legal edit access required.", 403);
  }
  if (requiredAccess === "APPROVE" && ROLE_RANK[principal.role] < ROLE_RANK.APPROVER) {
    throw new AccessError("Approver role is required.", 403);
  }
  if (!UUID_PATTERN.test(resourceId)) {
    throw new AccessError("Resource not found or access denied.", 404);
  }

  const table = RESOURCE_TABLE[resourceType];
  const result = await query<{
    matter_id: string;
    owner_user_id: string;
    restricted: boolean;
    member_access: MatterAccessLevel | null;
  }>(
    `select rsc.matter_id, m.owner_user_id, m.restricted, mm.access_level as member_access
       from ${table} rsc
       join matters m on m.id = rsc.matter_id
       left join matter_members mm on mm.matter_id = m.id and mm.user_id = $2
      where rsc.id = $1
      limit 1`,
    [resourceId, principal.userId]
  );
  const resource = result.rows[0];
  const memberAuthorized = Boolean(
    resource?.member_access
    && MATTER_ACCESS_RANK[resource.member_access] >= MATTER_ACCESS_RANK[requiredAccess]
  );
  const globalLegalAccess = Boolean(
    resource
    && requiredAccess !== "APPROVE"
    && !resource.restricted
    && ROLE_RANK[principal.role] >= ROLE_RANK.LAWYER
  );
  const authorized = Boolean(
    resource
    && (
      principal.role === "ADMIN"
      || resource.owner_user_id === principal.userId
      || memberAuthorized
      || globalLegalAccess
    )
  );
  if (!authorized || !resource) {
    throw new AccessError("Resource not found or access denied.", 404);
  }

  return { principal, matterId: resource.matter_id };
}

export function accessErrorResponse(error: unknown) {
  if (error instanceof AccessError) {
    return Response.json({ ok: false, error: error.message }, { status: error.status });
  }
  return null;
}
