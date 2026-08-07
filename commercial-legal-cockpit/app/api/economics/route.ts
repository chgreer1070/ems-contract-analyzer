import { accessErrorResponse, getPrincipal, requireMatterAccess } from "@/lib/access";
import { writeAuditEvent } from "@/lib/audit";
import { databaseConfigured, query } from "@/lib/db";
import { calculateEconomics, type EconomicsInput } from "@/lib/economics";

const FORMULA_VERSION = "ems-economics-2026-08-07.v1";

type RequestBody = EconomicsInput & { matterId?: string };

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    const principal = body.matterId
      ? await requireMatterAccess(request, body.matterId, false)
      : await getPrincipal(request);

    const input: EconomicsInput = {
      annualRevenue: body.annualRevenue,
      grossMarginPct: body.grossMarginPct,
      paymentDays: body.paymentDays,
      baselinePaymentDays: body.baselinePaymentDays,
      carryingCostPct: body.carryingCostPct,
      inventoryOnHand: body.inventoryOnHand,
      ncnrExposure: body.ncnrExposure,
      forecastReductionPct: body.forecastReductionPct,
      warrantyRatePct: body.warrantyRatePct,
      terminationCoveragePct: body.terminationCoveragePct,
      liabilityCap: body.liabilityCap,
      modeledClaim: body.modeledClaim
    };
    const result = calculateEconomics(input);

    let runId: string | null = null;
    if (body.matterId && !principal.demo && databaseConfigured()) {
      const inserted = await query<{ id: string }>(
        `insert into economics_runs(matter_id,inputs,outputs,formula_version,created_by)
         values ($1,$2::jsonb,$3::jsonb,$4,$5)
         returning id`,
        [body.matterId, JSON.stringify(input), JSON.stringify(result), FORMULA_VERSION, principal.userId]
      );
      runId = inserted.rows[0]?.id ?? null;
      await writeAuditEvent({
        principal,
        action: "ECONOMICS_RUN",
        matterId: body.matterId,
        entityType: "economics_run",
        entityId: runId,
        metadata: { formulaVersion: FORMULA_VERSION, totalModeledBurden: result.totalModeledBurden }
      });
    }

    return Response.json({ ok: true, result, runId, formulaVersion: FORMULA_VERSION });
  } catch (error) {
    const access = accessErrorResponse(error);
    if (access) return access;
    return Response.json({ ok: false, error: "Invalid economics input." }, { status: 400 });
  }
}
