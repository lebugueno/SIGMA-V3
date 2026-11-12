import { Router } from "express";
import { AnomalyModel } from "@sigma/db-sync";
import { AnomalySchema } from "@sigma/shared";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { validateBody } from "../middleware/validate.js";
import { assertAssetBelongsToTenant } from "../services/references.js";

export const CreateAnomalySchema = AnomalySchema.omit({
  id: true,
  tenant_id: true,
  reported_by: true,
  status: true,
  created_at: true,
  sync_status: true
})
  .extend({ client_mutation_id: z.string().trim().min(1).max(160) })
  .strict();

const AnomalyQuerySchema = z.object({
  status: z.enum(["PENDIENTE", "EN_PROCESO", "RESUELTA"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

function serializeAnomaly(anomaly: {
  _id: { toString(): string };
  tenant_id: string;
  asset_id: string;
  reported_by: string;
  description: string;
  severity: string;
  photo_url?: string | null;
  photo_hash?: string | null;
  status: string;
  created_at?: Date;
  sync_status?: string;
}) {
  if (!anomaly.created_at) {
    throw new Error("La anomalía no contiene fecha de creación");
  }
  return {
    id: anomaly._id.toString(),
    tenant_id: anomaly.tenant_id,
    asset_id: anomaly.asset_id,
    reported_by: anomaly.reported_by,
    description: anomaly.description,
    severity: anomaly.severity,
    ...(anomaly.photo_url ? { photo_url: anomaly.photo_url } : {}),
    ...(anomaly.photo_hash ? { photo_hash: anomaly.photo_hash } : {}),
    status: anomaly.status,
    created_at: anomaly.created_at,
    sync_status: anomaly.sync_status ?? "SYNCED"
  };
}

export const anomaliesRouter: ReturnType<typeof Router> = Router();
anomaliesRouter.use(requireAuth);

anomaliesRouter.post(
  "/",
  requirePermission("anomalies", "create"),
  validateBody(CreateAnomalySchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof CreateAnomalySchema>;
    const { user, tenantId } = req;
    if (!user || !tenantId) throw new HttpError(401, "Se requiere autenticación");

    const existing = await AnomalyModel.findOne({
      tenant_id: tenantId,
      client_mutation_id: body.client_mutation_id
    }).exec();
    if (existing) {
      res.status(200).json({ anomaly: serializeAnomaly(existing), replayed: true });
      return;
    }
    await assertAssetBelongsToTenant(body.asset_id, tenantId);

    try {
      const anomaly = await AnomalyModel.create({
        ...body,
        tenant_id: tenantId,
        reported_by: user.userId,
        status: "PENDIENTE",
        sync_status: "SYNCED"
      });
      res.status(201).json({
        anomaly: serializeAnomaly(anomaly),
        replayed: false
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const replay = await AnomalyModel.findOne({
        tenant_id: tenantId,
        client_mutation_id: body.client_mutation_id
      }).exec();
      if (!replay) throw error;
      res.status(200).json({ anomaly: serializeAnomaly(replay), replayed: true });
    }
  }
);

anomaliesRouter.get(
  "/",
  requirePermission("anomalies", "read"),
  async (req, res) => {
    const query = AnomalyQuerySchema.parse(req.query);
    const filter = {
      tenant_id: req.tenantId,
      ...(query.status ? { status: query.status } : {})
    };
    const anomalies = await AnomalyModel.find(filter)
      .sort({ created_at: -1 })
      .limit(query.limit)
      .exec();
    res.json({ anomalies: anomalies.map(serializeAnomaly) });
  }
);
