import { AccessError, accessErrorResponse, requireRole, type AppRole } from "@/lib/access";
import { databaseConfigured, query, withTransaction } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

const ROLES = new Set<AppRole>(["VIEWER","LAWYER","APPROVER","ADMIN"]);

export async function GET(request: Request) {
  try {
    const principal = await requireRole(request,"ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ok:true,mode:"demo",users:[]});
    const result = await query(`
      select u.id user_id,
             u.name,
             u.email,
             coalesce(r.role,'VIEWER') role,
             coalesce(r.active,false) role_explicit,
             r.granted_by,
             r.granted_at,
             coalesce(c.active,false) legal_counsel_attest_active,
             (c.user_id is not null) legal_counsel_attest_explicit,
             c.granted_by legal_counsel_attest_granted_by,
             c.granted_at legal_counsel_attest_granted_at
        from "user" u
        left join app_user_roles r on r.user_id=u.id
        left join app_user_capabilities c
          on c.user_id=u.id
         and c.capability='LEGAL_COUNSEL_ATTEST'
       order by u.name nulls last,u.email
    `);
    return Response.json({ok:true,mode:"database",currentUserId:principal.userId,users:result.rows});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return internalErrorResponse(error,"User roles could not be loaded.");
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireRole(request,"ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ok:false,error:"Role administration requires production identity and DATABASE_URL."},{status:503});
    const body=await request.json() as {userId?:string;role?:AppRole;active?:boolean};
    const userId=String(body.userId??"").trim();const role=body.role;
    if(!userId||!role||!ROLES.has(role)) return Response.json({ok:false,error:"Valid userId and role are required."},{status:400});
    const active=body.active!==false;
    const result=await withTransaction(async client=>{
      await client.query("lock table app_user_roles in share row exclusive mode");
      const actorRole=(await client.query<{role:string}>("select role from app_user_roles where user_id=$1 and active=true for update",[principal.userId])).rows[0]?.role;
      if(actorRole!=="ADMIN")throw new AccessError("Active Admin authority is required at role-change time.",403);
      const user=(await client.query<{id:string;email:string}>(`select id,email from "user" where id=$1 for share`,[userId])).rows[0];
      if(!user)throw new AccessError("Role target is not an authenticated ContractTwin user.",404);
      if(userId===principal.userId&&(role!=="ADMIN"||!active))throw new AccessError("An administrator cannot remove or demote their own active Admin role.",409);
      await client.query(`insert into app_user_roles(user_id,role,active,granted_by,granted_at) values($1,$2,$3,$4,now()) on conflict(user_id) do update set role=excluded.role,active=excluded.active,granted_by=excluded.granted_by,granted_at=now()`,[userId,role,active,principal.userId]);
      const adminCount=(await client.query<{count:number}>("select count(*)::int count from app_user_roles where role='ADMIN' and active=true")).rows[0]?.count??0;
      if(adminCount<1)throw new AccessError("At least one active Admin must remain.",409);
      let counselCapabilityRevoked=false;
      if(!active||role==="VIEWER"){
        const revoked=await client.query("update app_user_capabilities set active=false,granted_by=$2,granted_at=now() where user_id=$1 and capability='LEGAL_COUNSEL_ATTEST' and active=true",[userId,principal.userId]);
        counselCapabilityRevoked=Boolean(revoked.rowCount);
      }
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,entity_type,entity_id,metadata) values($1,$2,'ROLE_CHANGED','user_role',$3,$4::jsonb)`,[principal.userId,principal.name,userId,JSON.stringify({role,active,email:user.email,counselCapabilityRevoked})]);
      return {counselCapabilityRevoked};
    });
    return Response.json({ok:true,userId,role,active,...result});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return internalErrorResponse(error,"The user role could not be updated.");
  }
}
