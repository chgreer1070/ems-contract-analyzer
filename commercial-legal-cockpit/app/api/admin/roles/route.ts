import { accessErrorResponse, requireRole, type AppRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

const ROLES = new Set<AppRole>(["VIEWER","LAWYER","APPROVER","ADMIN"]);

export async function GET(request: Request) {
  try {
    const principal = await requireRole(request,"ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ok:true,mode:"demo",users:[]});
    const result = await query(`select u.id user_id,u.name,u.email,coalesce(r.role,'VIEWER') role,coalesce(r.active,false) role_explicit,r.granted_by,r.granted_at from "user" u left join app_user_roles r on r.user_id=u.id order by u.name nulls last,u.email`);
    return Response.json({ok:true,mode:"database",users:result.rows});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return Response.json({ok:false,error:"Unable to load user roles."},{status:500});
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
    await query(`insert into app_user_roles(user_id,role,active,granted_by,granted_at) values($1,$2,$3,$4,now()) on conflict(user_id) do update set role=excluded.role,active=excluded.active,granted_by=excluded.granted_by,granted_at=now()`,[userId,role,active,principal.userId]);
    await writeAuditEvent({principal,action:"ROLE_CHANGED",entityType:"user_role",entityId:userId,metadata:{role,active,email:user.rows[0].email}});
    return Response.json({ok:true,userId,role,active});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return Response.json({ok:false,error:"Unable to update role."},{status:500});
  }
}
