import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  ClipboardList,
  Factory,
  LogOut,
  MessageSquareText,
  Package,
  Plus,
  Send,
  ShieldAlert,
  Wrench,
  X
} from "lucide-react";
import { hasPermission, type Anomaly, type Asset, type UserRole, type WorkOrder } from "@sigma/shared";
import {
  ApiError,
  SigmaApiClient,
  type AuditEntry,
  type AuthResponse
} from "@sigma/api-client";

const api = new SigmaApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? "http://localhost:3000",
  token: localStorage.getItem("sigma.token")
});

type View = "overview" | "anomalies" | "workOrders" | "inventory" | "analytics";
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

function createChatMessage(
  role: ChatMessage["role"],
  content: string
): ChatMessage {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `chat-${Date.now()}-${Math.random()}`,
    role,
    content,
    timestamp: new Date().toISOString()
  };
}

const roleNames: Record<UserRole, string> = {
  TECNICO: "Técnico",
  SUPERVISOR: "Supervisor",
  BODEGA: "Bodega",
  GERENCIA: "Gerencia"
};

function readStoredUser(): AuthResponse["user"] | null {
  const raw = localStorage.getItem("sigma.user");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthResponse["user"];
  } catch {
    localStorage.removeItem("sigma.user");
    localStorage.removeItem("sigma.token");
    return null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "Acceso denegado (403): tu rol no tiene permiso para esta acción.";
  }
  return error instanceof Error ? error.message : "Ocurrió un error inesperado";
}

function assetDisplayName(assetId: string, assets: Asset[]): string {
  const asset = assets.find(
    (item) => (item._id ?? item.id) === assetId
  );
  if (!asset) return "Activo no disponible";
  return `${asset.codigo ?? asset.asset_code} - ${asset.nombre}`;
}

type AuditSnapshot = Record<string, unknown>;

const auditFields = [
  ["title", "Título"],
  ["description", "Descripción"],
  ["asset_id", "Activo"],
  ["priority", "Prioridad"],
  ["status", "Estado"],
  ["assigned_to", "Asignado a"]
] as const;

function auditSnapshot(value: unknown): AuditSnapshot | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as AuditSnapshot)
    : null;
}

function auditTechnicalValues(value: unknown, entry: AuditEntry): unknown {
  const snapshot = auditSnapshot(value);
  if (!snapshot || typeof snapshot.asset_id !== "string") return value;
  const assetLabel = [entry.asset_code, entry.asset_name]
    .filter(Boolean)
    .join(" - ");
  return {
    ...snapshot,
    asset_id: assetLabel || "Activo no disponible"
  };
}

function formatAuditValue(
  field: (typeof auditFields)[number][0],
  value: unknown,
  entry: AuditEntry
): string {
  if (field === "assigned_to") {
    if (typeof value !== "string" || !value) return "Sin asignar";
    return entry.user_names?.[value] ?? value;
  }
  if (field === "asset_id") {
    const label = [entry.asset_code, entry.asset_name].filter(Boolean).join(" - ");
    return label || (typeof value === "string" ? value : "Sin activo");
  }
  if (typeof value !== "string" || !value) return "—";
  if (field === "priority") {
    const labels: Record<string, string> = {
      ALTA: "Alta",
      MEDIA: "Media",
      BAJA: "Baja"
    };
    return labels[value] ?? value;
  }
  if (field === "status") {
    const labels: Record<string, string> = {
      PENDIENTE: "Pendiente",
      ASIGNADA: "Asignada",
      EN_PROGRESO: "En progreso",
      CERRADA: "Cerrada"
    };
    return labels[value] ?? value;
  }
  return value;
}

function auditChanges(entry: AuditEntry) {
  const before = auditSnapshot(entry.values_before);
  const after = auditSnapshot(entry.values_after);
  if (!after) return [];
  return auditFields.flatMap(([field, label]) => {
    const hasPrevious = Boolean(
      before && Object.prototype.hasOwnProperty.call(before, field)
    );
    const hasNext = Object.prototype.hasOwnProperty.call(after, field);
    if (!hasPrevious && !hasNext) return [];
    const previousValue = before?.[field];
    const nextValue = after[field];
    if (
      hasPrevious &&
      JSON.stringify(previousValue) === JSON.stringify(nextValue)
    ) {
      return [];
    }
    return [{
      label,
      ...(hasPrevious
        ? { before: formatAuditValue(field, previousValue, entry) }
        : {}),
      after: formatAuditValue(field, nextValue, entry)
    }];
  });
}

