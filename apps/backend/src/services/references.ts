import { AnomalyModel, AssetModel, UserModel } from "@sigma/db-sync";
import { HttpError } from "../middleware/errors.js";

export async function assertAssetBelongsToTenant(
  assetId: string,
  tenantId: string
): Promise<void> {
  const assetExists = await AssetModel.exists({
    _id: assetId,
    tenant_id: tenantId
  });
  if (!assetExists) {
    throw new HttpError(404, "Activo no encontrado");
  }
}

export async function assertWorkOrderReferences(
  references: {
    assetId: string;
    anomalyId?: string;
    assignedTo?: string | null;
  },
  tenantId: string
): Promise<void> {
  await assertAssetBelongsToTenant(references.assetId, tenantId);
  if (references.anomalyId) {
    const anomalyExists = await AnomalyModel.exists({
      _id: references.anomalyId,
      tenant_id: tenantId
    });
    if (!anomalyExists) {
      throw new HttpError(404, "Anomalía no encontrada");
    }
  }
  if (references.assignedTo) {
    const userExists = await UserModel.exists({
      _id: references.assignedTo,
      tenant_id: tenantId,
      role: "TECNICO",
      active: true
    });
    if (!userExists) {
      throw new HttpError(404, "Técnico asignado no encontrado");
    }
  }
}
