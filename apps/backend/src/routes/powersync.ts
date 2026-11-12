import mongoose from "mongoose";
import { Router } from "express";
import jwt from "jsonwebtoken";
import {
  AnomalyModel,
  MutationReceiptModel,
  WorkOrderModel
} from "@sigma/db-sync";
import { hasPermission } from "@sigma/shared";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { validateBody } from "../middleware/validate.js";
import { writeAuditEntry } from "../services/audit.js";
import { assertWorkOrderReferences } from "../services/references.js";
import { CreateAnomalySchema } from "./anomalies.js";
import {
  CreateWorkOrderSchema,
  UpdateWorkOrderSchema
} from "./work-orders.js";

const MutationSchema = z.object({
  client_mutation_id: z.string().trim().min(1).max(160),
  op: z.enum(["PUT", "PATCH", "DELETE"]),
  table: z.enum(["anomalias", "ordenes_trabajo"]),
  id: z.string().trim().min(1),
  data: z.record(z.string(), z.unknown()).default({})
});

const CrudBatchSchema = z.object({
  mutations: z.array(MutationSchema).min(1).max(100)
});

type Mutation = z.infer<typeof MutationSchema>;

function pickFields(
  data: Record<string, unknown>,
  fields: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((field) => field in data).map((field) => [field, data[field]])
  );
}

async function applyMutation(
  mutation: Mutation,
  tenantId: string,
  userId: string,
  role: NonNullable<Express.Request["user"]>["role"],
  session: mongoose.ClientSession
): Promise<{ client_mutation_id: string; replayed: boolean }> {
  const receipt = await MutationReceiptModel.findOne({
    tenant_id: tenantId,
    client_mutation_id: mutation.client_mutation_id
  })
    .session(session)
    .exec();
  if (receipt) {
    return { client_mutation_id: mutation.client_mutation_id, replayed: true };
  }

  if (mutation.op === "DELETE") {
    throw new HttpError(400, "Las eliminaciones sincronizadas no están permitidas");
  }

  let resourceId = mutation.id;
  let replayed = false;
  if (mutation.table === "anomalias") {
    if (mutation.op !== "PUT" || !hasPermission(role, "anomalies", "create")) {
      throw new HttpError(403, "No tiene permisos para sincronizar esta anomalía");
    }
    const data = CreateAnomalySchema.parse({
      ...pickFields(mutation.data, [
        "asset_id",
        "description",
        "severity",
        "photo_url",
        "photo_hash"
      ]),
      client_mutation_id: mutation.client_mutation_id
    });
    const existingAnomaly = await AnomalyModel.findOne({
      tenant_id: tenantId,
      client_mutation_id: mutation.client_mutation_id
    })
      .session(session)
      .exec();
    if (existingAnomaly) {
      resourceId = existingAnomaly._id.toString();
      replayed = true;
    } else {
      const [anomaly] = await AnomalyModel.create(
        [
          {
            ...data,
            _id: mutation.id,
            tenant_id: tenantId,
            reported_by: userId,
            status: "PENDIENTE",
            sync_status: "SYNCED"
          }
        ],
        { session }
      );
      resourceId = anomaly._id.toString();
    }
  } else {
    if (!hasPermission(role, "workOrders", mutation.op === "PUT" ? "create" : "update")) {
      throw new HttpError(403, "No tiene permisos para sincronizar esta orden");
    }
    if (role !== "SUPERVISOR") {
      throw new HttpError(403, "Solo Supervisor puede gestionar órdenes de trabajo");
    }
    if (mutation.op === "PUT") {
      const data = CreateWorkOrderSchema.parse(
        pickFields(mutation.data, [
          "anomaly_id",
          "asset_id",
          "title",
          "description",
          "priority",
          "assigned_to"
        ])
      );
      await assertWorkOrderReferences(
        {
          assetId: data.asset_id,
          anomalyId: data.anomaly_id,
          assignedTo: data.assigned_to
        },
        tenantId
      );
      const [workOrder] = await WorkOrderModel.create(
        [
          {
            ...data,
            _id: mutation.id,
            tenant_id: tenantId,
            created_by: userId,
            status: data.assigned_to ? "ASIGNADA" : "PENDIENTE"
          }
        ],
        { session }
      );
      resourceId = workOrder._id.toString();
      await writeAuditEntry({
        tenantId,
        actorId: userId,
        action: "CREATE",
        resource: "ordenes_trabajo",
        resourceId,
        valuesBefore: null,
        valuesAfter: workOrder.toObject(),
        session
      });
    } else {
      const patch = UpdateWorkOrderSchema.parse(
        pickFields(mutation.data, [
          "title",
          "description",
          "priority",
          "status",
          "assigned_to"
        ])
      );
      const workOrder = await WorkOrderModel.findOne({
        _id: mutation.id,
        tenant_id: tenantId
      })
        .session(session)
        .exec();
      if (!workOrder) throw new HttpError(404, "Orden de trabajo no encontrada");
      if (patch.assigned_to !== undefined) {
        await assertWorkOrderReferences(
          {
            assetId: workOrder.asset_id,
            anomalyId: workOrder.anomaly_id ?? undefined,
            assignedTo: patch.assigned_to
          },
          tenantId
        );
      }
      const valuesBefore = workOrder.toObject();
      for (const [field, value] of Object.entries(patch)) {
        workOrder.set(field, value === null ? undefined : value);
      }
      if (patch.assigned_to !== undefined) {
        workOrder.status = patch.assigned_to ? "ASIGNADA" : "PENDIENTE";
      }
      await workOrder.save({ session });
      resourceId = workOrder._id.toString();
      await writeAuditEntry({
        tenantId,
        actorId: userId,
        action: "UPDATE",
        resource: "ordenes_trabajo",
        resourceId,
        valuesBefore,
        valuesAfter: workOrder.toObject(),
        session
      });
    }
  }

  await MutationReceiptModel.create(
    [
      {
        tenant_id: tenantId,
        client_mutation_id: mutation.client_mutation_id,
        table: mutation.table,
        record_id: resourceId,
        result: { applied: true }
      }
    ],
    { session }
  );
  return { client_mutation_id: mutation.client_mutation_id, replayed };
}

