import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";
import type { Anomaly, Asset, WorkOrder } from "@sigma/shared";
import type {
  CreateAnomalyInput,
  SigmaApiClient,
  UpdateWorkOrderInput
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
  kind: "report";
  id: string;
  asset_id: string;
  description: string;
  severity: Anomaly["severity"];
  created_at: string;
}
export interface PendingWorkOrder {
  kind: "work_order";
  id: string;
  asset_id: string;
  title: string;
  status: WorkOrder["status"];
  closing_note?: string;
  created_at: string;
}
export type PendingItem = PendingReport | PendingWorkOrder;
type PendingWorkOrderUpdate = PendingWorkOrder & {
  tenant_id: string;
  queue_id: string;
};
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
    const pending = this.usesPowerSync
      ? []
      : await getValue<PendingWorkOrderUpdate[]>(
          `${storagePrefix}${tenantId}.work-order-queue`,
          []
        );
    const pendingById = new Map(pending.map((item) => [item.id, item]));
    await setValue(
      `${storagePrefix}${tenantId}.work-orders`,
      orders.map((order) => {
        const update = pendingById.get(order.id);
        return update
          ? {
              ...order,
              status: update.status,
              ...(update.closing_note
                ? { closing_note: update.closing_note }
                : {})
            }
          : order;
      })
    );
  }

  async getCachedWorkOrders(tenantId: string): Promise<WorkOrder[]> {
    return getValue(`${storagePrefix}${tenantId}.work-orders`, []);
  }

  async updateAssignedWorkOrder(
    order: WorkOrder,
    tenantId: string,
    userId: string,
    patch: Pick<UpdateWorkOrderInput, "status" | "closing_note">
  ): Promise<WorkOrder> {
    if (order.tenant_id !== tenantId || order.assigned_to !== userId) {
      throw new Error("La orden no está asignada al usuario autenticado");
    }
    const updatedAt = new Date();
    const updated: WorkOrder = {
      ...order,
      ...patch,
      updated_at: updatedAt
    };
    const pending: PendingWorkOrderUpdate = {
      kind: "work_order",
      id: order.id,
      tenant_id: tenantId,
      queue_id: `${order.id}:${updatedAt.getTime()}:${Math.random().toString(36).slice(2)}`,
      asset_id: order.asset_id,
      title: order.title,
      status: updated.status,
      ...(updated.closing_note ? { closing_note: updated.closing_note } : {}),
      created_at: updatedAt.toISOString()
    };

    if (this.usesPowerSync && this.database) {
      if (updated.closing_note) {
        await this.database.execute(
          "UPDATE ordenes_trabajo SET status = ?, closing_note = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND assigned_to = ?",
          [
            updated.status,
            updated.closing_note,
            updatedAt.toISOString(),
            order.id,
            tenantId,
            userId
          ]
        );
      } else {
        await this.database.execute(
          "UPDATE ordenes_trabajo SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND assigned_to = ?",
          [updated.status, updatedAt.toISOString(), order.id, tenantId, userId]
        );
      }
      await this.database.execute(
        "INSERT OR REPLACE INTO ordenes_trabajo_locales (id, tenant_id, work_order_id, status, closing_note, created_at, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          order.id,
          tenantId,
          order.id,
          updated.status,
          updated.closing_note ?? null,
          updated.updated_at,
          "LOCAL"
        ]
      );
    } else {
      const key = `${storagePrefix}${tenantId}.work-order-queue`;
      const queue = await getValue<PendingWorkOrderUpdate[]>(key, []);
      await setValue(key, [...queue, pending]);
      const orders = await this.getCachedWorkOrders(tenantId);
      await this.cacheWorkOrders(
        tenantId,
        orders.map((cached) => (cached.id === order.id ? updated : cached))
      );
    }
    return updated;
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
    return (await this.getPendingItems(tenantId)).length;
  }

  async getPendingItems(tenantId: string): Promise<PendingItem[]> {
    const [reports, workOrders] = await Promise.all([
      this.getPendingReports(tenantId),
      this.getPendingWorkOrders(tenantId)
    ]);
    return [...reports, ...workOrders].sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
  }

  async getPendingReports(tenantId: string): Promise<PendingReport[]> {
    if (this.usesPowerSync && this.database) {
      const rows = await this.database.getAll<Omit<PendingReport, "kind">>(
        "SELECT a.id, a.asset_id, a.description, a.severity, a.created_at FROM anomalias a INNER JOIN anomalias_locales l ON l.id = a.id WHERE a.tenant_id = ? AND l.sync_status != 'SYNCED' ORDER BY a.created_at DESC",
        [tenantId]
      );
      return rows.map((row) => ({ ...row, kind: "report" }));
    }
    const queue = await getValue<PendingAnomaly[]>(
      `${storagePrefix}${tenantId}.anomaly-queue`,
      []
    );
    return queue.map(({ id, asset_id, description, severity, created_at }) => ({
      kind: "report",
      id,
      asset_id,
      description,
      severity,
      created_at
    }));
  }

  private async getPendingWorkOrders(
    tenantId: string
  ): Promise<PendingWorkOrder[]> {
    if (this.usesPowerSync && this.database) {
      const rows = await this.database.getAll<Omit<PendingWorkOrder, "kind">>(
        "SELECT o.id, o.asset_id, o.title, l.status, l.closing_note, l.created_at FROM ordenes_trabajo o INNER JOIN ordenes_trabajo_locales l ON l.work_order_id = o.id WHERE l.tenant_id = ? AND l.sync_status != 'SYNCED' ORDER BY l.created_at DESC",
        [tenantId]
      );
      return rows.map((row) => ({ ...row, kind: "work_order" }));
    }
    const queue = await getValue<PendingWorkOrderUpdate[]>(
      `${storagePrefix}${tenantId}.work-order-queue`,
      []
    );
    const latestByOrder = new Map(
      queue.map((item) => [item.id, item] as const)
    );
    return [...latestByOrder.values()].map(
      ({ tenant_id: _tenantId, queue_id: _queueId, ...item }) => item
    );
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

    const workOrderKey = `${storagePrefix}${tenantId}.work-order-queue`;
    const workOrderQueue = await getValue<PendingWorkOrderUpdate[]>(
      workOrderKey,
      []
    );
    const remainingWorkOrders: PendingWorkOrderUpdate[] = [];
    for (const item of workOrderQueue) {
      try {
        const updated = await api.updateWorkOrder(item.id, {
          status: item.status,
          ...(item.closing_note ? { closing_note: item.closing_note } : {})
        });
        const cachedOrders = await this.getCachedWorkOrders(tenantId);
        await this.cacheWorkOrders(
          tenantId,
          cachedOrders.map((order) => (order.id === updated.id ? updated : order))
        );
        const remainingQueue = await getValue<PendingWorkOrderUpdate[]>(
          workOrderKey,
          []
        );
        await setValue(
          workOrderKey,
          remainingQueue.filter((queued) => queued.queue_id !== item.queue_id)
        );
      } catch (error) {
        console.warn(
          "Actualización de orden permanece en la cola offline para reintento",
          error
        );
        remainingWorkOrders.push(item);
        const currentIndex = workOrderQueue.findIndex(
          (queued) => queued.queue_id === item.queue_id
        );
        remainingWorkOrders.push(...workOrderQueue.slice(currentIndex + 1));
        break;
      }
    }
    if (remainingWorkOrders.length > 0) {
      const currentQueue = await getValue<PendingWorkOrderUpdate[]>(
        workOrderKey,
        []
      );
      const remainingIds = new Set(remainingWorkOrders.map((item) => item.queue_id));
      await setValue(
        workOrderKey,
        currentQueue.filter((item) => remainingIds.has(item.queue_id))
      );
    }
  }

  subscribe(
    tenantId: string,
    userId: string,
    onAssets: (assets: CachedCatalogAsset[]) => void,
    onOrders: (orders: WorkOrder[]) => void,
    onPendingCount: (count: number) => void,
    onPendingItems: (items: PendingItem[]) => void
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
      let pendingReports: PendingReport[] = [];
      let pendingWorkOrders: PendingWorkOrder[] = [];
      const publishPending = () => {
        const items: PendingItem[] = [...pendingReports, ...pendingWorkOrders];
        onPendingCount(items.length);
        onPendingItems(items);
      };
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
        "SELECT id, tenant_id, anomaly_id, asset_id, title, description, closing_note, priority, status, assigned_to, created_by, created_at, updated_at FROM ordenes_trabajo WHERE tenant_id = ? AND assigned_to = ? ORDER BY created_at DESC",
        [tenantId, userId],
        onOrders
      );
      watch<Omit<PendingReport, "kind">>(
        "SELECT a.id, a.asset_id, a.description, a.severity, a.created_at FROM anomalias a INNER JOIN anomalias_locales l ON l.id = a.id WHERE a.tenant_id = ? AND l.sync_status != 'SYNCED' ORDER BY a.created_at DESC",
        [tenantId],
        (rows) => {
          pendingReports = rows.map((row) => ({ ...row, kind: "report" }));
          publishPending();
        }
      );
      watch<Omit<PendingWorkOrder, "kind">>(
        "SELECT o.id, o.asset_id, o.title, l.status, l.closing_note, l.created_at FROM ordenes_trabajo o INNER JOIN ordenes_trabajo_locales l ON l.work_order_id = o.id WHERE l.tenant_id = ? AND l.sync_status != 'SYNCED' ORDER BY l.created_at DESC",
        [tenantId],
        (rows) => {
          pendingWorkOrders = rows.map((row) => ({
            ...row,
            kind: "work_order"
          }));
          publishPending();
        }
      );
    } else {
      void Promise.all([
        this.getCachedAssets(tenantId).then(onAssets),
        this.getCachedWorkOrders(tenantId).then((orders) =>
          onOrders(orders.filter((order) => order.assigned_to === userId))
        ),
        this.getPendingItems(tenantId).then((items) => {
          onPendingCount(items.length);
          onPendingItems(items);
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
