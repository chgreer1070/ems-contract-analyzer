import { databaseConfigured, query } from "@/lib/db";
import type { Principal } from "@/lib/access";

export type AuditAction =
  | "MATTER_CREATED"
  | "MATTER_UPDATED"
  | "MATTER_MEMBER_CHANGED"
  | "GOVERNANCE_CHANGED"
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_EXTRACTED"
  | "DOCUMENT_OCR"
  | "DOCUMENT_OCR_REQUIRED"
  | "DOCUMENT_INTEGRITY_FAILED"
  | "PURGE_REQUESTED"
  | "PURGE_APPROVED"
  | "PURGE_REJECTED"
  | "DOCUMENT_PURGED"
  | "ANALYSIS_RUN"
  | "FINDING_REVIEWED"
  | "GRAPH_REVIEWED"
  | "DOCUMENT_RELATION_RECORDED"
  | "AGREEMENT_VERSION_CREATED"
  | "AGREEMENT_VERSION_STATUS_CHANGED"
  | "DECISION_RECORDED"
  | "ECONOMICS_RUN"
  | "EXECUTIVE_SNAPSHOT_CREATED"
  | "STANDARD_CREATED"
  | "STANDARD_ACTIVATED"
  | "VALIDATION_RUN"
  | "ROLE_CHANGED";

export async function writeAuditEvent(input: {
  principal: Principal;
  action: AuditAction;
  matterId?: string | null;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (input.principal.demo || !databaseConfigured()) return;
  await query(
    `insert into audit_events
      (actor_user_id, actor_name, action, matter_id, entity_type, entity_id, metadata)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [input.principal.userId,input.principal.name,input.action,input.matterId ?? null,input.entityType,input.entityId ?? null,JSON.stringify(input.metadata ?? {})]
  );
}
