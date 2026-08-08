import { accessErrorResponse, requireRole } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { internalErrorResponse, safePersistedFailureForDisplay } from "@/lib/safeErrors";

export async function GET(request:Request){
  try{
    const principal=await requireRole(request,"ADMIN");
    if(principal.demo)return Response.json({ok:false,error:"Production validation evidence is unavailable in demo mode."},{status:503});
    if(!databaseConfigured())return Response.json({ok:false,error:"Validation evidence requires DATABASE_URL."},{status:503});
    const run=await query<any>(`select id,run_label,model_name,prompt_version,corpus_version,status,total_cases,passed_cases,grounded_precision,family_recall,unsafe_policy_invention_count,exact_quote_failure_count,started_at,finished_at,summary from validation_runs order by started_at desc limit 1`);
    if(!run.rows[0])return Response.json({ok:true,validation:null});
    const results=await query<any>(`select validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes from validation_results where validation_run_id=$1 order by validation_case_id`,[run.rows[0].id]);
    const storedSummary=run.rows[0].summary;
    const summary=storedSummary&&typeof storedSummary==="object"&&!Array.isArray(storedSummary)&&"workflowFailure" in storedSummary
      ? {...storedSummary,workflowFailure:safePersistedFailureForDisplay(storedSummary.workflowFailure,"The validation workflow failed.")}
      : storedSummary;
    return Response.json({ok:true,validation:{...run.rows[0],summary,results:results.rows}});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return internalErrorResponse(error,"Validation evidence could not be loaded.");}
}
