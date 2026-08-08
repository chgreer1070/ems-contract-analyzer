import { accessErrorResponse, getPrincipal, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const matterId = url.searchParams.get("matterId");
    const principal = matterId ? await requireMatterAccess(request, matterId, false) : await getPrincipal(request);
    if (principal.demo || !databaseConfigured()) return Response.json({ ok:true, mode:"demo", events:[] });

    if (!matterId && principal.role !== "ADMIN") {
      return Response.json({ ok:false, error:"Portfolio audit access requires Admin role; supply a matterId for matter-scoped audit history." }, { status:403 });
    }

    const result = matterId
      ? await query(
          `select id,event_time,actor_user_id,actor_name,action,entity_type,entity_id,metadata
             from audit_events where matter_id = $1 order by event_time desc limit 250`,
          [matterId]
        )
      : await query(
          `select id,event_time,actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
             from audit_events order by event_time desc limit 250`
        );
    return Response.json({ ok:true, mode:"database", events:principal.role==="VIEWER"?result.rows.map((event:any)=>({...event,metadata:{redacted:true}})):result.rows });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"Audit history could not be loaded.");
  }
}
