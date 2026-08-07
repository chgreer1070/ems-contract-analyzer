import { accessErrorResponse, requireRole, type AppRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

const ROLES = new Set<AppRole>(["VIEWER","LAWYER","APPROVER","ADMIN"]);

export async function GET(request: Request) {
  try {
    const principal = await requireRole(request,"ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ok:true,mode:"demo",roles:[]});
    const result = await query("select user_id,role,active,granted_by,granted_at from app_user_roles order by granted_at desc");
    return Response.json({ok:true,mode:"database",roles:result.rows});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return Response.json({ok:false,error:"Unable to load roles."},{status:500});
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireRole(request,"ADMIN");
    if (principal.demo || !databaseConfigured()) return Response.json({ok:false,error:"Role administration requires production identity and DATABASE_URL."},{status:503});
    const body=await request.json() as {userId?:string;role?:AppRole;active?:boolean};
    const userId=String(body.userId??"").trim();
    const role=body.role;
    if(!userId||!role||!ROLES.has(role)) return Response.json({ok:false,error:"Valid userId and role are required."},{status:400});
    if(userId===principal.userId&&role!=="ADMIN") return Response.json({ok:false,error:"An administrator cannot demote their own active admin role through this endpoint."},{status:409});
    const active=body.active!==false;
    await query(`insert into app_user_roles(user_id,role,active,granted_by,granted_at)
                 values($1,$2,$3,$4,now())
                 on conflict(user_id) do update set role=excluded.role,active=excluded.active,granted_by=excluded.granted_by,granted_at=now()`,
      [userId,role,active,principal.userId]);
    await writeAuditEvent({principal,action:"ROLE_CHANGED",entityType:"user_role",entityId:userId,metadata:{role,active}});
    return Response.json({ok:true,userId,role,active});
  } catch (error) {
    const access=accessErrorResponse(error); if(access)return access;
    return Response.json({ok:false,error:"Unable to update role."},{status:500});
  }
}
