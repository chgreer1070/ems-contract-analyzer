import { accessErrorResponse, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import { internalErrorResponse } from "@/lib/safeErrors";

export async function GET(request:Request, context:{ params:Promise<{ id:string }> }) {
  try {
    if (!databaseConfigured()) return Response.json({ ok:true, mode:"demo", findings:[] });
    const { id } = await context.params;
    const principal = await requireMatterAccess(request, id, false);
    if (principal.demo) return Response.json({ ok:true, mode:"demo", findings:[] });

    const result = await query(
      `select f.id,f.document_id,f.analysis_run_id,d.filename,f.clause_family,f.issue,f.risk_level,f.rationale,f.operational_consequence,
              f.source_excerpt,f.source_locator,f.primary_position,f.fallback_position,f.no_go_position,f.approval_required,
              f.financial_variables,f.uncertainty,f.review_status,f.model_name,f.prompt_version,f.standard_status,f.standard_version,
              f.created_at,f.reviewed_by,f.reviewed_at,f.review_note,
              f.analysis_run_id is not null and f.analysis_run_id=(
                select ar.id from analysis_runs ar
                 where ar.matter_id=f.matter_id and ar.document_id=f.document_id
                   and ar.run_type='CLAUSE_RISK' and ar.status='SUCCEEDED'
                 order by ar.started_at desc,ar.id desc limit 1
              ) is_current
         from findings f
         left join documents d on d.id=f.document_id
        where f.matter_id=$1
        order by case f.risk_level when 'Critical' then 4 when 'High' then 3 when 'Medium' then 2 else 1 end desc, f.created_at desc`,
      [id]
    );
    return Response.json({ ok:true, mode:"database", findings:result.rows });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return internalErrorResponse(error,"Matter findings could not be loaded.");
  }
}
