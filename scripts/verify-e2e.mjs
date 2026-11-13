import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "../apps/backend/node_modules/bcryptjs/umd/index.js";
import mongoose from "../apps/backend/node_modules/mongoose/index.js";

process.env.SEED_PASSWORD = "";

const [{ env }, { app }, models] = await Promise.all([
  import("../apps/backend/dist/config/env.js"),
  import("../apps/backend/dist/app.js"),
  import("../packages/db-sync/dist/models.js")
]);

const {
  AnomalyModel,
  AssetModel,
  AuditLogModel,
  MutationReceiptModel,
  OrganizationModel,
  UserModel,
  WorkOrderModel,
  initializeMongoIndexes
} = models;

const tenantId = `e2e_${randomUUID()}`;
const decoyTenantId = `e2e_decoy_${randomUUID()}`;
const password = `SigmaE2E-${randomUUID()}-A1!`;
const emails = {
  TECNICO: `tecnico.${randomUUID()}@e2e.sigma`,
  SUPERVISOR: `supervisor.${randomUUID()}@e2e.sigma`,
  BODEGA: `bodega.${randomUUID()}@e2e.sigma`,
  GERENCIA: `gerencia.${randomUUID()}@e2e.sigma`
};
let server;
let origin;
const originalFetch = globalThis.fetch;
const interceptedGeminiBodies = [];
let connected = false;

function safeMessage(error) {
  return error instanceof Error
    ? error.message
        .split("\n")[0]
        .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[MongoDB URI]")
    : "Error desconocido";
}

async function removeTenantData() {
  const filter = { tenant_id: { $in: [tenantId, decoyTenantId] } };
  await Promise.all([
    OrganizationModel.collection.deleteMany(filter),
    UserModel.collection.deleteMany(filter),
    AssetModel.collection.deleteMany(filter),
    AnomalyModel.collection.deleteMany(filter),
    WorkOrderModel.collection.deleteMany(filter),
    AuditLogModel.collection.deleteMany(filter),
    MutationReceiptModel.collection.deleteMany(filter)
  ]);
}

async function request(path, { token, method = "GET", body } = {}) {
  const response = await originalFetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  return { status: response.status, body: result };
}

async function login(role) {
  const result = await request("/api/auth/login", {
    method: "POST",
    body: { tenant_id: tenantId, email: emails[role], password }
  });
  assert.equal(result.status, 200, `Login ${role}: HTTP ${result.status}`);
  assert.equal(result.body.user.role, role);
  return result.body.token;
}

