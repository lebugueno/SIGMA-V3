import { z } from "zod";

const tenantIdSchema = z.string().trim().min(1);
const idSchema = z.string().trim().min(1);
const dateSchema = z.coerce.date();

export const UserRoleSchema = z.enum([
  "TECNICO",
  "SUPERVISOR",
  "BODEGA",
  "GERENCIA"
]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const OrganizationSchema = z.object({
  tenant_id: tenantIdSchema,
  nombre: z.string().trim().min(1),
  plan: z.enum(["BASIC", "PRO", "ENTERPRISE"]),
  features: z.object({
    offline_advanced: z.boolean(),
    inventory_transact: z.boolean(),
    ai_assistant: z.boolean(),
    executive_analytics: z.boolean()
  }),
  limits: z.object({
    max_active_users: z.number().int().positive(),
    storage_gb: z.number().positive()
  }),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const UserSchema = z.object({
  id: idSchema,
  tenant_id: tenantIdSchema,
  email: z.string().email(),
  nombre: z.string().trim().min(1),
  role: UserRoleSchema,
  active: z.boolean(),
  created_at: dateSchema
});
export type User = z.infer<typeof UserSchema>;

export const AssetSchema = z.object({
  id: idSchema,
  tenant_id: tenantIdSchema,
  asset_code: z.string().trim().min(1),
  qr_code: z.string().trim().min(1),
  nombre: z.string().trim().min(1),
  marca: z.string().trim().min(1).optional(),
  modelo: z.string().trim().min(1).optional(),
  serial_number: z.string().trim().min(1).optional(),
  status: z.enum(["OPERATIVO", "FUERA_DE_SERVICIO", "MANTENIMIENTO"]),
  created_at: dateSchema
});
export type Asset = z.infer<typeof AssetSchema>;

export const AnomalySchema = z.object({
  id: idSchema,
  tenant_id: tenantIdSchema,
  asset_id: idSchema,
  reported_by: idSchema,
  description: z.string().trim().min(1),
  severity: z.enum(["BAJA", "MEDIA", "ALTA", "CRITICA"]),
  photo_url: z.string().url().optional(),
  photo_hash: z.string().regex(/^[a-f\d]{64}$/i).optional(),
  status: z.enum(["PENDIENTE", "EN_PROCESO", "RESUELTA"]),
  created_at: dateSchema,
  sync_status: z.enum(["LOCAL", "SYNCED", "ERROR"])
});
export type Anomaly = z.infer<typeof AnomalySchema>;

export const WorkOrderSchema = z.object({
  id: idSchema,
  tenant_id: tenantIdSchema,
  anomaly_id: idSchema.optional(),
  asset_id: idSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  priority: z.enum(["BAJA", "MEDIA", "ALTA"]),
  status: z.enum(["PENDIENTE", "ASIGNADA", "EN_PROGRESO", "CERRADA"]),
  assigned_to: idSchema.optional(),
  created_by: idSchema,
  created_at: dateSchema,
  updated_at: dateSchema
});
export type WorkOrder = z.infer<typeof WorkOrderSchema>;

export const PermissionResourceSchema = z.enum([
  "organizations",
  "anomalies",
  "workOrders",
  "assets",
  "inventory",
  "analytics",
  "users"
]);
export const PermissionActionSchema = z.enum([
  "read",
  "create",
  "update",
  "delete",
  "assign"
]);
export type PermissionResource = z.infer<typeof PermissionResourceSchema>;
export type PermissionAction = z.infer<typeof PermissionActionSchema>;
export type Permission = `${PermissionResource}:${PermissionAction}`;

export const RBAC_PERMISSIONS = {
  TECNICO: [
    "organizations:read",
    "anomalies:read",
    "anomalies:create",
    "anomalies:update",
    "assets:read",
    "workOrders:read"
  ],
  SUPERVISOR: [
    "organizations:read",
    "anomalies:read",
    "anomalies:update",
    "workOrders:read",
    "workOrders:create",
    "workOrders:update",
    "workOrders:assign",
    "assets:read",
    "inventory:read",
    "users:read"
  ],
  BODEGA: [
    "organizations:read",
    "anomalies:read",
    "workOrders:read",
    "assets:read",
    "inventory:read",
    "inventory:create",
    "inventory:update"
  ],
  GERENCIA: [
    "organizations:read",
    "anomalies:read",
    "workOrders:read",
    "assets:read",
    "inventory:read",
    "analytics:read",
    "users:read"
  ]
} as const satisfies Record<UserRole, readonly Permission[]>;

export function hasPermission(
  role: UserRole,
  resource: PermissionResource,
  action: PermissionAction
): boolean {
  const permission: Permission = `${resource}:${action}`;
  return RBAC_PERMISSIONS[role].some((allowed) => allowed === permission);
}
