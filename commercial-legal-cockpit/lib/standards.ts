import { databaseConfigured, query } from "@/lib/db";

export const REQUIRED_STANDARD_FAMILIES = [
  "forecasting_demand","purchase_orders","pricing_repricing","raw_materials","long_lead_ncnr","consigned_inventory",
  "title_risk_of_loss","safety_stock","excess_obsolete_inventory","engineering_changes","quality_acceptance_audits",
  "delivery_incoterms_logistics","payment_terms","warranty","indemnity","liability_cap","termination","force_majeure",
  "regulatory_change","sustainability"
] as const;

export type GovernedStandard = {
  clause_family:string|null;
  title:string|null;
  standard_position:string|null;
  fallback_position:string|null;
  no_go_position:string|null;
  approval_authority:string|null;
  business_rationale:string|null;
  provenance_source:string|null;
  approval_role:string|null;
  version:string|null;
  effective_date:string|Date|null;
  created_by:string|null;
};

export type NegotiationPosition = {
  primaryPosition: string;
  fallback: string;
  noGo: string;
  approval: string;
  standardStatus: "APPROVED" | "MISSING" | "ILLUSTRATIVE";
  standardVersion: string | null;
};

type ClauseLike = { clauseFamily: string; issue: string };

const REQUIRED_STANDARD_FAMILY_SET = new Set<string>(REQUIRED_STANDARD_FAMILIES);
const NON_GOVERNING_MARKER = /(?:^|[-_.\s])(?:demo|illustrative|sample|synthetic|seed)(?:[-_.\s]|$)/i;
const NON_GOVERNING_CREATOR = /^(?:demo|illustrative|sample|synthetic|seed)(?:[-_.\s]|$)/i;
const APPROVAL_ROLES = new Set(["APPROVER","ADMIN"]);

function valuePresent(value:unknown){return typeof value==="string"&&value.trim().length>0;}

function effectiveDateIsCurrent(value:string|Date|null){
  if(!value)return false;
  let year:number;let month:number;let day:number;
  if(value instanceof Date){
    if(Number.isNaN(value.getTime()))return false;
    year=value.getUTCFullYear();month=value.getUTCMonth()+1;day=value.getUTCDate();
  }else{
    const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if(!match)return false;
    year=Number(match[1]);month=Number(match[2]);day=Number(match[3]);
  }
  const effectiveUtc=Date.UTC(year,month-1,day);
  const normalized=new Date(effectiveUtc);
  if(normalized.getUTCFullYear()!==year||normalized.getUTCMonth()!==month-1||normalized.getUTCDate()!==day)return false;
  const today=new Date();
  const todayUtc=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());
  return effectiveUtc<=todayUtc;
}

export function standardGovernanceIssues(standard:GovernedStandard){
  const issues:string[]=[];
  const required:[keyof GovernedStandard,string][]=[
    ["clause_family","clause family"],["title","title"],["standard_position","primary position"],
    ["fallback_position","fallback position"],["no_go_position","no-go position"],
    ["approval_authority","approval authority"],["business_rationale","business rationale"],
    ["provenance_source","provenance source"],["approval_role","approval role"],
    ["version","version"],["created_by","created-by provenance"]
  ];
  for(const [field,label] of required)if(!valuePresent(standard[field]))issues.push(`${label} is required`);
  if(valuePresent(standard.clause_family)&&!REQUIRED_STANDARD_FAMILY_SET.has(String(standard.clause_family).trim()))issues.push("clause family is not governed by the legal-reliance registry");
  if(!effectiveDateIsCurrent(standard.effective_date))issues.push("effective date is required, valid, and cannot be in the future");
  if(valuePresent(standard.version)&&NON_GOVERNING_MARKER.test(String(standard.version).trim()))issues.push("demo, illustrative, sample, synthetic, or seeded versions cannot be approved");
  if(valuePresent(standard.created_by)&&NON_GOVERNING_CREATOR.test(String(standard.created_by).trim()))issues.push("demo, illustrative, sample, synthetic, or seeded creators cannot approve standards");
  if(valuePresent(standard.provenance_source)&&NON_GOVERNING_MARKER.test(String(standard.provenance_source).trim()))issues.push("demo, illustrative, sample, synthetic, or seeded provenance cannot be approved");
  if(valuePresent(standard.approval_role)&&!APPROVAL_ROLES.has(String(standard.approval_role).trim().toUpperCase()))issues.push("approval role must be APPROVER or ADMIN");
  return issues;
}

