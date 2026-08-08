import { start } from "workflow/api";
import { accessErrorResponse, requireRole } from "@/lib/access";
import { databaseConfigured } from "@/lib/db";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { legalValidationWorkflow } from "@/workflows/legal-validation";
import { VALIDATION_GATE_VERSION } from "@/lib/validation";

export async function POST(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Legal validation requires DATABASE_URL."},{status:503});
    if(!process.env.OPENAI_API_KEY)return Response.json({ok:false,error:"Legal validation requires OPENAI_API_KEY."},{status:503});
    const principal=await requireRole(request,"ADMIN");if(principal.demo)return Response.json({ok:false,error:"Production legal validation is disabled in demo mode."},{status:503});
    await enforceRateLimit(principal,"legal-validation",2,3600);
    const run=await start(legalValidationWorkflow,[principal.userId]);
    return Response.json({ok:true,runId:run.runId,gateVersion:VALIDATION_GATE_VERSION,status:"STARTED"});
  }catch(error){const rate=rateLimitResponse(error);if(rate)return rate;const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to start legal validation."},{status:500});}
}
