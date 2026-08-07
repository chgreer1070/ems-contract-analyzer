import { accessErrorResponse, getPrincipal, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";

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
    return Response.json({ ok:true, mode:"database", events:result.rows });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok:false, error:"Unable to load audit history." }, { status:500 });
  }
}
