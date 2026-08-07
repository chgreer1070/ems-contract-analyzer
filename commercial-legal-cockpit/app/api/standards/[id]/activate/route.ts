import { accessErrorResponse, requireRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, withTransaction } from "@/lib/db";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireRole(request, "ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ ok:false, error:"Standard activation requires production identity and DATABASE_URL." }, { status:503 });
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { confirm?:boolean };
    if (body.confirm !== true) return Response.json({ ok:false, error:"Explicit confirm=true is required to activate a negotiation standard." }, { status:400 });
    const activated = await withTransaction(async (client) => {
      const target = await client.query<{clause_family:string;version:string}>("select clause_family,version from negotiation_standards where id=$1 for update",[id]);
      if (!target.rows[0]) return null;
      await client.query("update negotiation_standards set active=false where clause_family=$1",[target.rows[0].clause_family]);
      await client.query("update negotiation_standards set active=true where id=$1",[id]);
      return target.rows[0];
    });
    if (!activated) return Response.json({ ok:false, error:"Standard not found." }, { status:404 });
    await writeAuditEvent({ principal, action:"STANDARD_ACTIVATED", entityType:"negotiation_standard", entityId:id, metadata:{clauseFamily:activated.clause_family,version:activated.version} });
    return Response.json({ ok:true, active:true, clauseFamily:activated.clause_family, version:activated.version });
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return Response.json({ ok:false, error:"Unable to activate negotiation standard." }, { status:500 });
  }
}