try {
  if (!env.MONGODB_URI) throw new Error("MONGODB_URI no está configurado");
  await mongoose.connect(env.MONGODB_URI);
  connected = true;
  await initializeMongoIndexes();
  for (const model of [
    OrganizationModel,
    UserModel,
    AssetModel,
    AnomalyModel,
    WorkOrderModel,
    AuditLogModel,
    MutationReceiptModel
  ]) {
    const indexes = await model.collection.indexes();
    assert.ok(
      indexes
        .filter((index) => index.name !== "_id_")
        .every((index) => Object.keys(index.key)[0] === "tenant_id"),
      `${model.collection.collectionName}: todos los índices deben comenzar por tenant_id`
    );
  }
  const anomalyIndexes = await AnomalyModel.collection.indexes();
  assert.ok(
    anomalyIndexes.some(
      (index) =>
        index.unique === true &&
        index.key.tenant_id === 1 &&
        index.key.client_mutation_id === 1
    ),
    "Debe existir el índice único compuesto para idempotencia de anomalías"
  );
  console.log("✓ Índices MongoDB: índices tenant-scoped y clave única de idempotencia");

  const passwordHash = await bcrypt.hash(password, 4);
  await OrganizationModel.create([
    {
      tenant_id: tenantId,
      nombre: "SIGMA E2E aislado",
      plan: "BASIC",
      features: {
        offline_advanced: true,
        inventory_transact: false,
        ai_assistant: true,
        executive_analytics: true
      },
      limits: { max_active_users: 10, storage_gb: 10 }
    },
    {
      tenant_id: decoyTenantId,
      nombre: "Tenant señuelo E2E",
      plan: "BASIC",
      features: {
        offline_advanced: false,
        inventory_transact: false,
        ai_assistant: false,
        executive_analytics: false
      },
      limits: { max_active_users: 10, storage_gb: 10 }
    }
  ]);

  const roleUsers = await UserModel.create(
    Object.entries(emails).map(([role, email]) => ({
      tenant_id: tenantId,
      nombre: `Usuario ${role}`,
      email,
      password_hash: passwordHash,
      role,
      active: true
    }))
  );
  const technician = roleUsers.find((user) => user.role === "TECNICO");
  assert.ok(technician);

  const [asset, decoyAsset] = await AssetModel.create([
    {
      tenant_id: tenantId,
      asset_code: "E2E-PUMP",
      qr_code: `SIGMA-E2E-${randomUUID()}`,
      nombre: "Bomba exclusiva E2E",
      marca: "SIGMA",
      modelo: "TEST",
      status: "OPERATIVO"
    },
    {
      tenant_id: decoyTenantId,
      asset_code: "DECOY-ASSET",
      qr_code: `SIGMA-DECOY-${randomUUID()}`,
      nombre: "Activo no autorizado",
      status: "OPERATIVO"
    }
  ]);
  const [decoyAnomaly] = await AnomalyModel.create([
    {
      tenant_id: decoyTenantId,
      asset_id: decoyAsset._id.toString(),
      reported_by: "decoy-user",
      description: "Anomalía de tenant señuelo",
      client_mutation_id: `decoy-${randomUUID()}`,
      severity: "ALTA",
      status: "PENDIENTE",
      sync_status: "SYNCED"
    }
  ]);
  await WorkOrderModel.create({
    tenant_id: decoyTenantId,
    anomaly_id: decoyAnomaly._id.toString(),
    asset_id: decoyAsset._id.toString(),
    title: "OT de tenant señuelo",
    description: "No debe aparecer en el contexto",
    priority: "ALTA",
    status: "ASIGNADA",
    assigned_to: "decoy-technician",
    created_by: "decoy-supervisor"
  });

  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;

  const technicianToken = await login("TECNICO");
  const supervisorToken = await login("SUPERVISOR");

  const deniedOrder = await request("/api/ordenes-trabajo", {
    token: technicianToken,
    method: "POST",
    body: {
      asset_id: asset._id.toString(),
      title: "Intento no autorizado",
      description: "Debe ser rechazado",
      priority: "ALTA"
    }
  });
  assert.equal(deniedOrder.status, 403, "Técnico debe recibir HTTP 403 al crear OTs");
  console.log("✓ RBAC: Técnico recibe 403 al crear OTs");

  const mutationId = `e2e-mutation-${randomUUID()}`;
  const anomalyInput = {
    asset_id: asset._id.toString(),
    description: "Vibración detectada durante la prueba E2E",
    severity: "ALTA",
    client_mutation_id: mutationId
  };
  const firstAnomaly = await request("/api/anomalias", {
    token: technicianToken,
    method: "POST",
    body: anomalyInput
  });
  assert.equal(firstAnomaly.status, 201);
  const replayAnomaly = await request("/api/anomalias", {
    token: technicianToken,
    method: "POST",
    body: anomalyInput
  });
  assert.equal(replayAnomaly.status, 200);
  assert.equal(replayAnomaly.body.replayed, true);
  assert.equal(replayAnomaly.body.anomaly.id, firstAnomaly.body.anomaly.id);
  const anomalyCount = await AnomalyModel.countDocuments({
    tenant_id: tenantId,
    client_mutation_id: mutationId
  });
  assert.equal(anomalyCount, 1, "La clave de mutación debe producir un solo documento");
  console.log("✓ Idempotencia: dos reintentos producen una sola anomalía en Atlas");

  const anomalyList = await request("/api/anomalias", {
    token: supervisorToken
  });
  assert.equal(anomalyList.status, 200);
  assert.equal(anomalyList.body.anomalies.length, 1);
  assert.ok(
    anomalyList.body.anomalies.some(
      (anomaly) => anomaly.id === firstAnomaly.body.anomaly.id
    )
  );
  const createdOrder = await request("/api/ordenes-trabajo", {
    token: supervisorToken,
    method: "POST",
    body: {
      anomaly_id: firstAnomaly.body.anomaly.id,
      asset_id: asset._id.toString(),
      title: "OT de verificación E2E",
      description: "Revisar vibración y registrar diagnóstico",
      priority: "ALTA",
      assigned_to: technician._id.toString()
    }
  });
  assert.equal(createdOrder.status, 201);
  const orderId = createdOrder.body.workOrder.id;
  const updatedOrder = await request(`/api/ordenes-trabajo/${orderId}`, {
    token: supervisorToken,
    method: "PATCH",
    body: { status: "EN_PROGRESO", priority: "MEDIA" }
  });
  assert.equal(updatedOrder.status, 200);

  const auditCount = await AuditLogModel.countDocuments({
    tenant_id: tenantId,
    resource: "ordenes_trabajo",
    resource_id: orderId
  });
  assert.equal(auditCount, 2, "Creación y modificación deben generar dos eventos auditados");
  const auditResponse = await request(`/api/ordenes-trabajo/${orderId}/auditoria`, {
    token: supervisorToken
  });
  assert.equal(auditResponse.status, 200);
  assert.equal(auditResponse.body.entries.length, 2);
  console.log("✓ HU-03: Supervisor crea/asigna OT y cada mutación queda auditada");

  const originalGeminiKey = env.GEMINI_API_KEY;
  env.GEMINI_API_KEY = "e2e-mock-key";
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      interceptedGeminiBodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Respuesta Gemini simulada para E2E." }] } }]
      });
    }
    return originalFetch(input, init);
  };

  for (const [role, token] of [
    ["TECNICO", technicianToken],
    ["SUPERVISOR", supervisorToken]
  ]) {
    const copilot = await request("/api/ai/copilot", {
      token,
      method: "POST",
      body: { prompt: "Resume la situación del activo de prueba." }
    });
    assert.equal(copilot.status, 200, `Copilot ${role} debe responder`);
    assert.equal(copilot.body.tenantContext.tenant_id, tenantId);
    assert.equal(copilot.body.tenantContext.assets_count, 1);
    assert.equal(copilot.body.tenantContext.anomalies_count, 1);
    assert.equal(copilot.body.tenantContext.work_orders_count, 1);
  }
  assert.equal(interceptedGeminiBodies.length, 2);
  for (const body of interceptedGeminiBodies) {
    const serialized = JSON.stringify(body);
    assert.ok(serialized.includes("Bomba exclusiva E2E"));
    assert.ok(!serialized.includes("Activo no autorizado"));
    assert.ok(!serialized.includes(decoyTenantId));
  }
  console.log("✓ Copilot: contexto tenant-scoped verificado para Técnico y Supervisor");
  env.GEMINI_API_KEY = originalGeminiKey;
  console.log("E2E SIGMA completado correctamente.");
} catch (error) {
  console.error(`Falló la verificación E2E: ${safeMessage(error)}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (connected) {
    try {
      await removeTenantData();
    } catch {
      console.error("No se pudo completar la limpieza de los tenants E2E.");
      process.exitCode = 1;
    }
    await mongoose.disconnect();
  }
}
