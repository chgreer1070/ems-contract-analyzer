import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

const LEVELS = new Set(["VIEW","EDIT","APPROVE"]);

async function requireMembershipAdmin(request: Request, matterId: string) {
  const principal = await requireMatterAccess(request,matterId,true);
  if(principal.demo) return principal;
  const result=await query<{owner_user_id:string}>("select owner_user_id from matters where id=$1",[matterId]);
  if(!result.rows[0]) throw new Error("Matter not found.");
  if(principal.role!=="ADMIN"&&result.rows[0].owner_user_id!==principal.userId) {
    return null;
  }
  return principal;
}

export async function GET(request: Request, context:{params:Promise<{id:string}>}) {
  try {
    if(!databaseConfigured()) return Response.json({ok:true,mode:"demo",members:[]});
    const {id}=await context.params;
    const principal=await requireMatterAccess(request,id,false);
    if(principal.demo) return Response.json({ok:true,mode:"demo",members:[]});
    const result=await query("select user_id,access_level,granted_by,granted_at from matter_members where matter_id=$1 order by granted_at",[id]);
    return Response.json({ok:true,mode:"database",members:result.rows});
  } catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:"Unable to load matter members."},{status:500});}
}

export async function POST(request: Request, context:{params:Promise<{id:string}>}) {
  try {
    if(!databaseConfigured()) return Response.json({ok:false,error:"Matter membership requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const principal=await requireMembershipAdmin(request,id);
    if(!principal) return Response.json({ok:false,error:"Only the matter owner or an Admin can change membership."},{status:403});
    if(principal.demo) return Response.json({ok:false,error:"Membership persistence is disabled in demo mode."},{status:503});
    const body=await request.json() as {userId?:string;accessLevel?:string};
    const userId=String(body.userId??"").trim();const accessLevel=String(body.accessLevel??"").toUpperCase();
    if(!userId||!LEVELS.has(accessLevel)) return Response.json({ok:false,error:"Valid userId and accessLevel are required."},{status:400});
    await query(`insert into matter_members(matter_id,user_id,access_level,granted_by,granted_at)
                 values($1,$2,$3,$4,now())
                 on conflict(matter_id,user_id) do update set access_level=excluded.access_level,granted_by=excluded.granted_by,granted_at=now()`,[id,userId,accessLevel,principal.userId]);
    await writeAuditEvent({principal,action:"MATTER_UPDATED",matterId:id,entityType:"matter_member",entityId:userId,metadata:{operation:"UPSERT",accessLevel}});
    return Response.json({ok:true,userId,accessLevel});
  } catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:"Unable to change matter membership."},{status:500});}
}

export async function DELETE(request: Request, context:{params:Promise<{id:string}>}) {
  try {
    if(!databaseConfigured()) return Response.json({ok:false,error:"Matter membership requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    const principal=await requireMembershipAdmin(request,id);
    if(!principal) return Response.json({ok:false,error:"Only the matter owner or an Admin can change membership."},{status:403});
    if(principal.demo) return Response.json({ok:false,error:"Membership persistence is disabled in demo mode."},{status:503});
    const userId=new URL(request.url).searchParams.get("userId")?.trim();
    if(!userId) return Response.json({ok:false,error:"userId is required."},{status:400});
    const owner=await query<{owner_user_id:string}>("select owner_user_id from matters where id=$1",[id]);
    if(owner.rows[0]?.owner_user_id===userId) return Response.json({ok:false,error:"The matter owner cannot be removed as a member."},{status:409});
    await query("delete from matter_members where matter_id=$1 and user_id=$2",[id,userId]);
    await writeAuditEvent({principal,action:"MATTER_UPDATED",matterId:id,entityType:"matter_member",entityId:userId,metadata:{operation:"DELETE"}});
    return Response.json({ok:true,userId});
  } catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:"Unable to remove matter member."},{status:500});}
}
