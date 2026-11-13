import type { Anomaly, Asset, UserRole, WorkOrder } from "@sigma/shared";

export interface AuthUser {
  userId: string;
  tenant_id: string;
  nombre: string;
  email: string;
  role: UserRole;
  rol: "Tecnico" | "Supervisor" | "Bodega" | "Gerencia";
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface CreateAnomalyInput {
  asset_id: string;
  description: string;
  severity: Anomaly["severity"];
  photo_url?: string;
  photo_hash?: string;
  client_mutation_id: string;
}

export interface CreateWorkOrderInput {
  anomaly_id?: string;
  asset_id: string;
  title: string;
  description: string;
  priority?: WorkOrder["priority"];
  assigned_to?: string;
}

export interface UpdateWorkOrderInput {
  title?: string;
  description?: string;
  priority?: WorkOrder["priority"];
  status?: WorkOrder["status"];
  assigned_to?: string | null;
}

export interface AuditEntry {
  id: string;
  actor_id: string;
  action: string;
  resource_id: string;
  values_before: unknown;
  values_after: unknown;
  occurred_at: string;
}

export interface CopilotInput {
  prompt: string;
  contextoActivo?: unknown;
}

export interface CopilotResponse {
  response: string;
  role: AuthUser["rol"];
}

export interface PowerSyncToken {
  token: string;
  endpoint: string;
  expiresIn: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface SigmaApiClientOptions {
  baseUrl: string;
  token?: string | null;
  fetcher?: typeof fetch;
}

export class SigmaApiClient {
  private token: string | null;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: SigmaApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token ?? null;
    this.fetcher = options.fetcher ?? fetch;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  async login(input: {
    tenant_id: string;
    email: string;
    password: string;
  }): Promise<AuthResponse> {
    const response = await this.request<AuthResponse>(
      "/api/auth/login",
      "POST",
      input
    );
    this.setToken(response.token);
    return response;
  }

  async listAnomalies(): Promise<Anomaly[]> {
    const response = await this.request<{ anomalies: Anomaly[] }>(
      "/api/anomalias"
    );
    return response.anomalies;
  }

  async listAssets(): Promise<Asset[]> {
    const response = await this.request<{ assets: Asset[] }>("/api/activos");
    return response.assets;
  }

  async createAnomaly(input: CreateAnomalyInput): Promise<{
    anomaly: Anomaly;
    replayed: boolean;
  }> {
    return this.request("/api/anomalias", "POST", input);
  }

  async listWorkOrders(): Promise<WorkOrder[]> {
    const response = await this.request<{ workOrders: WorkOrder[] }>(
      "/api/ordenes-trabajo"
    );
    return response.workOrders;
  }

  async listTechnicians(): Promise<
    Array<{ id: string; nombre: string; email: string }>
  > {
    const response = await this.request<{
      technicians: Array<{ id: string; nombre: string; email: string }>;
    }>("/api/ordenes-trabajo/tecnicos");
    return response.technicians;
  }

  async createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
    const response = await this.request<{ workOrder: WorkOrder }>(
      "/api/ordenes-trabajo",
      "POST",
      input
    );
    return response.workOrder;
  }

  async updateWorkOrder(
    id: string,
    input: UpdateWorkOrderInput
  ): Promise<WorkOrder> {
    const response = await this.request<{ workOrder: WorkOrder }>(
      `/api/ordenes-trabajo/${encodeURIComponent(id)}`,
      "PATCH",
      input
    );
    return response.workOrder;
  }

  async getWorkOrderAudit(id: string): Promise<AuditEntry[]> {
    const response = await this.request<{ entries: AuditEntry[] }>(
      `/api/ordenes-trabajo/${encodeURIComponent(id)}/auditoria`
    );
    return response.entries;
  }

  getPowerSyncToken(): Promise<PowerSyncToken> {
    return this.request("/api/powersync/token");
  }

  copilot(input: CopilotInput): Promise<CopilotResponse> {
    return this.request("/api/ai/copilot", "POST", input);
  }

  async uploadCrud(mutations: unknown[]): Promise<{
    applied: number;
    results: Array<{ client_mutation_id: string; replayed: boolean }>;
  }> {
    return this.request("/api/powersync/crud", "POST", { mutations });
  }

  private async request<T>(
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      throw new ApiError(
        0,
        error instanceof Error ? error.message : "No se pudo conectar al servidor"
      );
    }
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "string"
          ? result.error
          : `Error HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return result as T;
  }
}
