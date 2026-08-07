import { accessErrorResponse, getPrincipal } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";

export async function GET(request:Request){
  try{
    if(!databaseConfigured())return Response.json({ok:false,error:"Validation evidence requires DATABASE_URL."},{status:503});
    await getPrincipal(request);
    const run=await query<any>(`select id,run_label,model_name,prompt_version,corpus_version,status,total_cases,passed_cases,grounded_precision,family_recall,unsafe_policy_invention_count,exact_quote_failure_count,started_at,finished_at,summary from validation_runs order by started_at desc limit 1`);
    if(!run.rows[0])return Response.json({ok:true,validation:null});
    const results=await query<any>(`select validation_case_id,passed,detected_families,missing_families,prohibited_detected,grounded,notes from validation_results where validation_run_id=$1 order by validation_case_id`,[run.rows[0].id]);
    return Response.json({ok:true,validation:{...run.rows[0],results:results.rows}});
  }catch(error){const access=accessErrorResponse(error);if(access)return access;return Response.json({ok:false,error:error instanceof Error?error.message:"Unable to load validation evidence."},{status:500});}
}
