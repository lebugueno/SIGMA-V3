import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import type { Anomaly, Asset, WorkOrder } from "@sigma/shared";
import type {
  CreateAnomalyInput,
  SigmaApiClient
} from "@sigma/api-client";
import { SigmaPowerSyncConnector } from "../powersync/connector";

type OfflineMode = "powersync" | "storage";
export interface CachedCatalogAsset {
  id: string;
  codigo: string;
  nombre: string;
  qr_code: string;
}

export interface PendingReport {
  id: string;
  asset_id: string;
  description: string;
  severity: Anomaly["severity"];
  created_at: string;
}
type PendingAnomaly = CreateAnomalyInput & {
  id: PendingReport["id"];
  tenant_id: string;
  reported_by: string;
  created_at: PendingReport["created_at"];
  photo_uri?: string;
};
type NativeDatabase = import("@powersync/react-native").PowerSyncDatabase;

const storagePrefix = "sigma.offline.";
const isWeb = Platform.OS === "web";
const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

function readWeb<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  const value = localStorage.getItem(key);
  return value ? (JSON.parse(value) as T) : fallback;
}

async function getValue<T>(key: string, fallback: T): Promise<T> {
  if (isWeb) return readWeb(key, fallback);
  try {
    const value = await AsyncStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch (error) {
    console.error("No se pudo leer el almacenamiento offline", error);
    throw error;
  }
}

async function setValue<T>(key: string, value: T): Promise<void> {
  const serialized = JSON.stringify(value);
  if (isWeb) {
    if (typeof localStorage === "undefined") {
      throw new Error("localStorage no está disponible en este navegador");
    }
    localStorage.setItem(key, serialized);
    return;
  }
  await AsyncStorage.setItem(key, serialized);
}

export class OfflineRepository {
  private mode: OfflineMode = "storage";
  private database: NativeDatabase | null = null;
  private connector: SigmaPowerSyncConnector | null = null;
  private currentTenantId: string | null = null;

  get usesPowerSync(): boolean {
    return this.mode === "powersync" && this.database !== null;
  }

  async initialize(
    api: SigmaApiClient,
    tenantId: string
  ): Promise<OfflineMode> {
    this.currentTenantId = tenantId;
    const powersyncUrl = process.env.EXPO_PUBLIC_POWERSYNC_URL?.trim();
    if (!powersyncUrl || isWeb || isExpoGo) {
      this.mode = "storage";
      return this.mode;
    }

    try {
      const { getPowerSyncDatabase } = await import("../powersync/database");
      const database = getPowerSyncDatabase();
      const connector = new SigmaPowerSyncConnector(api, powersyncUrl);
      await database.connect(connector);
      this.database = database;
      this.connector = connector;
      this.mode = "powersync";
    } catch (error) {
      console.warn(
        "PowerSync nativo no está disponible; se usará la cola offline local",
        error
      );
      this.database = null;
      this.connector = null;
      this.mode = "storage";
    }
    return this.mode;
  }

  async cacheAssets(
    tenantId: string,
    assets: Array<Pick<Asset, "id" | "asset_code" | "nombre" | "qr_code"> & {
      _id?: string;
      codigo?: string;
    }>
  ): Promise<void> {
    const catalog = assets.map((asset) => ({
      id: asset.id || asset._id || "",
      codigo: asset.codigo || asset.asset_code,
      nombre: asset.nombre,
      qr_code: asset.qr_code
    }));
    await setValue(`${storagePrefix}${tenantId}.assets`, catalog);
  }

  async getCachedAssets(tenantId: string): Promise<CachedCatalogAsset[]> {
    return getValue(`${storagePrefix}${tenantId}.assets`, []);
  }

  async cacheWorkOrders(tenantId: string, orders: WorkOrder[]): Promise<void> {
    await setValue(`${storagePrefix}${tenantId}.work-orders`, orders);
  }

  async getCachedWorkOrders(tenantId: string): Promise<WorkOrder[]> {
    return getValue(`${storagePrefix}${tenantId}.work-orders`, []);
  }

  async saveAnomaly(anomaly: PendingAnomaly): Promise<void> {
    if (this.usesPowerSync && this.database) {
      await this.database.execute(
        "INSERT INTO anomalias (id, tenant_id, asset_id, reported_by, description, severity, status, created_at, client_mutation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          anomaly.id,
          anomaly.tenant_id,
          anomaly.asset_id,
          anomaly.reported_by,
          anomaly.description,
          anomaly.severity,
          "PENDIENTE",
          anomaly.created_at,
          anomaly.client_mutation_id
        ]
      );
      await this.database.execute(
        "INSERT INTO anomalias_locales (id, client_mutation_id, photo_uri, sync_status) VALUES (?, ?, ?, ?)",
        [anomaly.id, anomaly.client_mutation_id, anomaly.photo_uri ?? null, "LOCAL"]
      );
      return;
    }

    const key = `${storagePrefix}${anomaly.tenant_id}.anomaly-queue`;
    const queue = await getValue<PendingAnomaly[]>(key, []);
    if (queue.some((entry) => entry.client_mutation_id === anomaly.client_mutation_id)) {
      return;
    }
    queue.push(anomaly);
    await setValue(key, queue);
  }

  async getPendingCount(tenantId: string): Promise<number> {
    return (await this.getPendingReports(tenantId)).length;
  }

  async getPendingReports(tenantId: string): Promise<PendingReport[]> {
    if (this.usesPowerSync && this.database) {
      return this.database.getAll<PendingReport>(
        "SELECT a.id, a.asset_id, a.description, a.severity, a.created_at FROM anomalias a INNER JOIN anomalias_locales l ON l.id = a.id WHERE a.tenant_id = ? AND l.sync_status != 'SYNCED' ORDER BY a.created_at DESC",
        [tenantId]
      );
    }
    const queue = await getValue<PendingAnomaly[]>(
      `${storagePrefix}${tenantId}.anomaly-queue`,
      []
    );
    return queue.map(({ id, asset_id, description, severity, created_at }) => ({
      id,
      asset_id,
      description,
      severity,
      created_at
    }));
  }

  async synchronizeNow(api: SigmaApiClient, tenantId: string): Promise<void> {
    if (this.usesPowerSync && this.database && this.connector) {
      await this.database.connect(this.connector);
      return;
    }
    await this.syncPending(api, tenantId);
  }

  async syncPending(api: SigmaApiClient, tenantId: string): Promise<void> {
    if (this.usesPowerSync) return;
    const key = `${storagePrefix}${tenantId}.anomaly-queue`;
    const queue = await getValue<PendingAnomaly[]>(key, []);
    const remaining: PendingAnomaly[] = [];
    for (const anomaly of queue) {
      try {
        await api.createAnomaly({
          asset_id: anomaly.asset_id,
          description: anomaly.description,
          severity: anomaly.severity,
          client_mutation_id: anomaly.client_mutation_id
        });
      } catch (error) {
        console.warn(
          "Anomalía permanece en la cola offline para reintento",
          error
        );
        remaining.push(anomaly);
        remaining.push(...queue.slice(queue.indexOf(anomaly) + 1));
        break;
      }
    }
    await setValue(key, remaining);
  }

  subscribe(
    tenantId: string,
    userId: string,
    onAssets: (assets: CachedCatalogAsset[]) => void,
    onOrders: (orders: WorkOrder[]) => void,
    onPendingCount: (count: number) => void,
    onPendingReports: (reports: PendingReport[]) => void
  ): () => void {
    let active = true;
    const iterators: Array<AsyncIterator<{ rows?: { _array: unknown[] } }>> = [];
    const watch = <T>(
      sql: string,
      parameters: unknown[],
      callback: (rows: T[]) => void
    ) => {
      const iterator = this.database!.watch(sql, parameters)[Symbol.asyncIterator]();
      iterators.push(iterator);
      void (async () => {
        try {
          while (active) {
            const result = await iterator.next();
            if (result.done) return;
            callback((result.value.rows?._array ?? []) as T[]);
          }
        } catch (error) {
          if (active) console.error("Falló una consulta reactiva PowerSync", error);
        }
      })();
    };

    if (this.usesPowerSync && this.database) {
      watch<{
        id: string;
        asset_code: string;
        qr_code: string;
        nombre: string;
      }>(
        "SELECT id, tenant_id, asset_code, qr_code, nombre, marca, modelo, serial_number, status, created_at FROM activos WHERE tenant_id = ? ORDER BY asset_code",
        [tenantId],
        (rows) => {
          if (rows.length === 0) return;
          const catalog = rows.map((asset) => ({
            id: asset.id,
            codigo: asset.asset_code,
            asset_code: asset.asset_code,
            nombre: asset.nombre,
            qr_code: asset.qr_code
          }));
          onAssets(catalog);
          void this.cacheAssets(tenantId, catalog).catch((error: unknown) =>
            console.error("No se pudo guardar el catálogo offline", error)
          );
        }
      );
      watch<WorkOrder>(
        "SELECT id, tenant_id, anomaly_id, asset_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at FROM ordenes_trabajo WHERE tenant_id = ? AND assigned_to = ? AND status != 'CERRADA' ORDER BY created_at DESC",
        [tenantId, userId],
        onOrders
      );
      watch<{ count: number }>(
        "SELECT COUNT(*) AS count FROM anomalias a INNER JOIN anomalias_locales l ON l.id = a.id WHERE a.tenant_id = ? AND l.sync_status != 'SYNCED'",
        [tenantId],
        (rows) => onPendingCount(rows[0]?.count ?? 0)
      );
      watch<PendingReport>(
        "SELECT a.id, a.asset_id, a.description, a.severity, a.created_at FROM anomalias a INNER JOIN anomalias_locales l ON l.id = a.id WHERE a.tenant_id = ? AND l.sync_status != 'SYNCED' ORDER BY a.created_at DESC",
        [tenantId],
        onPendingReports
      );
    } else {
      void Promise.all([
        this.getCachedAssets(tenantId).then(onAssets),
        this.getCachedWorkOrders(tenantId).then((orders) =>
          onOrders(orders.filter((order) => order.assigned_to === userId))
        ),
        this.getPendingReports(tenantId).then((reports) => {
          onPendingCount(reports.length);
          onPendingReports(reports);
        })
      ]).catch((error: unknown) =>
        console.error("No se pudo restaurar el almacenamiento offline", error)
      );
    }

    return () => {
      active = false;
      for (const iterator of iterators) void iterator.return?.();
    };
  }
}

export const offlineRepository = new OfflineRepository();
