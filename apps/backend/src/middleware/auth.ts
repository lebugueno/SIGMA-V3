import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import {
  UserRoleSchema,
  hasPermission,
  type PermissionAction,
  type PermissionResource,
  type UserRole
} from "@sigma/shared";
import { env } from "../config/env.js";
import { HttpError } from "./errors.js";
import type { AuthenticatedUser, RoleLabel } from "../types/express.js";

const roleLabels: Record<UserRole, RoleLabel> = {
  TECNICO: "Tecnico",
  SUPERVISOR: "Supervisor",
  BODEGA: "Bodega",
  GERENCIA: "Gerencia"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    next(new HttpError(401, "Se requiere autenticación"));
    return;
  }

  try {
    const payload: unknown = jwt.verify(
      authorization.slice("Bearer ".length),
      env.JWT_SECRET
    );
    if (!isRecord(payload)) {
      throw new HttpError(401, "Token inválido");
    }

    const roleResult = UserRoleSchema.safeParse(payload.role);
    if (
      !roleResult.success ||
      typeof payload.userId !== "string" ||
      typeof payload.tenant_id !== "string" ||
      payload.tenant_id.length === 0
    ) {
      throw new HttpError(401, "Token inválido");
    }

    const role = roleResult.data;
    const user: AuthenticatedUser = {
      userId: payload.userId,
      tenant_id: payload.tenant_id,
      role,
      rol: roleLabels[role]
    };
    req.user = user;
    req.tenantId = user.tenant_id;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new HttpError(403, "No tiene permisos para realizar esta acción"));
      return;
    }
    next();
  };
}

export function requirePermission(
  resource: PermissionResource,
  action: PermissionAction
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !hasPermission(req.user.role, resource, action)) {
      next(new HttpError(403, "No tiene permisos para realizar esta acción"));
      return;
    }
    next();
  };
}