function Login({ onLogin }: { onLogin: (result: AuthResponse) => void }) {
  const [tenantId, setTenantId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await api.login({ tenant_id: tenantId, email, password }));
    } catch (loginError) {
      setError(messageOf(loginError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark"><Factory size={27} /></div>
        <p className="eyebrow">MANTENIMIENTO INDUSTRIAL</p>
        <h1>Bienvenido a SIGMA</h1>
        <p className="muted">Ingresa para revisar las operaciones de tu organización.</p>
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <label>
            Tenant ID
            <input required value={tenantId} onChange={(event) => setTenantId(event.target.value)} placeholder="org_sigma_demo" autoComplete="organization" />
          </label>
          <label>
            Correo electrónico
            <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
          </label>
          <label>
            Contraseña
            <input required type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          </label>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={busy}>{busy ? "Ingresando…" : "Iniciar sesión"}</button>
        </form>
        <p className="login-note">Conexión segura · Acceso según rol autorizado</p>
      </section>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<AuthResponse["user"] | null>(readStoredUser);
  const [view, setView] = useState<View>("overview");
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [technicians, setTechnicians] = useState<Array<{ id: string; nombre: string; email: string }>>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotPrompt, setCopilotPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    createChatMessage(
      "assistant",
      `Hola, ${user?.nombre.split(" ")[0] ?? ""}. ¿En qué puedo ayudarte con tus operaciones hoy?`
    )
  ]);
  const [copilotBusy, setCopilotBusy] = useState(false);
  const copilotBusyRef = useRef(false);
  const copilotMessagesRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    copilotMessagesRef.current?.scrollTo({
      top: copilotMessagesRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages, copilotBusy]);

  const supervisor = user?.role === "SUPERVISOR";
  const canManageOrders = user ? hasPermission(user.role, "workOrders", "create") : false;
  const visibleNav = useMemo(() => {
    const nav: Array<{ id: View; label: string; icon: typeof Activity }> = [
      { id: "overview", label: "Resumen", icon: Activity },
      { id: "anomalies", label: "Anomalías", icon: AlertTriangle },
      { id: "workOrders", label: "Órdenes de trabajo", icon: ClipboardList }
    ];
    if (user?.role === "BODEGA") nav.push({ id: "inventory", label: "Repuestos", icon: Package });
    if (user?.role === "GERENCIA") nav.push({ id: "analytics", label: "KPIs MTTR", icon: Activity });
    return nav;
  }, [user]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      setAssets(await api.listAssets());
      if (hasPermission(user.role, "anomalies", "read")) {
        setAnomalies(await api.listAnomalies());
      }
      if (hasPermission(user.role, "workOrders", "read")) {
        setWorkOrders(await api.listWorkOrders());
      }
      if (user.role === "SUPERVISOR") {
        setTechnicians(await api.listTechnicians());
      }
    } catch (requestError) {
      setError(messageOf(requestError));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function login(result: AuthResponse) {
    api.setToken(result.token);
    localStorage.setItem("sigma.token", result.token);
    localStorage.setItem("sigma.user", JSON.stringify(result.user));
    setUser(result.user);
    setView("overview");
  }

  function logout() {
    api.setToken(null);
    localStorage.removeItem("sigma.token");
    localStorage.removeItem("sigma.user");
    setAssets([]);
    setUser(null);
  }

  function navigate(next: View) {
    if (next === "workOrders" && user?.role === "TECNICO") {
      setError("Acceso denegado (403): Técnico no puede gestionar órdenes de trabajo.");
      window.alert("403 · Acceso denegado. El rol Técnico no puede acceder a la gestión de OTs.");
      return;
    }
    setError("");
    setView(next);
  }

  async function updateOrder(id: string, patch: { priority?: WorkOrder["priority"]; status?: WorkOrder["status"]; assigned_to?: string }) {
    try {
      await api.updateWorkOrder(id, patch);
      await refresh();
    } catch (requestError) {
      setError(messageOf(requestError));
    }
  }

  async function showAudit(id: string) {
    setAuditFor(id);
    try {
      setAudit(await api.getWorkOrderAudit(id));
    } catch (requestError) {
      setError(messageOf(requestError));
    }
  }

  async function sendCopilot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = copilotPrompt.trim();
    if (!prompt || copilotBusyRef.current) return;
    copilotBusyRef.current = true;
    setCopilotBusy(true);
    setMessages((current) => [...current, createChatMessage("user", prompt)]);
    setCopilotPrompt("");
    try {
      const result = await api.copilot({ prompt });
      setMessages((current) => [
        ...current,
        createChatMessage("assistant", result.response)
      ]);
    } catch (requestError) {
      setMessages((current) => [
        ...current,
        createChatMessage("assistant", messageOf(requestError))
      ]);
    } finally {
      copilotBusyRef.current = false;
      setCopilotBusy(false);
    }
  }

  function clearCopilotChat() {
    if (copilotBusyRef.current) return;
    setMessages([
      createChatMessage(
        "assistant",
        `Hola, ${user?.nombre.split(" ")[0] ?? ""}. ¿En qué puedo ayudarte con tus operaciones hoy?`
      )
    ]);
  }

  if (!user) return <Login onLogin={login} />;

  const openAnomalies = anomalies.filter((item) => item.status !== "RESUELTA");
  const assignedOrders = workOrders.filter((item) => item.status !== "CERRADA");

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span className="brand-mark small"><Factory size={20} /></span><span><b>SIGMA</b><small>CONTROL DE OPERACIONES</small></span></div>
        <div className="tenant-chip"><span className="status-dot" /> Tenant activo <strong>{user.tenant_id}</strong></div>
        <p className="nav-caption">ESPACIO DE TRABAJO</p>
        <nav className="side-nav">
          {visibleNav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? "nav-item active" : "nav-item"} onClick={() => navigate(id)}>
              <Icon size={18} />{label}
              {id === "anomalies" && openAnomalies.length > 0 && <span className="nav-count">{openAnomalies.length}</span>}
            </button>
          ))}
          {!canManageOrders && <button className="nav-item muted-nav" onClick={() => navigate("workOrders")}><ShieldAlert size={18} />Gestión de OTs</button>}
        </nav>
        <div className="sidebar-bottom">
          <button className="copilot-launch" onClick={() => setCopilotOpen(true)}><Bot size={19} /><span><b>SIGMA Copilot</b><small>Asistente para {roleNames[user.role]}</small></span></button>
          <div className="profile-row"><div className="avatar">{user.nombre.slice(0, 1).toUpperCase()}</div><span className="profile-info"><b>{user.nombre}</b><small>{roleNames[user.role]}</small></span><button className="icon-button" aria-label="Cerrar sesión" onClick={logout}><LogOut size={17} /></button></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar"><div><p className="eyebrow">SIGMA / OPERACIONES</p><h1>{view === "overview" ? "Centro de control" : view === "anomalies" ? "Bandeja de anomalías" : view === "workOrders" ? "Órdenes de trabajo" : view === "inventory" ? "Gestión de repuestos" : "Indicadores de mantenimiento"}</h1></div><div className="topbar-actions"><span className="live-indicator"><i /> Servicio conectado</span><button className="icon-button copilot-mobile" aria-label="Abrir Copilot" onClick={() => setCopilotOpen(true)}><Bot size={20} /></button><div className="avatar">{user.nombre.slice(0, 1).toUpperCase()}</div></div></header>
        <div className="content-area">
          {error && <div className="alert-banner" role="alert"><ShieldAlert size={18} /><span>{error}</span><button onClick={() => setError("")} aria-label="Cerrar"><X size={16} /></button></div>}
          {loading && <div className="loading-line">Actualizando información…</div>}

          {view === "overview" && (
            <>
              <section className="welcome-row"><div><span className="date-pill">{new Intl.DateTimeFormat("es-CL", { dateStyle: "full" }).format(new Date())}</span><h2>Buen día, {user.nombre.split(" ")[0]}</h2><p>Este es el estado operativo de tu organización.</p></div><button className="secondary-button" onClick={() => void refresh()}>Actualizar datos</button></section>
              <div className="metric-grid">
                <Metric icon={AlertTriangle} label="Anomalías abiertas" value={String(openAnomalies.length).padStart(2, "0")} note="Pendientes de resolución" tone="amber" />
                <Metric icon={ClipboardList} label={user.role === "TECNICO" ? "Mis órdenes activas" : "Órdenes activas"} value={String(assignedOrders.length).padStart(2, "0")} note="En flujo de trabajo" tone="lime" />
                <Metric icon={Wrench} label="Activos conectados" value={String(assets.length).padStart(2, "0")} note="Activos registrados en catálogo" tone="blue" />
              </div>
              <div className="section-heading"><div><p className="eyebrow">PRIORIDAD OPERACIONAL</p><h2>Anomalías recientes</h2></div><button className="text-button" onClick={() => navigate("anomalies")}>Ver bandeja →</button></div>
              <AnomalyList anomalies={anomalies.slice(0, 5)} assets={assets} />
              {(user.role === "BODEGA" || user.role === "GERENCIA") && <div className="placeholder-card"><div className="placeholder-icon">{user.role === "BODEGA" ? <Package /> : <Activity />}</div><div><h3>{user.role === "BODEGA" ? "Control de repuestos" : "Confiabilidad y MTTR"}</h3><p>Vista preparada para conectar el módulo de {user.role === "BODEGA" ? "inventario y compatibilidad" : "indicadores operacionales"}.</p></div><button className="secondary-button" onClick={() => navigate(user.role === "BODEGA" ? "inventory" : "analytics")}>Abrir vista</button></div>}
            </>
          )}

          {view === "anomalies" && <><div className="section-heading"><div><p className="eyebrow">HU-02 · REPORTE EN TERRENO</p><h2>{anomalies.length} reportes registrados</h2></div><button className="secondary-button" onClick={() => void refresh()}>Actualizar</button></div><AnomalyList anomalies={anomalies} assets={assets} /></>}

          {view === "workOrders" && supervisor && (
            <>
              <div className="section-heading"><div><p className="eyebrow">HU-03 · PLANIFICACIÓN Y SEGUIMIENTO</p><h2>Tablero de ejecución</h2><p className="muted">{workOrders.length} órdenes en tu organización</p></div><button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={17} />Crear orden</button></div>
              <div className="table-card"><div className="table-scroll"><table><thead><tr><th>ORDEN / ACTIVO</th><th>PRIORIDAD</th><th>ESTADO</th><th>TÉCNICO ASIGNADO</th><th>ACTUALIZACIÓN</th></tr></thead><tbody>
                {workOrders.map((order) => <tr key={order.id}><td><b>{order.title}</b><small>{assetDisplayName(order.asset_id, assets)} · {order.description}</small><button className="audit-link" onClick={() => void showAudit(order.id)}>Ver historial de auditoría</button></td><td><select className={`table-select priority-${order.priority.toLowerCase()}`} aria-label={`Prioridad ${order.title}`} value={order.priority} onChange={(event) => void updateOrder(order.id, { priority: event.target.value as WorkOrder["priority"] })}><option value="ALTA">Alta</option><option value="MEDIA">Media</option><option value="BAJA">Baja</option></select></td><td><select className="table-select" aria-label={`Estado ${order.title}`} value={order.status} onChange={(event) => void updateOrder(order.id, { status: event.target.value as WorkOrder["status"] })}><option value="PENDIENTE">Pendiente</option><option value="ASIGNADA">Asignada</option><option value="EN_PROGRESO">En progreso</option><option value="CERRADA">Cerrada</option></select></td><td><select className="table-select" aria-label={`Técnico ${order.title}`} value={order.assigned_to ?? ""} onChange={(event) => void updateOrder(order.id, { assigned_to: event.target.value })}><option value="">Sin asignar</option>{technicians.map((technician) => <option key={technician.id} value={technician.id}>{technician.nombre}</option>)}</select></td><td>{new Date(order.updated_at).toLocaleDateString("es-CL")}</td></tr>)}
                {workOrders.length === 0 && <tr><td colSpan={5} className="empty-row">Aún no hay órdenes de trabajo.</td></tr>}
              </tbody></table></div></div>
            </>
          )}

          {view === "workOrders" && !supervisor && <div className="denied-card"><ShieldAlert size={28} /><h2>Acceso denegado · 403</h2><p>El rol Técnico puede consultar sus órdenes asignadas, pero no gestionar, asignar ni priorizar órdenes de trabajo.</p></div>}

          {view === "inventory" && <Placeholder icon={Package} title="Gestión de repuestos" copy="Espacio de Bodega reservado para niveles de stock, compatibilidad de repuestos y movimientos de inventario." />}
          {view === "analytics" && <Placeholder icon={Activity} title="KPIs de mantenimiento" copy="Espacio de Gerencia reservado para MTTR, MTBF, confiabilidad y tendencias de mantenimiento." />}
        </div>
      </main>

      {copilotOpen && <aside className="copilot-panel"><div className="copilot-header"><div className="copilot-title"><span className="copilot-icon"><Bot size={20} /></span><span><b>SIGMA Copilot</b><small>Asistente para {roleNames[user.role]}</small></span></div><div className="copilot-header-actions"><button className="copilot-clear" type="button" onClick={clearCopilotChat} disabled={copilotBusy}>Limpiar chat</button><button className="icon-button" aria-label="Cerrar Copilot" onClick={() => setCopilotOpen(false)}><X size={19} /></button></div></div><div className="copilot-context"><span className="status-dot" />Contexto adaptado al rol autenticado</div><div className="copilot-messages" ref={copilotMessagesRef} aria-live="polite">{messages.map((message) => <div className={`chat-message ${message.role === "user" ? "user-message" : "assistant-message"}`} key={message.id}>{message.role === "assistant" && <MessageSquareText size={17} />}<div className="chat-message-content"><p>{message.content}</p><time>{new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit" }).format(new Date(message.timestamp))}</time></div></div>)}{copilotBusy && <div className="chat-message assistant-message copilot-thinking" role="status"><span className="thinking-indicator" /><span>Analizando operaciones...</span></div>}<div className="copilot-chat-end" /></div><form className="copilot-compose" onSubmit={(event) => void sendCopilot(event)}><textarea value={copilotPrompt} onChange={(event) => setCopilotPrompt(event.target.value)} placeholder="Pregunta sobre tus operaciones…" rows={3} /><button className="primary-button" aria-label="Enviar mensaje" disabled={copilotBusy || !copilotPrompt.trim()}><Send size={17} /></button></form><p className="copilot-disclaimer">La IA puede cometer errores. Verifica recomendaciones críticas.</p></aside>}

      {createOpen && <CreateOrderModal assets={assets} anomalies={anomalies} technicians={technicians} onClose={() => setCreateOpen(false)} onCreated={async () => { setCreateOpen(false); await refresh(); }} />}
      {auditFor && <div className="modal-backdrop" onClick={() => setAuditFor(null)}><section className="audit-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">REGISTRO APPEND-ONLY</p><h2>Historial de auditoría</h2></div><button className="icon-button" onClick={() => setAuditFor(null)} aria-label="Cerrar"><X /></button></div>{audit.map((entry) => {
        const changes = auditChanges(entry);
        return <article className="audit-entry" key={entry.id}><div className="audit-meta"><b>{entry.action === "CREATE" ? "Orden creada" : "Orden actualizada"}</b><time>{new Date(entry.occurred_at).toLocaleString("es-CL")}</time></div><p className="audit-context"><span>Usuario: <strong>{entry.actor_name ?? entry.actor_id}</strong></span><span>Activo: <strong>{[entry.asset_code, entry.asset_name].filter(Boolean).join(" - ") || "No disponible"}</strong></span></p>{changes.length > 0 ? <ul className="audit-changes">{changes.map((change) => <li key={change.label}><b>{change.label}</b><span>{change.before !== undefined ? `${change.before} → ${change.after}` : change.after}</span></li>)}</ul> : <p className="muted">No hay cambios detallados disponibles.</p>}<details><summary>Ver datos técnicos (JSON)</summary><pre>{JSON.stringify({ antes: auditTechnicalValues(entry.values_before, entry), después: auditTechnicalValues(entry.values_after, entry) }, null, 2)}</pre></details></article>;
      })}{audit.length === 0 && <p className="muted">No hay eventos de auditoría para esta orden.</p>}</section></div>}
    </div>
  );
}

function Metric({ icon: Icon, label, value, note, tone }: { icon: typeof Activity; label: string; value: string; note: string; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}><Icon size={19} /></div><p>{label}</p><strong>{value}</strong><small>{note}</small></article>;
}

function AnomalyList({ anomalies, assets }: { anomalies: Anomaly[]; assets: Asset[] }) {
  if (!anomalies.length) return <div className="empty-card">No hay anomalías para mostrar.</div>;
  return <div className="anomaly-list">{anomalies.map((anomaly) => <article className="anomaly-row" key={anomaly.id}><span className={`severity-mark severity-${anomaly.severity.toLowerCase()}`} /><div className="anomaly-main"><div className="anomaly-title"><b>{assetDisplayName(anomaly.asset_id, assets)}</b><span className={`severity-pill severity-${anomaly.severity.toLowerCase()}`}>{anomaly.severity}</span></div><p>{anomaly.description}</p><small>Reportada {new Date(anomaly.created_at).toLocaleString("es-CL")} · {anomaly.reported_by}</small></div><span className={`status-pill status-${anomaly.status.toLowerCase()}`}>{anomaly.status.replaceAll("_", " ")}</span></article>)}</div>;
}

function Placeholder({ icon: Icon, title, copy }: { icon: typeof Activity; title: string; copy: string }) {
  return <section className="placeholder-page"><div className="placeholder-icon"><Icon size={25} /></div><p className="eyebrow">VISTA PREPARADA</p><h2>{title}</h2><p>{copy}</p><span className="coming-chip">Próxima etapa de integración</span></section>;
}

function CreateOrderModal({ assets, anomalies, technicians, onClose, onCreated }: { assets: Asset[]; anomalies: Anomaly[]; technicians: Array<{ id: string; nombre: string; email: string }>; onClose: () => void; onCreated: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assetId, setAssetId] = useState("");
  const [anomalyId, setAnomalyId] = useState("");
  const [priority, setPriority] = useState<WorkOrder["priority"]>("MEDIA");
  const [assignedTo, setAssignedTo] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.createWorkOrder({ title, description, asset_id: assetId, ...(anomalyId ? { anomaly_id: anomalyId } : {}), priority, ...(assignedTo ? { assigned_to: assignedTo } : {}) });
      await onCreated();
    } catch (createError) {
      setError(messageOf(createError));
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onClick={onClose}><section className="create-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">HU-03 · NUEVA ORDEN</p><h2>Crear orden de trabajo</h2></div><button className="icon-button" onClick={onClose} aria-label="Cerrar"><X /></button></div><form className="form-stack" onSubmit={(event) => void submit(event)}><label>Título<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Activo<select required value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="" disabled>Selecciona un activo</option>{assets.map((asset) => <option key={asset._id ?? asset.id} value={asset._id ?? asset.id}>{asset.codigo ?? asset.asset_code} - {asset.nombre}</option>)}</select></label><label>Anomalía relacionada<select value={anomalyId} onChange={(event) => { setAnomalyId(event.target.value); const selected = anomalies.find((anomaly) => anomaly.id === event.target.value); if (selected && assets.some((asset) => (asset._id ?? asset.id) === selected.asset_id)) setAssetId(selected.asset_id); }}><option value="">Sin anomalía asociada</option>{anomalies.map((anomaly) => <option key={anomaly.id} value={anomaly.id}>{assetDisplayName(anomaly.asset_id, assets)} · {anomaly.description.slice(0, 50)}</option>)}</select></label><label>Descripción<textarea required value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label><div className="form-two"><label>Prioridad<select value={priority} onChange={(event) => setPriority(event.target.value as WorkOrder["priority"])}><option value="ALTA">Alta</option><option value="MEDIA">Media</option><option value="BAJA">Baja</option></select></label><label>Asignar técnico<select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)}><option value="">Sin asignar</option>{technicians.map((tech) => <option key={tech.id} value={tech.id}>{tech.nombre}</option>)}</select></label></div>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button className="primary-button" disabled={busy || assets.length === 0}>{busy ? "Guardando…" : assets.length === 0 ? "No hay activos" : "Crear orden"}</button></div></form></section></div>;
}

export default App;
