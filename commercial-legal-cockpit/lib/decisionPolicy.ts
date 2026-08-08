export const DECISION_TYPES=new Set(["ACCEPT","NEGOTIATE","ESCALATE","REJECT","APPROVE_EXCEPTION"]);
export type DecisionRole="APPROVER"|"ADMIN";

export function requiredDecisionRole(input:{decisionType:string;approvalRequired?:string|null;requestedRole?:string|null}):DecisionRole{
  const requested=String(input.requestedRole||"APPROVER").toUpperCase();
  if(requested!=="APPROVER"&&requested!=="ADMIN")throw new Error("requiredApproverRole must be APPROVER or ADMIN.");
  const policyRequiresAdmin=input.decisionType==="APPROVE_EXCEPTION"||input.decisionType==="ACCEPT"||Boolean(input.approvalRequired?.trim());
  return policyRequiresAdmin||requested==="ADMIN"?"ADMIN":"APPROVER";
}
