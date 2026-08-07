import { databaseConfigured, query } from "@/lib/db";
import type { Principal } from "@/lib/access";

export type AuditAction =
  | "MATTER_CREATED"
  | "MATTER_UPDATED"
  | "DOCUMENT_UPLOADED"
  | "DOCUMENT_EXTRACTED"
  | "ANALYSIS_RUN"
  | "FINDING_REVIEWED"
  | "DECISION_RECORDED"
  | "ECONOMICS_RUN"
  | "STANDARD_CREATED"
  | "STANDARD_ACTIVATED"
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
    [
      input.principal.userId,
      input.principal.name,
      input.action,
      input.matterId ?? null,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}
