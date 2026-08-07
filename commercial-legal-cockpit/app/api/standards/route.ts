import { accessErrorResponse, getPrincipal, requireRole } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const principal = await getPrincipal(request);
    if (principal.demo || !databaseConfigured()) return Response.json({ ok:true,mode:"demo",standards:[],warning:"No approved company standards are loaded in demo mode." });
    const result = await query<any>(
      `select id,clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,active,version,effective_date,created_by,created_at
         from negotiation_standards
        where active=true or $1='ADMIN'
        order by clause_family,active desc,effective_date desc`,[principal.role]
    );
    return Response.json({ok:true,mode:"database",standards:result.rows,adminView:principal.role==="ADMIN"});
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return Response.json({ok:false,error:"Unable to load negotiation standards."},{status:500});
  }
}

export async function POST(request: Request) {
  try {
    const principal=await requireRole(request,"ADMIN");
    if(principal.demo||!databaseConfigured())return Response.json({ok:false,error:"Standard administration requires production identity and DATABASE_URL."},{status:503});
    const body=await request.json() as Record<string,unknown>;const required=["clauseFamily","title","standardPosition","version","effectiveDate"];
    for(const field of required)if(!String(body[field]??"").trim())return Response.json({ok:false,error:`${field} is required.`},{status:400});
    const result=await query<{id:string}>(`insert into negotiation_standards(clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,active,version,effective_date,created_by) values($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10) returning id`,[String(body.clauseFamily),String(body.title),String(body.standardPosition),String(body.fallbackPosition??"").trim()||null,String(body.noGoPosition??"").trim()||null,String(body.approvalAuthority??"").trim()||null,String(body.businessRationale??"").trim()||null,String(body.version),String(body.effectiveDate),principal.userId]);
    await writeAuditEvent({principal,action:"STANDARD_CREATED",entityType:"negotiation_standard",entityId:result.rows[0].id,metadata:{clauseFamily:String(body.clauseFamily),version:String(body.version),active:false}});
    return Response.json({ok:true,standardId:result.rows[0].id,active:false,message:"Standard created inactive; activate only after formal approval."},{status:201});
  } catch (error) {
    const access=accessErrorResponse(error);if(access)return access;
    return Response.json({ok:false,error:"Unable to create negotiation standard."},{status:500});
  }
}
