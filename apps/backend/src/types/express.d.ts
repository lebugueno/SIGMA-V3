import type { UserRole } from "@sigma/shared";

export type RoleLabel = "Tecnico" | "Supervisor" | "Bodega" | "Gerencia";

export interface AuthenticatedUser {
  userId: string;
  tenant_id: string;
  role: UserRole;
  rol: RoleLabel;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      tenantId?: string;
    }
  }
}

export {};
