import { accessErrorResponse, requireRole, type AppRole } from "@/lib/access";
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
    const user=await query<{id:string;email:string}>(`select id,email from "user" where id=$1 limit 1`,[userId]);
    if(!user.rows[0])return Response.json({ok:false,error:"Role target is not an authenticated ContractTwin user."},{status:404});
    if(userId===principal.userId&&(role!=="ADMIN"||body.active===false)) return Response.json({ok:false,error:"An administrator cannot remove or demote their own active Admin role."},{status:409});
    const active=body.active!==false;
    await withTransaction(async client=>{
      await client.query(`insert into app_user_roles(user_id,role,active,granted_by,granted_at) values($1,$2,$3,$4,now()) on conflict(user_id) do update set role=excluded.role,active=excluded.active,granted_by=excluded.granted_by,granted_at=now()`,[userId,role,active,principal.userId]);
      await client.query(`insert into audit_events(actor_user_id,actor_name,action,entity_type,entity_id,metadata) values($1,$2,'ROLE_CHANGED','user_role',$3,$4::jsonb)`,[principal.userId,principal.name,userId,JSON.stringify({role,active,email:user.rows[0].email})]);
    });
    return Response.json({ok:true,userId,role,active});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return internalErrorResponse(error,"The user role could not be updated.");
  }
}