export function standardIsRelianceEligible(standard:GovernedStandard){return standardGovernanceIssues(standard).length===0;}

const illustrative: Record<string, Omit<NegotiationPosition, "standardStatus"|"standardVersion">> = {
  payment_terms: {
    primaryPosition:"Net 45 or better.",
    fallback:"Net 60 with explicit economic recovery.",
    noGo:"Terms beyond the approved threshold without Finance approval.",
    approval:"Finance + BU leadership"
  },
  excess_obsolete_inventory: {
    primaryPosition:"Customer purchases inventory and NCNR commitments authorized by forecasts, POs, changes, or termination.",
    fallback:"Defined recovery schedule plus carrying charges.",
    noGo:"Open-ended manufacturer exposure to customer-driven E&O without a recovery mechanism.",
    approval:"Operations + Finance + Legal"
  },
  long_lead_ncnr: {
    primaryPosition:"Customer responsibility for customer-authorized long-lead and NCNR commitments.",
    fallback:"Defined authorization thresholds and scheduled recovery.",
    noGo:"Manufacturer-funded NCNR exposure outside approved demand signals.",
    approval:"Operations + Finance + Legal"
  },
  liability_cap: {
    primaryPosition:"Aggregate liability cap proportionate to contract economics with narrow defined carve-outs.",
    fallback:"Negotiated super-cap for specifically identified risks.",
    noGo:"General uncapped liability or consequential loss exposure without executive approval.",
    approval:"GC + CFO"
  },
  warranty: {
    primaryPosition:"Defined manufacturing-defect warranty with clear duration, exclusions, remedy and claim process.",
    fallback:"Extended duration only with pricing and reserve support.",
    noGo:"Broad design/performance warranty outside manufacturing responsibility without approval.",
    approval:"Quality + Finance + Legal"
  },
  termination: {
    primaryPosition:"Customer pays committed materials, NCNR, WIP, finished goods, cancellation charges and agreed wind-down costs.",
    fallback:"Longer notice plus scheduled inventory recovery.",
    noGo:"Convenience termination that leaves customer-authorized commitments stranded.",
    approval:"BU + Finance + Legal"
  },
  pricing_repricing: {
    primaryPosition:"Defined pass-through or repricing mechanics for agreed external cost drivers and scope changes.",
    fallback:"Periodic review with objective indices and documented evidence.",
    noGo:"Fixed pricing against uncontrolled external cost changes without approval.",
    approval:"Finance + Commercial + Legal"
  }
};

function missing(): NegotiationPosition {
  return {
    primaryPosition:"No approved negotiation standard is loaded for this clause family.",
    fallback:"No approved fallback is loaded.",
    noGo:"No approved no-go threshold is loaded.",
    approval:"Escalate to Legal before relying on a negotiation position.",
    standardStatus:"MISSING",
    standardVersion:null
  };
}

export async function loadNegotiationPositions(findings: ClauseLike[], allowIllustrative: boolean) {
  const families = [...new Set(findings.map((finding) => finding.clauseFamily).filter(Boolean))];
  const approved = new Map<string, NegotiationPosition>();

  // Demo analysis must be local-only: never query or reveal the approved company registry.
  if(allowIllustrative){
    return findings.map((finding) => illustrative[finding.clauseFamily]
      ? { ...illustrative[finding.clauseFamily], standardStatus:"ILLUSTRATIVE" as const, standardVersion:"DEMO-2026-08-07" }
      : missing());
  }

  if (databaseConfigured() && families.length) {
    const result = await query<GovernedStandard>(
      `select clause_family,title,standard_position,fallback_position,no_go_position,approval_authority,business_rationale,provenance_source,approval_role,version,effective_date,created_by
         from negotiation_standards
        where active=true and clause_family = any($1::text[])`,
      [families]
    );
    for (const row of result.rows) {
      if(!standardIsRelianceEligible(row))continue;
      approved.set(row.clause_family!, {
        primaryPosition:row.standard_position!,
        fallback:row.fallback_position!,
        noGo:row.no_go_position!,
        approval:row.approval_authority!,
        standardStatus:"APPROVED",
        standardVersion:row.version!
      });
    }
  }

  return findings.map((finding) => {
    const position = approved.get(finding.clauseFamily);
    if (position) return position;
    return missing();
  });
}
