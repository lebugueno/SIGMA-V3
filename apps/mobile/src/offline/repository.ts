import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import type { Anomaly, Asset, WorkOrder } from "@sigma/shared";
import type {
  CreateAnomalyInput,
  SigmaApiClient
} from "@sigma/api-client";

type OfflineMode = "powersync" | "storage";
type PendingAnomaly = CreateAnomalyInput & {
  id: string;
  tenant_id: string;
  reported_by: string;
  created_at: string;
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
      const [{ getPowerSyncDatabase }, { SigmaPowerSyncConnector }] =
        await Promise.all([
          import("../powersync/database"),
          import("../powersync/connector")
        ]);
      const database = getPowerSyncDatabase();
      await database.connect(new SigmaPowerSyncConnector(api, powersyncUrl));
      this.database = database;
      this.mode = "powersync";
    } catch (error) {
      console.warn(
        "PowerSync nativo no está disponible; se usará la cola offline local",
        error
      );
      this.database = null;
      this.mode = "storage";
    }
    return this.mode;
  }

  async cacheAssets(tenantId: string, assets: Asset[]): Promise<void> {
    await setValue(`${storagePrefix}${tenantId}.assets`, assets);
  }

  async getCachedAssets(tenantId: string): Promise<Asset[]> {
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
    if (this.usesPowerSync && this.database) {
      const rows = await this.database.getAll<{ count: number }>(
        "SELECT COUNT(*) AS count FROM anomalias_locales WHERE sync_status != 'SYNCED'"
      );
      return rows[0]?.count ?? 0;
    }
    const queue = await getValue<PendingAnomaly[]>(
      `${storagePrefix}${tenantId}.anomaly-queue`,
      []
    );
    return queue.length;
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
    onAssets: (assets: Asset[]) => void,
    onOrders: (orders: WorkOrder[]) => void,
    onPendingCount: (count: number) => void
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
      watch<Asset>(
        "SELECT id, tenant_id, asset_code, qr_code, nombre, marca, modelo, serial_number, status, created_at FROM activos WHERE tenant_id = ? ORDER BY asset_code",
        [tenantId],
        onAssets
      );
      watch<WorkOrder>(
        "SELECT id, tenant_id, anomaly_id, asset_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at FROM ordenes_trabajo WHERE tenant_id = ? AND assigned_to = ? AND status != 'CERRADA' ORDER BY created_at DESC",
        [tenantId, userId],
        onOrders
      );
      watch<{ count: number }>(
        "SELECT COUNT(*) AS count FROM anomalias_locales WHERE sync_status != 'SYNCED'",
        [],
        (rows) => onPendingCount(rows[0]?.count ?? 0)
      );
    } else {
      void Promise.all([
        this.getCachedAssets(tenantId).then(onAssets),
        this.getCachedWorkOrders(tenantId).then((orders) =>
          onOrders(orders.filter((order) => order.assigned_to === userId))
        ),
        this.getPendingCount(tenantId).then(onPendingCount)
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
