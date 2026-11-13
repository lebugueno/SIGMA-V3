import { column, Schema, Table } from "@powersync/react-native";

export const sigmaSchema = new Schema({
  organizaciones: new Table({
    tenant_id: column.text,
    nombre: column.text,
    plan: column.text
  }),
  usuarios: new Table({
    tenant_id: column.text,
    nombre: column.text,
    email: column.text,
    role: column.text
  }),
  activos: new Table({
    tenant_id: column.text,
    asset_code: column.text,
    qr_code: column.text,
    nombre: column.text,
    marca: column.text,
    modelo: column.text,
    serial_number: column.text,
    status: column.text
  }),
  anomalias: new Table({
    tenant_id: column.text,
    asset_id: column.text,
    reported_by: column.text,
    description: column.text,
    severity: column.text,
    photo_url: column.text,
    photo_hash: column.text,
    status: column.text,
    created_at: column.text,
    client_mutation_id: column.text
  }),
  anomalias_locales: new Table(
    {
      client_mutation_id: column.text,
      photo_uri: column.text,
      sync_status: column.text
    },
    { localOnly: true }
  ),
  ordenes_trabajo: new Table({
    tenant_id: column.text,
    anomaly_id: column.text,
    asset_id: column.text,
    title: column.text,
    description: column.text,
    priority: column.text,
    status: column.text,
    assigned_to: column.text,
    created_by: column.text,
    created_at: column.text,
    updated_at: column.text
  })
});
