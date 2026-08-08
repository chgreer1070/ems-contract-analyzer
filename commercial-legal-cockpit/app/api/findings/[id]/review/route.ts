import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

const ALLOWED = new Set(["VALIDATED", "REJECTED"]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!databaseConfigured()) {
      return Response.json({ ok: false, error: "Finding review requires DATABASE_URL." }, { status: 503 });
    }
    const { id } = await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"FINDING",id,"EDIT");

    const body = await request.json() as { status?: string; note?: string };
    const status = String(body.status ?? "").toUpperCase();
    if (!ALLOWED.has(status)) {
      return Response.json({ ok: false, error: "Status must be VALIDATED or REJECTED." }, { status: 400 });
    }
    const note=String(body.note??"").trim();
    if(note.length<12)return Response.json({ok:false,error:"A substantive human-review note of at least 12 characters is required."},{status:400});

    const updated = await withTransaction(async client=>{
      const locked=await client.query<{review_status:string}>("select review_status from findings where id=$1 and matter_id=$2 for update",[id,matterId]);
      if(!locked.rows[0])throw new Error("Finding disappeared during review.");
      if(locked.rows[0].review_status!=="UNREVIEWED")return null;
      const result=await client.query<{ id: string; review_status: string; reviewed_at: string }>(`update findings set review_status=$3,reviewed_by=$4,reviewed_at=now(),review_note=$5 where id=$1 and matter_id=$2 returning id,review_status,reviewed_at`,[id,matterId,status,principal.userId,note]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata) values($1,$2,'FINDING_REVIEWED',$3,'finding',$4,$5::jsonb)`,[principal.userId,principal.name,matterId,id,JSON.stringify({from:locked.rows[0].review_status,to:status,noteRecorded:true})]);
      return result;
    });

    if(!updated)return Response.json({ok:false,error:"Only an UNREVIEWED finding can receive a human disposition."},{status:409});
    return Response.json({ ok: true, finding: updated.rows[0] });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"The finding review could not be completed.");
  }
}
