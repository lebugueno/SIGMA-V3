import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import {
  AssetModel,
  OrganizationModel,
  UserModel,
  initializeMongoIndexes
} from "@sigma/db-sync";
import { env } from "./config/env.js";

const tenantId = "org_sigma_demo";
const roles = [
  { role: "TECNICO", email: "tecnico@sigma.demo", nombre: "Técnico Demo" },
  {
    role: "SUPERVISOR",
    email: "supervisor@sigma.demo",
    nombre: "Supervisor Demo"
  },
  { role: "BODEGA", email: "bodega@sigma.demo", nombre: "Bodega Demo" },
  { role: "GERENCIA", email: "gerencia@sigma.demo", nombre: "Gerencia Demo" }
] as const;

const assets = [
  {
    asset_code: "B-102",
    qr_code: "SIGMA-DEMO-QR-B-102",
    nombre: "Bomba centrífuga B-102",
    marca: "Grundfos",
    modelo: "CR 32-4",
    serial_number: "DEMO-B102-001"
  },
  {
    asset_code: "M-204",
    qr_code: "SIGMA-DEMO-QR-M-204",
    nombre: "Motor eléctrico M-204",
    marca: "Siemens",
    modelo: "1LE1",
    serial_number: "DEMO-M204-001"
  },
  {
    asset_code: "C-310",
    qr_code: "SIGMA-DEMO-QR-C-310",
    nombre: "Compresor C-310",
    marca: "Atlas Copco",
    modelo: "GA 30",
    serial_number: "DEMO-C310-001"
  }
] as const;

async function seed(): Promise<void> {
  if (!env.SEED_PASSWORD) {
    throw new Error("Define SEED_PASSWORD (mínimo 12 caracteres) para ejecutar el seed");
  }
  await mongoose.connect(env.MONGODB_URI);
  await initializeMongoIndexes();
  await OrganizationModel.updateOne(
    { tenant_id: tenantId },
    {
      $setOnInsert: {
        tenant_id: tenantId,
        nombre: "SIGMA Organización Demo",
        plan: "ENTERPRISE",
        features: {
          offline_advanced: true,
          inventory_transact: true,
          ai_assistant: true,
          executive_analytics: true
        },
        limits: { max_active_users: 50, storage_gb: 100 }
      }
    },
    { upsert: true }
  );

  for (const user of roles) {
    const password = createHmac("sha256", env.SEED_PASSWORD)
      .update(`sigma-demo:${user.role}:${user.email}`)
      .digest("base64url");
    const password_hash = await bcrypt.hash(password, 12);
    await UserModel.updateOne(
      { tenant_id: tenantId, email: user.email },
      {
        $set: {
          email: user.email,
          nombre: user.nombre,
          role: user.role,
          password_hash,
          active: true
        }
      },
      { upsert: true }
    );
  }
  for (const asset of assets) {
    await AssetModel.updateOne(
      { tenant_id: tenantId, asset_code: asset.asset_code },
      {
        $setOnInsert: {
          ...asset,
          tenant_id: tenantId,
          status: "OPERATIVO"
        }
      },
      { upsert: true }
    );
  }
  console.log(`Seed SIGMA listo (idempotente) · tenant ${tenantId}`);
  console.log("Credenciales demo (deterministas desde SEED_PASSWORD):");
  for (const user of roles) {
    const password = createHmac("sha256", env.SEED_PASSWORD)
      .update(`sigma-demo:${user.role}:${user.email}`)
      .digest("base64url");
    console.log(`  ${user.role}: ${user.email} / ${password}`);
  }
  console.log("Códigos QR de activos:");
  for (const asset of assets) console.log(`  ${asset.asset_code}: ${asset.qr_code}`);
}

try {
  await seed();
} catch (error) {
  console.error("Falló el seed de SIGMA", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
