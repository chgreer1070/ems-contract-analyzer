import { databaseConfigured, query } from "@/lib/db";

export type NegotiationPosition = {
  primaryPosition: string;
  fallback: string;
  noGo: string;
  approval: string;
  standardStatus: "APPROVED" | "MISSING" | "ILLUSTRATIVE";
  standardVersion: string | null;
};

type ClauseLike = { clauseFamily: string; issue: string };

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

  if (databaseConfigured() && families.length) {
    const result = await query<{
      clause_family:string; standard_position:string; fallback_position:string|null; no_go_position:string|null;
      approval_authority:string|null; version:string;
    }>(
      `select clause_family,standard_position,fallback_position,no_go_position,approval_authority,version
         from negotiation_standards
        where active=true and clause_family = any($1::text[])`,
      [families]
    );
    for (const row of result.rows) {
      approved.set(row.clause_family, {
        primaryPosition:row.standard_position,
        fallback:row.fallback_position || "No approved fallback recorded.",
        noGo:row.no_go_position || "No approved no-go threshold recorded.",
        approval:row.approval_authority || "Legal approval required.",
        standardStatus:"APPROVED",
        standardVersion:row.version
      });
    }
  }

  return findings.map((finding) => {
    const position = approved.get(finding.clauseFamily);
    if (position) return position;
    if (allowIllustrative && illustrative[finding.clauseFamily]) {
      return { ...illustrative[finding.clauseFamily], standardStatus:"ILLUSTRATIVE" as const, standardVersion:"DEMO-2026-08-07" };
    }
    return missing();
  });
}
