import { randomUUID } from "node:crypto";
import { Schema, model } from "mongoose";
import type { InferSchemaType } from "mongoose";

const tenantFields = {
  _id: {
    type: String,
    default: () => randomUUID()
  },
  tenant_id: {
    type: String,
    required: true,
    trim: true,
    immutable: true
  }
} as const;

const tenantTimestamps = {
  timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  versionKey: false as const,
  strict: "throw" as const
};

const organizationSchema = new Schema(
  {
    ...tenantFields,
    nombre: { type: String, required: true, trim: true },
    plan: {
      type: String,
      enum: ["BASIC", "PRO", "ENTERPRISE"],
      required: true
    },
    features: {
      offline_advanced: { type: Boolean, required: true },
      inventory_transact: { type: Boolean, required: true },
      ai_assistant: { type: Boolean, required: true },
      executive_analytics: { type: Boolean, required: true }
    },
    limits: {
      max_active_users: { type: Number, required: true, min: 1 },
      storage_gb: { type: Number, required: true, min: 0 }
    }
  },
  tenantTimestamps
);
organizationSchema.index({ tenant_id: 1, created_at: -1 });
organizationSchema.index({ tenant_id: 1 }, { unique: true });

const userSchema = new Schema(
  {
    ...tenantFields,
    email: { type: String, required: true, lowercase: true, trim: true },
    nombre: { type: String, required: true, trim: true },
    password_hash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ["TECNICO", "SUPERVISOR", "BODEGA", "GERENCIA"],
      required: true
    },
    active: { type: Boolean, required: true, default: true }
  },
  tenantTimestamps
);
userSchema.index({ tenant_id: 1, created_at: -1 });
userSchema.index({ tenant_id: 1, email: 1 }, { unique: true });

const assetSchema = new Schema(
  {
    ...tenantFields,
    asset_code: { type: String, required: true, trim: true },
    qr_code: { type: String, required: true, trim: true },
    nombre: { type: String, required: true, trim: true },
    marca: { type: String, trim: true },
    modelo: { type: String, trim: true },
    serial_number: { type: String, trim: true },
    status: {
      type: String,
      enum: ["OPERATIVO", "FUERA_DE_SERVICIO", "MANTENIMIENTO"],
      required: true
    }
  },
  tenantTimestamps
);
assetSchema.index({ tenant_id: 1, created_at: -1 });
assetSchema.index({ tenant_id: 1, asset_code: 1 }, { unique: true });
assetSchema.index({ tenant_id: 1, qr_code: 1 }, { unique: true });

const anomalySchema = new Schema(
  {
    ...tenantFields,
    asset_id: { type: String, required: true, trim: true },
    reported_by: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    client_mutation_id: { type: String, trim: true, immutable: true },
    severity: {
      type: String,
      enum: ["BAJA", "MEDIA", "ALTA", "CRITICA"],
      required: true
    },
    photo_url: { type: String },
    photo_hash: { type: String, match: /^[a-f\d]{64}$/i },
    status: {
      type: String,
      enum: ["PENDIENTE", "EN_PROCESO", "RESUELTA"],
      required: true,
      default: "PENDIENTE"
    },
    sync_status: {
      type: String,
      enum: ["LOCAL", "SYNCED", "ERROR"],
      default: "SYNCED"
    }
  },
  tenantTimestamps
);
anomalySchema.index({ tenant_id: 1, created_at: -1 });
anomalySchema.index({ tenant_id: 1, asset_id: 1, created_at: -1 });
anomalySchema.index(
  { tenant_id: 1, client_mutation_id: 1 },
  { unique: true, partialFilterExpression: { client_mutation_id: { $exists: true } } }
);

const workOrderSchema = new Schema(
  {
    ...tenantFields,
    anomaly_id: { type: String, trim: true },
    asset_id: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    priority: { type: String, enum: ["BAJA", "MEDIA", "ALTA"], required: true },
    status: {
      type: String,
      enum: ["PENDIENTE", "ASIGNADA", "EN_PROGRESO", "CERRADA"],
      required: true,
      default: "PENDIENTE"
    },
    assigned_to: { type: String, trim: true },
    created_by: { type: String, required: true, trim: true }
  },
  tenantTimestamps
);
workOrderSchema.index({ tenant_id: 1, created_at: -1 });
workOrderSchema.index({ tenant_id: 1, status: 1, created_at: -1 });

const auditLogSchema = new Schema(
  {
    ...tenantFields,
    actor_id: { type: String, required: true, immutable: true },
    action: { type: String, required: true, immutable: true },
    resource: { type: String, required: true, immutable: true },
    resource_id: { type: String, required: true, immutable: true },
    details: { type: Schema.Types.Mixed, immutable: true },
    values_before: { type: Schema.Types.Mixed, immutable: true },
    values_after: { type: Schema.Types.Mixed, immutable: true },
    occurred_at: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true
    }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
    versionKey: false as const,
    strict: "throw"
  }
);
auditLogSchema.index({ tenant_id: 1, created_at: -1 });
auditLogSchema.index({ tenant_id: 1, resource: 1, resource_id: 1 });
auditLogSchema.pre("save", function () {
  if (!this.isNew) {
    throw new Error("Audit log entries are append-only");
  }
});
auditLogSchema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete"
  ],
  function () {
    throw new Error("Audit log entries are append-only");
  }
);
auditLogSchema.pre("deleteOne", { document: true, query: false }, function () {
  throw new Error("Audit log entries are append-only");
});
auditLogSchema.pre("bulkWrite", function () {
  throw new Error("Audit log entries are append-only");
});

const mutationReceiptSchema = new Schema(
  {
    ...tenantFields,
    client_mutation_id: { type: String, required: true, immutable: true },
    table: { type: String, required: true, immutable: true },
    record_id: { type: String, required: true, immutable: true },
    result: { type: Schema.Types.Mixed, required: true, immutable: true }
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
    versionKey: false as const,
    strict: "throw"
  }
);
mutationReceiptSchema.index(
  { tenant_id: 1, client_mutation_id: 1 },
  { unique: true }
);

export type OrganizationDocument = InferSchemaType<typeof organizationSchema>;
export type UserDocument = InferSchemaType<typeof userSchema>;
export type AssetDocument = InferSchemaType<typeof assetSchema>;
export type AnomalyDocument = InferSchemaType<typeof anomalySchema>;
export type WorkOrderDocument = InferSchemaType<typeof workOrderSchema>;
export type AuditLogDocument = InferSchemaType<typeof auditLogSchema>;
export type MutationReceiptDocument = InferSchemaType<typeof mutationReceiptSchema>;

export const OrganizationModel = model(
  "Organization",
  organizationSchema,
  "organizaciones"
);
export const UserModel = model("User", userSchema, "usuarios");
export const AssetModel = model("Asset", assetSchema, "activos");
export const AnomalyModel = model("Anomaly", anomalySchema, "anomalias");
export const WorkOrderModel = model(
  "WorkOrder",
  workOrderSchema,
  "ordenes_trabajo"
);
export const AuditLogModel = model("AuditLog", auditLogSchema, "auditoria");
export const MutationReceiptModel = model(
  "MutationReceipt",
  mutationReceiptSchema,
  "mutation_receipts"
);

export async function initializeMongoIndexes(): Promise<void> {
  await Promise.all([
    OrganizationModel.init(),
    UserModel.init(),
    AssetModel.init(),
    AnomalyModel.init(),
    WorkOrderModel.init(),
    AuditLogModel.init(),
    MutationReceiptModel.init()
  ]);
}
