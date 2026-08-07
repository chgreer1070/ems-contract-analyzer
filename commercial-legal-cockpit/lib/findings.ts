import type { Principal } from "@/lib/access";
import { databaseConfigured, query } from "@/lib/db";
import type { CoreFinding } from "@/lib/analysisEngine";
import { loadNegotiationPositions, type NegotiationPosition } from "@/lib/standards";

export type EnrichedFinding = CoreFinding & NegotiationPosition & { sourceLocator?: string | null; standardVersion: string | null };

export async function enrichFindings(findings: CoreFinding[], allowIllustrative: boolean): Promise<EnrichedFinding[]> {
  const positions = await loadNegotiationPositions(findings, allowIllustrative);
  return findings.map((finding,index)=>({...finding,...positions[index]}));
}

export async function persistFindings(input:{principal:Principal;matterId?:string;documentId?:string;findings:EnrichedFinding[];modelName:string;promptVersion:string}){
  if(!input.matterId||input.principal.demo||!databaseConfigured())return [] as string[];
  if(input.documentId){const doc=await query<{id:string}>("select id from documents where id=$1 and matter_id=$2",[input.documentId,input.matterId]);if(!doc.rows[0])throw new Error("Document does not belong to the selected matter.");}
  const ids:string[]=[];
  for(const finding of input.findings){
    const existing=await query<{id:string;review_status:string}>(`select id,review_status from findings where matter_id=$1 and document_id is not distinct from $2 and clause_family=$3 and source_excerpt=$4 and issue=$5 and review_status<>'SUPERSEDED' order by created_at desc limit 1`,[input.matterId,input.documentId??null,finding.clauseFamily,finding.sourceExcerpt,finding.issue]);
    if(existing.rows[0]){
      if(existing.rows[0].review_status==="UNREVIEWED"){
        await query(`update findings set risk_level=$2,rationale=$3,operational_consequence=$4,source_locator=$5,primary_position=$6,fallback_position=$7,no_go_position=$8,approval_required=$9,financial_variables=$10::jsonb,uncertainty=$11,model_name=$12,prompt_version=$13,standard_status=$14,standard_version=$15 where id=$1`,[existing.rows[0].id,finding.risk,finding.rationale,finding.operationalConsequence,finding.sourceLocator??null,finding.primaryPosition,finding.fallback,finding.noGo,finding.approval,JSON.stringify(finding.financialVariables),finding.uncertainty,input.modelName,input.promptVersion,finding.standardStatus,finding.standardVersion]);
      }
      ids.push(existing.rows[0].id);continue;
    }
    const result=await query<{id:string}>(`insert into findings(matter_id,document_id,clause_family,issue,risk_level,rationale,operational_consequence,source_excerpt,source_locator,primary_position,fallback_position,no_go_position,approval_required,financial_variables,uncertainty,review_status,model_name,prompt_version,standard_status,standard_version,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,'UNREVIEWED',$16,$17,$18,$19,$20) returning id`,[input.matterId,input.documentId??null,finding.clauseFamily,finding.issue,finding.risk,finding.rationale,finding.operationalConsequence,finding.sourceExcerpt,finding.sourceLocator??null,finding.primaryPosition,finding.fallback,finding.noGo,finding.approval,JSON.stringify(finding.financialVariables),finding.uncertainty,input.modelName,input.promptVersion,finding.standardStatus,finding.standardVersion,input.principal.userId]);
    ids.push(result.rows[0].id);
  }
  return ids;
}
