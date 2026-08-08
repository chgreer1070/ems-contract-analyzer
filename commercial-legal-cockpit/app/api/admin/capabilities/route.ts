import { AccessError, accessErrorResponse, requireRole } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

const LEGAL_COUNSEL_CAPABILITY = "LEGAL_COUNSEL_ATTEST" as const;
const MIN_REASON_LENGTH = 12;
const MAX_REASON_LENGTH = 1000;

type CapabilityChangeRequest = {
  userId?: unknown;
  capability?: unknown;
  active?: unknown;
  confirmLegalCounselAuthority?: unknown;
  confirmSelfChange?: unknown;
  reason?: unknown;
};

export async function POST(request: Request) {
  try {
    const principal = await requireRole(request,"ADMIN");
    if (principal.demo || !databaseConfigured()) {
      return Response.json(
        {ok:false,error:"Counsel-authority administration requires production identity and DATABASE_URL."},
        {status:503}
      );
    }

    let body: CapabilityChangeRequest;
    try {
      body=await request.json() as CapabilityChangeRequest;
    } catch {
      return Response.json({ok:false,error:"A valid JSON request body is required."},{status:400});
    }

    const userId=typeof body.userId==="string"?body.userId.trim():"";
    const reason=typeof body.reason==="string"?body.reason.trim():"";
    if(!userId||userId.length>255) {
      return Response.json({ok:false,error:"A valid authenticated userId is required."},{status:400});
    }
    if(body.capability!==LEGAL_COUNSEL_CAPABILITY) {
      return Response.json({ok:false,error:"Only LEGAL_COUNSEL_ATTEST authority can be administered here."},{status:400});
    }
    if(typeof body.active!=="boolean") {
      return Response.json({ok:false,error:"active must explicitly be true (grant) or false (revoke)."},{status:400});
    }
    if(body.confirmLegalCounselAuthority!==true) {
      return Response.json({ok:false,error:"Explicit legal-counsel authority confirmation is required."},{status:400});
    }
    if(reason.length<MIN_REASON_LENGTH||reason.length>MAX_REASON_LENGTH) {
      return Response.json(
        {ok:false,error:`A governance reason between ${MIN_REASON_LENGTH} and ${MAX_REASON_LENGTH} characters is required.`},
        {status:400}
      );
    }
    const selfChange=userId===principal.userId;
    if(selfChange&&body.confirmSelfChange!==true) {
      return Response.json({ok:false,error:"Changing your own counsel authority requires separate self-change confirmation."},{status:409});
    }

    const result=await withTransaction(async client=>{
      const activeAdmin=await client.query(
        `select 1
           from app_user_roles
          where user_id=$1 and role='ADMIN' and active=true
          for update`,
        [principal.userId]
      );
      if(activeAdmin.rowCount!==1) {
        throw new AccessError("Active Admin authority is required.",403);
      }

      const target=await client.query<{id:string;email:string|null;name:string|null}>(
        `select id,email,name from "user" where id=$1 for update`,
        [userId]
      );
      if(!target.rows[0]) {
        throw new AccessError("Counsel-authority target is not an authenticated ContractTwin user.",404);
      }
      const targetRole=await client.query<{role:string;active:boolean}>(
        `select role,active from app_user_roles where user_id=$1 for share`,
        [userId]
      );
      if(body.active&&(!targetRole.rows[0]?.active||!["LAWYER","APPROVER","ADMIN"].includes(targetRole.rows[0].role))){
        throw new AccessError("Legal-counsel attestation authority requires an active Lawyer, Approver, or Admin application role.",409);
      }

      const current=await client.query<{active:boolean}>(
        `select active
           from app_user_capabilities
          where user_id=$1 and capability=$2
          for update`,
        [userId,LEGAL_COUNSEL_CAPABILITY]
      );
      const previousActive=current.rows[0]?.active??false;
      const explicitRecord=Boolean(current.rows[0]);
      if(previousActive===body.active&&(body.active||explicitRecord)) {
        return {changed:false,email:target.rows[0].email};
      }
      if(!body.active&&!explicitRecord) {
        return {changed:false,email:target.rows[0].email};
      }

      await client.query(
        `insert into app_user_capabilities(user_id,capability,active,granted_by,granted_at)
         values($1,$2,$3,$4,now())
         on conflict(user_id,capability) do update
           set active=excluded.active,
               granted_by=excluded.granted_by,
               granted_at=now()`,
        [userId,LEGAL_COUNSEL_CAPABILITY,body.active,principal.userId]
      );
      await client.query(
        `insert into audit_events(actor_user_id,actor_name,action,entity_type,entity_id,metadata)
         values($1,$2,'LEGAL_COUNSEL_AUTHORITY_CHANGED','app_user_capability',$3,$4::jsonb)`,
        [
          principal.userId,
          principal.name,
          userId,
          JSON.stringify({
            capability:LEGAL_COUNSEL_CAPABILITY,
            operation:body.active?"GRANT":"REVOKE",
            previousActive,
            active:body.active,
            targetEmail:target.rows[0].email,
            targetRole:targetRole.rows[0]?.role??null,
            selfChange,
            reason
          })
        ]
      );
      return {changed:true,email:target.rows[0].email};
    });

    return Response.json({
      ok:true,
      userId,
      capability:LEGAL_COUNSEL_CAPABILITY,
      active:body.active,
      changed:result.changed
    });
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"Legal-counsel authority could not be updated.");
  }
}
