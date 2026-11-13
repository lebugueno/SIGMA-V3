import { Router } from "express";
import { AssetModel } from "@sigma/db-sync";
import { requireAuth, requirePermission } from "../middleware/auth.js";

export const assetsRouter: ReturnType<typeof Router> = Router();
assetsRouter.use(requireAuth);
assetsRouter.get("/", requirePermission("assets", "read"), async (req, res) => {
  const assets = await AssetModel.find({ tenant_id: req.tenantId })
    .sort({ asset_code: 1 })
    .limit(500)
    .exec();
  res.json({
    assets: assets.map((asset) => ({
      id: asset._id.toString(),
      tenant_id: asset.tenant_id,
      asset_code: asset.asset_code,
      qr_code: asset.qr_code,
      nombre: asset.nombre,
      ...(asset.marca ? { marca: asset.marca } : {}),
      ...(asset.modelo ? { modelo: asset.modelo } : {}),
      ...(asset.serial_number ? { serial_number: asset.serial_number } : {}),
      status: asset.status,
      created_at: asset.created_at
    }))
  });
});
