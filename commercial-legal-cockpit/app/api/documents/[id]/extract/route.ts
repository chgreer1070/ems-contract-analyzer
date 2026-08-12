import { accessErrorResponse, requireResourceMatterAccess } from "@/lib/access";
import { databaseConfigured } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Document extraction requires DATABASE_URL."},{status:503});
    const {id}=await context.params;
    await requireResourceMatterAccess(request,"DOCUMENT",id,"EDIT");
    return Response.json({ok:false,error:"Direct extraction is disabled because it cannot provide the governed malware-scan, integrity, retry, and atomic provenance controls. Use the governed document pipeline."},{status:409});
  }catch(error){
    const access=accessErrorResponse(error);if(access)return access;
    return internalErrorResponse(error,"Document extraction authorization could not be completed.");
  }
}