export const powerSyncRouter: ReturnType<typeof Router> = Router();
powerSyncRouter.use(requireAuth);

powerSyncRouter.get("/token", (req, res, next) => {
  const { user, tenantId } = req;
  if (!user || !tenantId) {
    next(new HttpError(401, "Se requiere autenticación"));
    return;
  }
  if (!env.POWERSYNC_PRIVATE_KEY || !env.POWERSYNC_URL) {
    next(new HttpError(503, "PowerSync no está configurado"));
    return;
  }
  const token = jwt.sign(
    {
      sub: user.userId,
      user_id: user.userId,
      tenant_id: tenantId,
      role: user.role
    },
    env.POWERSYNC_PRIVATE_KEY,
    { algorithm: "HS256", expiresIn: "5m" }
  );
  res.json({ token, endpoint: env.POWERSYNC_URL, expiresIn: 300 });
});

powerSyncRouter.post(
  "/crud",
  validateBody(CrudBatchSchema),
  async (req, res) => {
    const { user, tenantId } = req;
    if (!user || !tenantId) throw new HttpError(401, "Se requiere autenticación");
    const { mutations } = req.body as z.infer<typeof CrudBatchSchema>;
    const session = await mongoose.startSession();
    const results: Array<{
      client_mutation_id: string;
      replayed: boolean;
    }> = [];
    try {
      await session.withTransaction(async () => {
        results.length = 0;
        for (const mutation of mutations) {
          results.push(
            await applyMutation(
              mutation,
              tenantId,
              user.userId,
              user.role,
              session
            )
          );
        }
      });
    } finally {
      await session.endSession();
    }
    res.json({ applied: results.length, results });
  }
);
