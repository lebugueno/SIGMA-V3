import mongoose from "mongoose";
import { Router } from "express";
import { AuditLogModel, UserModel, WorkOrderModel } from "@sigma/db-sync";
import { WorkOrderSchema } from "@sigma/shared";
import { z } from "zod";
import { requireAuth, requirePermission, requireRole } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { validateBody } from "../middleware/validate.js";
import { writeAuditEntry } from "../services/audit.js";
import { assertWorkOrderReferences } from "../services/references.js";

export const CreateWorkOrderSchema = WorkOrderSchema.omit({
  id: true,
  tenant_id: true,
  status: true,
  created_by: true,
  created_at: true,
  updated_at: true
})
  .extend({
    title: WorkOrderSchema.shape.title.max(200),
    description: WorkOrderSchema.shape.description.max(4000),
    priority: WorkOrderSchema.shape.priority.default("MEDIA")
  })
  .strict();

export const UpdateWorkOrderSchema = WorkOrderSchema.pick({
  title: true,
  description: true,
  priority: true,
  status: true,
  assigned_to: true
})
  .partial()
  .extend({
    title: WorkOrderSchema.shape.title.max(200).optional(),
    description: WorkOrderSchema.shape.description.max(4000).optional(),
    assigned_to: z.string().trim().min(1).nullable().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Debe indicar al menos un campo para actualizar"
  });

function serializeWorkOrder(workOrder: {
  _id: { toString(): string };
  tenant_id: string;
  anomaly_id?: string | null;
  asset_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  assigned_to?: string | null;
  created_by: string;
  created_at?: Date;
  updated_at?: Date;
}) {
  if (!workOrder.created_at || !workOrder.updated_at) {
    throw new Error("La orden de trabajo no contiene sus fechas");
  }
  return {
    id: workOrder._id.toString(),
    tenant_id: workOrder.tenant_id,
    ...(workOrder.anomaly_id ? { anomaly_id: workOrder.anomaly_id } : {}),
    asset_id: workOrder.asset_id,
    title: workOrder.title,
    description: workOrder.description,
    priority: workOrder.priority,
    status: workOrder.status,
    ...(workOrder.assigned_to ? { assigned_to: workOrder.assigned_to } : {}),
    created_by: workOrder.created_by,
    created_at: workOrder.created_at,
    updated_at: workOrder.updated_at
  };
}

export const workOrdersRouter: ReturnType<typeof Router> = Router();
workOrdersRouter.use(requireAuth);

workOrdersRouter.get(
  "/",
  requirePermission("workOrders", "read"),
  async (req, res) => {
    const filter = {
      tenant_id: req.tenantId,
      ...(req.user?.role === "TECNICO"
        ? { assigned_to: req.user.userId }
        : {})
    };
    const workOrders = await WorkOrderModel.find(filter)
      .sort({ created_at: -1 })
      .limit(100)
      .exec();
    res.json({ workOrders: workOrders.map(serializeWorkOrder) });
  }
);

workOrdersRouter.get(
  "/tecnicos",
  requireRole("SUPERVISOR"),
  async (req, res) => {
    const technicians = await UserModel.find({
      tenant_id: req.tenantId,
      role: "TECNICO",
      active: true
    })
      .select("_id nombre email")
      .sort({ nombre: 1 })
      .exec();
    res.json({
      technicians: technicians.map((technician) => ({
        id: technician._id.toString(),
        nombre: technician.nombre,
        email: technician.email
      }))
    });
  }
);

workOrdersRouter.get(
  "/:id/auditoria",
  requireRole("SUPERVISOR"),
  async (req, res) => {
    const entries = await AuditLogModel.find({
      tenant_id: req.tenantId,
      resource: "ordenes_trabajo",
      resource_id: req.params.id
    })
      .sort({ occurred_at: -1 })
      .limit(100)
      .exec();
    res.json({
      entries: entries.map((entry) => ({
        id: entry._id.toString(),
        actor_id: entry.actor_id,
        action: entry.action,
        resource_id: entry.resource_id,
        values_before: entry.values_before,
        values_after: entry.values_after,
        occurred_at: entry.occurred_at.toISOString()
      }))
    });
  }
);

workOrdersRouter.post(
  "/",
  requirePermission("workOrders", "create"),
  requireRole("SUPERVISOR"),
  validateBody(CreateWorkOrderSchema),
  async (req, res) => {
    const { user, tenantId } = req;
    if (!user || !tenantId) throw new HttpError(401, "Se requiere autenticación");
    const body = req.body as z.infer<typeof CreateWorkOrderSchema>;
    const session = await mongoose.startSession();
    let response: ReturnType<typeof serializeWorkOrder> | undefined;

    try {
      await session.withTransaction(async () => {
        await assertWorkOrderReferences(
          {
            assetId: body.asset_id,
            anomalyId: body.anomaly_id,
            assignedTo: body.assigned_to
          },
          tenantId
        );
        const [workOrder] = await WorkOrderModel.create(
          [
            {
              ...body,
              tenant_id: tenantId,
              created_by: user.userId,
              status: body.assigned_to ? "ASIGNADA" : "PENDIENTE"
            }
          ],
          { session }
        );
        response = serializeWorkOrder(workOrder);
        await writeAuditEntry({
          tenantId,
          actorId: user.userId,
          action: "CREATE",
          resource: "ordenes_trabajo",
          resourceId: workOrder._id.toString(),
          valuesBefore: null,
          valuesAfter: response,
          session
        });
      });
    } finally {
      await session.endSession();
    }
    if (!response) throw new Error("No se pudo crear la orden de trabajo");
    res.status(201).json({ workOrder: response });
  }
);

workOrdersRouter.patch(
  "/:id",
  requirePermission("workOrders", "update"),
  requireRole("SUPERVISOR"),
  validateBody(UpdateWorkOrderSchema),
  async (req, res) => {
    const { user, tenantId } = req;
    if (!user || !tenantId) throw new HttpError(401, "Se requiere autenticación");
    const patch = req.body as z.infer<typeof UpdateWorkOrderSchema>;
    const session = await mongoose.startSession();
    let response: ReturnType<typeof serializeWorkOrder> | undefined;

    try {
      await session.withTransaction(async () => {
        const workOrder = await WorkOrderModel.findOne({
          _id: req.params.id,
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

        const valuesBefore = serializeWorkOrder(workOrder);
        for (const [field, value] of Object.entries(patch)) {
          if (value === null && field === "assigned_to") {
            workOrder.set(field, undefined);
          } else {
            workOrder.set(field, value);
          }
        }
        if (patch.assigned_to !== undefined) {
          workOrder.status = patch.assigned_to ? "ASIGNADA" : "PENDIENTE";
        }
        await workOrder.save({ session });
        response = serializeWorkOrder(workOrder);
        await writeAuditEntry({
          tenantId,
          actorId: user.userId,
          action: "UPDATE",
          resource: "ordenes_trabajo",
          resourceId: workOrder._id.toString(),
          valuesBefore,
          valuesAfter: response,
          session
        });
      });
    } finally {
      await session.endSession();
    }
    if (!response) throw new Error("No se pudo actualizar la orden de trabajo");
    res.json({ workOrder: response });
  }
);
