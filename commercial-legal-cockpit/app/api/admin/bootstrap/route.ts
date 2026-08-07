import { getPrincipal, accessErrorResponse } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query, withTransaction } from "@/lib/db";

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Admin bootstrap requires DATABASE_URL."},{status:503});
    const principal=await getPrincipal(request);
    if(principal.demo)return Response.json({ok:false,error:"Admin bootstrap is disabled in demo mode."},{status:503});
    const expected=process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    if(!expected)return Response.json({ok:false,error:"BOOTSTRAP_ADMIN_EMAIL is not configured."},{status:503});
    if(!principal.email||principal.email.toLowerCase()!==expected)return Response.json({ok:false,error:"This identity is not authorized to bootstrap administration."},{status:403});
    const body=await request.json().catch(()=>({})) as {confirm?:boolean};
    if(body.confirm!==true)return Response.json({ok:false,error:"Explicit confirm=true is required."},{status:400});
    const result=await withTransaction(async client=>{
      await client.query("select pg_advisory_xact_lock(hashtext('contracttwin-first-admin'))");
      const admins=await client.query<{count:string}>("select count(*)::text count from app_user_roles where role='ADMIN' and active=true");
      if(Number(admins.rows[0].count)>0)return {created:false,reason:"An active Admin already exists."};
      await client.query(`insert into app_user_roles(user_id,role,active,granted_by,granted_at) values($1,'ADMIN',true,$1,now()) on conflict(user_id) do update set role='ADMIN',active=true,granted_by=excluded.granted_by,granted_at=now()`,[principal.userId]);
      return {created:true};
    });
    if(!result.created)return Response.json({ok:false,error:result.reason},{status:409});
    const adminPrincipal={...principal,role:"ADMIN" as const};
    await writeAuditEvent({principal:adminPrincipal,action:"ROLE_CHANGED",entityType:"app_user_role",entityId:principal.userId,metadata:{role:"ADMIN",bootstrap:true,email:principal.email}});
    return Response.json({ok:true,role:"ADMIN",message:"First Admin bootstrap completed. Remove BOOTSTRAP_ADMIN_EMAIL from the production environment after confirming access."});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Admin bootstrap failed."},{status:500});}
}
