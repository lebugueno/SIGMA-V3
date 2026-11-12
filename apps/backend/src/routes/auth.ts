import { randomUUID } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OrganizationModel, UserModel } from "@sigma/db-sync";
import { z } from "zod";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/errors.js";
import { validateBody } from "../middleware/validate.js";

const LoginSchema = z.object({
  tenant_id: z.string().trim().min(1),
  email: z.string().email().transform((email) => email.toLowerCase()),
  password: z.string().min(1)
});

const RegisterSchema = z.object({
  nombre: z.string().trim().min(1).max(120),
  email: z.string().email().transform((email) => email.toLowerCase()),
  password: z.string().min(12).max(128),
  organizationName: z.string().trim().min(1).max(160)
});

const roleLabels = {
  TECNICO: "Tecnico",
  SUPERVISOR: "Supervisor",
  BODEGA: "Bodega",
  GERENCIA: "Gerencia"
} as const;

function issueToken(user: {
  userId: string;
  tenantId: string;
  role: keyof typeof roleLabels;
}): string {
  return jwt.sign(
    {
      userId: user.userId,
      tenant_id: user.tenantId,
      role: user.role,
      rol: roleLabels[user.role]
    },
    env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "8h" }
  );
}

export const authRouter: ReturnType<typeof Router> = Router();

authRouter.post("/login", validateBody(LoginSchema), async (req, res) => {
  const { tenant_id, email, password } = req.body as z.infer<
    typeof LoginSchema
  >;
  const user = await UserModel.findOne({ tenant_id, email })
    .select("+password_hash")
    .exec();
  if (
    !user ||
    !user.active ||
    !(await bcrypt.compare(password, user.password_hash))
  ) {
    throw new HttpError(401, "Credenciales inválidas");
  }

  const userId = user._id.toString();
  res.json({
    token: issueToken({
      userId,
      tenantId: user.tenant_id,
      role: user.role
    }),
    user: {
      userId,
      tenant_id: user.tenant_id,
      nombre: user.nombre,
      email: user.email,
      role: user.role,
      rol: roleLabels[user.role]
    }
  });
});

authRouter.post("/register", validateBody(RegisterSchema), async (req, res) => {
  const { nombre, email, password, organizationName } = req.body as z.infer<
    typeof RegisterSchema
  >;
  const tenantId = `org_${randomUUID()}`;
  const passwordHash = await bcrypt.hash(password, 12);

  await OrganizationModel.create({
    tenant_id: tenantId,
    nombre: organizationName,
    plan: "BASIC",
    features: {
      offline_advanced: false,
      inventory_transact: false,
      ai_assistant: false,
      executive_analytics: false
    },
    limits: { max_active_users: 10, storage_gb: 10 }
  });
  const user = await UserModel.create({
    tenant_id: tenantId,
    nombre,
    email,
    password_hash: passwordHash,
    role: "SUPERVISOR",
    active: true
  });

  const userId = user._id.toString();
  res.status(201).json({
    token: issueToken({ userId, tenantId, role: user.role }),
    user: {
      userId,
      tenant_id: tenantId,
      nombre: user.nombre,
      email: user.email,
      role: user.role,
      rol: roleLabels[user.role]
    }
  });
});
