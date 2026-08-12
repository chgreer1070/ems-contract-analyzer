import { AccessError, accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Economics review requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const {principal,matterId}=await requireResourceMatterAccess(request,"ECONOMICS_RUN",id,"APPROVE");
    const body=await request.json() as {status?:string;note?:string};
    const status=String(body.status??"").toUpperCase();
    const note=String(body.note??"").trim();
    if(!new Set(["VALIDATED","REJECTED"]).has(status)){
      return Response.json({ok:false,error:"Status must be VALIDATED or REJECTED."},{status:400});
    }
    if(note.length<12||note.length>4000){
      return Response.json({ok:false,error:"Economics review note must be between 12 and 4000 characters."},{status:400});
    }

    const reviewed=await withTransaction(async client=>{
      const activeRole=(await client.query<{role:string}>(
        "select role from app_user_roles where user_id=$1 and active=true for share",
        [principal.userId]
      )).rows[0]?.role;
      if(activeRole!=="APPROVER"&&activeRole!=="ADMIN"){
        throw new AccessError("Active Approver authority is required to review economics.",403);
      }
      const matter=(await client.query<{owner_user_id:string;member_access:string|null}>(`
        select m.owner_user_id,
               (select mm.access_level from matter_members mm
                 where mm.matter_id=m.id and mm.user_id=$2 for share) member_access
          from matters m where m.id=$1 for share`,
        [matterId,principal.userId]
      )).rows[0];
      if(!matter)throw new AccessError("Resource not found or access denied.",404);
      if(activeRole!=="ADMIN"&&matter.owner_user_id!==principal.userId&&matter.member_access!=="APPROVE"){
        throw new AccessError("Resource not found or access denied.",404);
      }
      const current=(await client.query<{
        review_status:string;
        agreement_version_id:string|null;
      }>(`
        select review_status,agreement_version_id
          from economics_runs where id=$1 and matter_id=$2 for update`,
        [id,matterId]
      )).rows[0];
      if(!current||current.review_status!=="UNREVIEWED")return null;
      if(!current.agreement_version_id){
        throw new AccessError("Legacy unbound economics cannot be reviewed as agreement-version evidence; save a new version-scoped run.",409);
      }
      const version=(await client.query<{status:string}>(
        "select status from agreement_versions where id=$1 and matter_id=$2 for share",
        [current.agreement_version_id,matterId]
      )).rows[0];
      if(!version||version.status==="SUPERSEDED"){
        throw new AccessError("The bound agreement version is no longer available for economics review.",409);
      }
      const updated=(await client.query<{
        id:string;
        review_status:string;
        reviewed_at:string;
      }>(`
        update economics_runs
           set review_status=$3,reviewed_by=$4,reviewed_at=now(),review_note=$5
         where id=$1 and matter_id=$2
         returning id,review_status,reviewed_at`,
        [id,matterId,status,principal.userId,note]
      )).rows[0];
      await client.query(`
        insert into audit_events(
          actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
        ) values($1,$2,'ECONOMICS_REVIEWED',$3,'economics_run',$4,$5::jsonb)`,
        [principal.userId,principal.name,matterId,id,JSON.stringify({
          agreementVersionId:current.agreement_version_id,from:"UNREVIEWED",to:status,
          substantiveNoteRecorded:true
        })]
      );
      return updated;
    });
    if(!reviewed)return Response.json({ok:false,error:"Economics review state changed; reload and retry."},{status:409});
    return Response.json({ok:true,economicsRun:reviewed});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"The economics review could not be completed.");
  }
}
