import type { ClientSession } from "mongoose";
import { AuditLogModel } from "@sigma/db-sync";

interface AuditInput {
  tenantId: string;
  actorId: string;
  action: string;
  resource: string;
  resourceId: string;
  valuesBefore: unknown;
  valuesAfter: unknown;
  session: ClientSession;
}

export async function writeAuditEntry(input: AuditInput): Promise<void> {
  await AuditLogModel.create(
    [
      {
        tenant_id: input.tenantId,
        actor_id: input.actorId,
        action: input.action,
        resource: input.resource,
        resource_id: input.resourceId,
        values_before: input.valuesBefore,
        values_after: input.valuesAfter,
        occurred_at: new Date()
      }
    ],
    { session: input.session }
  );
}
