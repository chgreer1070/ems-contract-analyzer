import { accessErrorResponse, getPrincipal, requireMatterAccess } from "@/lib/access";
import { databaseConfigured, withTransaction } from "@/lib/db";
import { calculateEconomics, ECONOMICS_FORMULA_VERSION, type EconomicsInput } from "@/lib/economics";
import { enforceRateLimit, rateLimitResponse } from "@/lib/rateLimit";
import { internalErrorResponse } from "@/lib/safeErrors";

type RequestBody=EconomicsInput&{
  matterId?:string;
  agreementVersionId?:string;
  persist?:boolean;
};

const MAX_AMOUNT=1_000_000_000_000_000;
const MAX_DAYS=3_650;
const UUID_PATTERN=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

class EconomicsStateError extends Error{
  constructor(message:string,public status=409){super(message);}
}

export async function POST(request:Request){
  try{
    const body=(await request.json()) as RequestBody;
    if(body.persist===true&&(!body.matterId||!body.agreementVersionId)){
      return Response.json({ok:false,error:"matterId and agreementVersionId are required when saving an economics run."},{status:400});
    }
    if(body.agreementVersionId&&!UUID_PATTERN.test(body.agreementVersionId)){
      return Response.json({ok:false,error:"agreementVersionId must be a valid UUID."},{status:400});
    }
    const principal=body.matterId
      ?await requireMatterAccess(request,body.matterId,body.persist===true)
      :await getPrincipal(request);

    const input:EconomicsInput={
      annualRevenue:body.annualRevenue,
      grossMarginPct:body.grossMarginPct,
      paymentDays:body.paymentDays,
      baselinePaymentDays:body.baselinePaymentDays,
      carryingCostPct:body.carryingCostPct,
      inventoryOnHand:body.inventoryOnHand,
      ncnrExposure:body.ncnrExposure,
      forecastReductionPct:body.forecastReductionPct,
      warrantyRatePct:body.warrantyRatePct,
      terminationCoveragePct:body.terminationCoveragePct,
      liabilityCap:body.liabilityCap,
      modeledClaim:body.modeledClaim
    };
    const values=Object.entries(input);
    if(values.some(([,value])=>typeof value!=="number"||!Number.isFinite(value))){
      return Response.json({ok:false,error:"Every economics input must be a finite number."},{status:400});
    }
    if(values.some(([,value])=>value<0))return Response.json({ok:false,error:"Economics inputs cannot be negative."},{status:400});
    for(const field of ["grossMarginPct","carryingCostPct","forecastReductionPct","warrantyRatePct","terminationCoveragePct"] as const){
      if(input[field]>100)return Response.json({ok:false,error:`${field} cannot exceed 100%.`},{status:400});
    }
    for(const field of ["annualRevenue","inventoryOnHand","ncnrExposure","liabilityCap","modeledClaim"] as const){
      if(input[field]>MAX_AMOUNT)return Response.json({ok:false,error:`${field} exceeds the supported modeling range.`},{status:400});
    }
    for(const field of ["paymentDays","baselinePaymentDays"] as const){
      if(input[field]>MAX_DAYS)return Response.json({ok:false,error:`${field} cannot exceed ${MAX_DAYS} days.`},{status:400});
    }
    const result=calculateEconomics(input);
    if(Object.values(result).some(value=>!Number.isFinite(value))){
      return Response.json({ok:false,error:"The economics result exceeds the supported modeling range."},{status:422});
    }

    let runId:string|null=null;
    let reviewStatus:string|null=null;
    if(body.persist===true&&body.matterId&&body.agreementVersionId&&!principal.demo&&databaseConfigured()){
      await enforceRateLimit(principal,"economics-save",120,3600);
      const persisted=await withTransaction(async client=>{
        const version=(await client.query<{status:string}>(
          "select status from agreement_versions where id=$1 and matter_id=$2 for share",
          [body.agreementVersionId,body.matterId]
        )).rows[0];
        if(!version||!new Set(["WORKING","APPROVED"]).has(version.status)){
          throw new EconomicsStateError("Economics runs must be bound to an available WORKING or APPROVED agreement version.");
        }
        const inserted=(await client.query<{id:string;review_status:string}>(`
          insert into economics_runs(
            matter_id,agreement_version_id,inputs,outputs,formula_version,created_by
          ) values($1,$2,$3::jsonb,$4::jsonb,$5,$6)
          returning id,review_status`,
          [body.matterId,body.agreementVersionId,JSON.stringify(input),JSON.stringify(result),ECONOMICS_FORMULA_VERSION,principal.userId]
        )).rows[0];
        await client.query(`
          insert into audit_events(
            actor_user_id,actor_name,action,matter_id,entity_type,entity_id,metadata
          ) values($1,$2,'ECONOMICS_RUN',$3,'economics_run',$4,$5::jsonb)`,
          [principal.userId,principal.name,body.matterId,inserted.id,JSON.stringify({
            agreementVersionId:body.agreementVersionId,
            formulaVersion:ECONOMICS_FORMULA_VERSION,
            reviewStatus:inserted.review_status
          })]
        );
        return inserted;
      });
      runId=persisted.id;
      reviewStatus=persisted.review_status;
    }

    return Response.json({
      ok:true,result,runId,persisted:runId!==null,
      agreementVersionId:runId?body.agreementVersionId:null,
      reviewStatus,formulaVersion:ECONOMICS_FORMULA_VERSION
    });
  }catch(error){
    const rate=rateLimitResponse(error);if(rate)return rate;
    const access=accessErrorResponse(error);if(access)return access;
    if(error instanceof EconomicsStateError)return Response.json({ok:false,error:error.message},{status:error.status});
    return internalErrorResponse(error,"Contract economics could not be calculated.");
  }
}
