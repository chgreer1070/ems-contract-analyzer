export type EconomicsInput = {
  annualRevenue: number;
  grossMarginPct: number;
  paymentDays: number;
  baselinePaymentDays: number;
  carryingCostPct: number;
  inventoryOnHand: number;
  ncnrExposure: number;
  forecastReductionPct: number;
  warrantyRatePct: number;
  terminationCoveragePct: number;
  liabilityCap: number;
  modeledClaim: number;
};

export type EconomicsOutput = {
  incrementalReceivable: number;
  workingCapitalCost: number;
  strandedInventoryExposure: number;
  warrantyReserve: number;
  terminationExposure: number;
  liabilityCapGap: number;
  grossProfit: number;
  totalModeledBurden: number;
  burdenAsPctOfGrossProfit: number;
};

const finite = (value: number) => Number.isFinite(value) ? value : 0;
const nonNegative = (value: number) => Math.max(0, finite(value));
const pct = (value: number) => Math.min(100, Math.max(0, finite(value))) / 100;

export function calculateEconomics(raw: EconomicsInput): EconomicsOutput {
  const annualRevenue = nonNegative(raw.annualRevenue);
  const grossMargin = pct(raw.grossMarginPct);
  const paymentDays = nonNegative(raw.paymentDays);
  const baselinePaymentDays = nonNegative(raw.baselinePaymentDays);
  const carryingCost = pct(raw.carryingCostPct);
  const inventory = nonNegative(raw.inventoryOnHand);
  const ncnr = nonNegative(raw.ncnrExposure);
  const forecastReduction = pct(raw.forecastReductionPct);
  const warrantyRate = pct(raw.warrantyRatePct);
  const terminationCoverage = pct(raw.terminationCoveragePct);
  const liabilityCap = nonNegative(raw.liabilityCap);
  const modeledClaim = nonNegative(raw.modeledClaim);

  const incrementalDays = Math.max(0, paymentDays - baselinePaymentDays);
  const incrementalReceivable = annualRevenue * (incrementalDays / 365);
  const workingCapitalCost = incrementalReceivable * carryingCost;
  const strandedInventoryExposure = (inventory + ncnr) * forecastReduction;
  const warrantyReserve = annualRevenue * warrantyRate;
  const terminationExposure = strandedInventoryExposure * (1 - terminationCoverage);
  const liabilityCapGap = Math.max(0, modeledClaim - liabilityCap);
  const grossProfit = annualRevenue * grossMargin;
  const totalModeledBurden = workingCapitalCost + warrantyReserve + terminationExposure + liabilityCapGap;
  const burdenAsPctOfGrossProfit = grossProfit > 0 ? (totalModeledBurden / grossProfit) * 100 : 0;

  return { incrementalReceivable, workingCapitalCost, strandedInventoryExposure, warrantyReserve, terminationExposure, liabilityCapGap, grossProfit, totalModeledBurden, burdenAsPctOfGrossProfit };
}
