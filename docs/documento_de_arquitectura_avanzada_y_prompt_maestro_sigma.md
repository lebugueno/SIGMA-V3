# Proyecto SIGMA: Arquitectura Avanzada, Sincronización PowerSync y Prompt Maestro de Desarrollo

---

## 1. Capa de Abstracción de Datos y Sincronización (PowerSync + MongoDB Atlas)

Para cumplir con los plazos del Sprint 2 (Hito 3) y sostener un producto escalable para empresas de gran escala, se implementa una arquitectura basada en el **Patrón Repositorio (Repository Pattern)** en el frontend móvil y web, desacoplando la lógica de UI del motor de almacenamiento local (**PowerSync Client**) y de la API central conectada a **MongoDB Atlas**.

### 1.1 Patrón Repositorio y Contrato Unificado

La interfaz del repositorio encapsula todas las operaciones CRUD y la sincronización reactiva, permitiendo alternar o testear el motor sin afectar la capa de componentes.

```typescript
// src/core/repositories/IAnomalyRepository.ts
export interface AnomalyRecord {
  id: string;
  tenant_id: string;
  asset_id: string;
  reported_by: string;
  description: string;
  severity: 'BAJA' | 'MEDIA' | 'ALTA' | 'CRITICA';
  photo_url?: string;
  photo_hash?: string;
  status: 'PENDIENTE' | 'EN_PROCESO' | 'RESUELTA';
  created_at: string;
  sync_status: 'LOCAL' | 'SYNCED' | 'ERROR';
}

export interface IAnomalyRepository {
  create(anomaly: Omit<AnomalyRecord, 'id' | 'created_at' | 'sync_status'>): Promise<AnomalyRecord>;
  getById(id: string): Promise<AnomalyRecord | null>;
  getAllPendingSync(): Promise<AnomalyRecord[]>;
  watchAllByTenant(tenantId: string, callback: (data: AnomalyRecord[]) => void): () => void;
  markAsSynced(id: string, remoteUrl?: string): Promise<void>;
}
```

### 1.2 Integración PowerSync con MongoDB Atlas

PowerSync opera como el motor de sincronización local reactivo en el dispositivo móvil (sobre SQLite optimizado) y se enlaza bidireccionalmente con MongoDB Atlas mediante **Sync Streams**.

1. **PowerSync Schema (Móvil):** Define las tablas SQLite locales fuertemente tipadas.
2. **Backend Sync Service (Node.js):** Valida los tokens JWT, inyecta el `tenant_id` y canaliza las modificaciones hacia las colecciones de MongoDB Atlas.
3. **Flujo Sincrónico / Asincrónico:**
   * **Lectura/Escritura Local:** La aplicación móvil escribe localmente en $< 100\text{ ms}$, garantizando los requisitos RNF-4 ($t \le 2\text{ s}$).
   * **Sincronización:** Cuando hay conectividad, PowerSync transmite los cambios pendientes al backend en $< 5\text{ s}$ (RNF-2), actualizando MongoDB Atlas y notificando por WebSockets a los paneles web supervisores.

---

## 2. Definición Arquitectónica Empresarial (SaaS Multi-Tenant, White-Label e Auditoría)

### 2.1 Módulo A: Arquitectura Multi-Tenant SaaS

Para la comercialización por suscripción, el sistema utiliza un modelo de **Base de Datos Compartida con Aislamiento Lógico Riguroso**:

* **Indexación y Sharding:** Todas las colecciones en MongoDB Atlas (`organizaciones`, `usuarios`, `activos`, `anomalias`, `ordenes_trabajo`, `auditoria`) incluyen un campo obligatorio e indexado `{ tenant_id: 1, created_at: -1 }`.
* **Aislamiento en Token (JWT):** El payload del JWT firmado contiene el `tenant_id` y el `role` (RBAC). El backend rechaza cualquier petición cuyo `tenant_id` difiera del recurso solicitado.
* **Control de Funcionalidades (Feature Flags):** La colección `organizaciones` gestiona el plan activo:
  ```json
  {
    "tenant_id": "org_minera_norte",
    "nombre": "Minera del Norte S.A.",
    "plan": "ENTERPRISE",
    "features": {
      "offline_advanced": true,
      "inventory_transact": true,
      "ai_assistant": true,
      "executive_analytics": true
    },
    "limits": {
      "max_active_users": 500,
      "storage_gb": 1000
    }
  }
  ```

### 2.2 Módulo B: Despliegues Replicables "Marca Blanca" (Enterprise Dedicated)

Para grandes corporaciones que exigen infraestructura dedicada o almacenamiento on-premise/local:

* **Configuración Dinámica de Tema y Reglas (White-Label):**
  Se define un archivo de configuración inyectado en tiempo de compilación o inicio de sesión que adapta colores de alto contraste (cumpliendo RNF-1 para uso industrial con EPP), logotipos y flujos de aprobación personalizados.
* **Infraestructura como Código (IaC con Terraform y Docker):**
  Un módulo de Terraform despliega en minutos:
  1. Un clúster de MongoDB Atlas dedicado en la región requerida por el cliente.
  2. Un contenedor Docker del Backend Node.js de SIGMA en AWS ECS / Azure Container Apps.
  3. Instancias dedicadas de PowerSync Service.

### 2.3 Módulo C: Almacenamiento Industrial de Evidencia y Auditoría Inmutable

* **Carga Directa mediante URL Firmada (Presigned URLs):**
  1. El móvil comprime la foto en el cliente ($< 500\text{ KB}$).
  2. Solicita una URL firmada al backend indicando el `tenant_id` y el hash SHA-256 de la imagen.
  3. El móvil sube la foto directamente a S3 / Azure Blob Storage / Cloudflare R2 sin saturar el backend ni la base de datos documental.
  4. MongoDB Atlas almacena solo la referencia ligada a la anomalía:
     $$\text{Registro MongoDB} = \{ \text{id}, \text{tenant\_id}, \text{photo\_url}, \text{sha256\_hash}, \text{exif\_metadata} \}$$
* **Auditoría Inmutable (Change Streams):**
  Cada inserción o modificación en `ordenes_trabajo` o `inventario` dispara un evento mediante **MongoDB Change Streams** que escribe en la colección append-only `audit_logs`. Esta colección prohíbe operaciones de actualización (`update`) y eliminación (`delete`) mediante reglas de seguridad de MongoDB Atlas.

---

## 3. Módulo de Asistente de IA Contextual por Rol (SIGMA Copilot)

El sistema incorpora un motor asistido por IA (usando modelos optimizados como Gemini Flash / Claude) que se adapta al rol operativo activo en la aplicación web o móvil:

```
                  +-----------------------------------+
                  |        SIGMA COPILOT ENGINE       |
                  +-----------------------------------+
                                    |
          +-------------------------+-------------------------+
          |                         |                         |
          v                         v                         v
+-------------------+     +-------------------+     +-------------------+
|  TÉCNICO TERRENO  |     |    SUPERVISOR     |     |  BODEGA / GESTIÓN |
+-------------------+     +-------------------+     +-------------------+
| • Guía diagnóstica|     | • Priorización OT |     | • Validación stock|
| • Lectura manuales|     | • Asignación RBAC |     | • Alertas descalce|
| • Sugerencia foto |     | • Análisis MTTR   |     | • Control costos  |
+-------------------+     +-------------------+     +-------------------+
```

### 3.1 Funcionalidades Asistidas según Rol

1. **Técnico de Terreno (Móvil - Operación Offline/Online):**
   * **Diagnóstico AS-IS:** Analiza el texto de descripción de anomalía y sugiere la categoría de falla (Eléctrica, Mecánica, Hidráulica).
   * **Buscador de Manuales en Caché:** Responde consultas técnicas contextuales sobre el activo escaneado vía QR (ej.: *"¿Cuál es el torque recomendado para los pernos de la bomba B-102?"*).
   * **Control de Calidad de Evidencia:** Verifica que la fotografía capturada tenga claridad adecuada antes de guardarla en la cola local.

2. **Supervisor (Panel Web):**
   * **Asistente de Asignación y Priorización (HU-03):** Evalúa la severidad de las anomalías recibidas y recomienda la prioridad (Alta, Media, Baja) y el técnico ejecutor disponible con la especialidad requerida.
   * **Resumen Operativo Automático:** Genera reportes sintéticos del estado del turno en lenguaje natural para la gerencia.

3. **Encargado de Bodega y Logística (Panel Web - HU-04A / HU-04B):**
   * **Verificador de Compatibilidad:** Al recibir una solicitud móvil de repuestos (HU-04A), valida la compatibilidad con la marca y modelo del activo.
   * **Detección de Descalces:** Alerta al usuario si la imputación contable de repuestos supera el presupuesto proyectado de la orden de trabajo.

4. **Gerencia y Analítica (Panel Web - HU-05):**
   * **Analista de MTTR y Confiabilidad:** Interpreta métricas de Tiempo Medio entre Fallas (MTBF) y Tiempo Medio de Reparación (MTTR) y sugiere planes preventivos.

---

## 4. Documento de Propuesta y Guía Maestro para GitHub Codespaces + Copilot

A continuación se detalla la configuración y prompt maestro que debe colocarse en el repositorio (en `.github/copilot-instructions.md` o en el entorno de desarrollo) para guiar a la IA del entorno (Gemini como Desarrollador Principal y Claude como Auditor/QA).

```markdown:.github/copilot-instructions.md
# INSTRUCCIONES MAESTRAS DE DESARROLLO - PROYECTO SIGMA

## 1. CONTEXTO Y GOBERNANZA DEL PROYECTO
- **Proyecto:** SIGMA (Sistema Integrado de Gestión de Mantenimiento Automatizado).
- **Alcance Actual:** Sprint 2 (Historias HU-02 "Anomalías Offline" y HU-03 "Gestión de OTs con RBAC").
- **Integrantes Oficiales:** Leonor Bugueño (PO/Analista), Cristina Echeverría (SM/QA), Daniel Miranda (Arquitecto/Dev).
- **REGLA DE ORO DE GOBERNANZA:** Queda estrictamente prohibido incluir cualquier referencia a Matías Ríos en comentarios, código, documentación, autores o commits.

## 2. ARQUITECTURA TÉCNICA OBLIGATORIA
- **Stack Backend:** Node.js, Express/NestJS en TypeScript, MongoDB Atlas (Mongoose), PowerSync Service API.
- **Stack Frontend Web:** React (Vite/Next.js) con Tailwind CSS.
- **Stack Frontend Móvil:** React Native con Expo, PowerSync Client SDK, expo-sqlite.
- **Persistencia y Sync:** Modelo Multi-Tenant con `tenant_id` obligatorio. PowerSync administra la base SQLite local en el móvil y se sincroniza con MongoDB Atlas.
- **Seguridad:** TLS/HTTPS, autenticación JWT con RBAC. El técnico de terreno NO puede acceder a rutas de gestión ni crear OTs (respuesta HTTP 403 estricta).

## 3. ROLES DE INTELIGENCIA ARTIFICIAL EN CODESPACES / COPILOT
El entorno de desarrollo operará bajo un modelo dual de IA:

### ROL 1: GEMINI (Lead Developer & System Architect)
- **Función:** Generación rápida y estructurada de código en TypeScript, creación de componentes UI React/React Native, esquemas Mongoose y llamadas a PowerSync SDK.
- **Enfoque:** Escribir código limpio, modular, optimizado para React Native y responsive para Web, siguiendo las definiciones Gherkin del Sprint 2.

### ROL 2: CLAUDE (Senior Technical Auditor & QA Specialist)
- **Función:** Revisión de código generado, verificación de seguridad RBAC, validación de criterios Gherkin, manejo de casos de borde offline/online y transacciones ACID.
- **Enfoque:** Auditar que las funciones async manejen excepciones, que no haya fugas de datos entre tenants (`tenant_id`), y que el Definition of Done (DoD) se cumpla al 100%.

## 4. ESTRUCTURA DEL MONOREPO
```
proyecto-sigma/
├── docs/
│   └── sigma_arquitectura_y_prompt_maestro.md
├── backend/
│   ├── src/
│   │   ├── config/ (database.ts, powersync.ts)
│   │   ├── controllers/
│   │   ├── middlewares/ (auth.ts, rbac.ts, tenant.ts)
│   │   ├── models/ (MongoDB Schemas: Anomaly, WorkOrder, Audit, Tenant)
│   │   ├── routes/
│   │   └── services/ (PowerSyncService, AuditService, AIService)
│   └── package.json
├── web/ (Panel Supervisor y Bodega)
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/ (usePowerSync, useAuth)
│   │   ├── pages/ (AnomaliesPage.tsx, WorkOrdersPage.tsx)
│   │   └── repositories/
│   └── package.json
└── mobile/ (App Técnico Terreno - Offline First)
    ├── src/
    │   ├── components/ (BotonIndustrial.tsx -> min 48x48px)
    │   ├── database/ (powerSyncSchema.ts)
    │   ├── repositories/
    │   ├── screens/ (ScanQRScreen.tsx, ReportAnomalyScreen.tsx)
    │   └── services/ (OfflineQueueService.ts, CameraService.ts)
    └── package.json
```

## 5. DEFINITION OF DONE (DoD) PARA CADA TAREA
Antes de marcar cualquier tarea o historia como finalizada:
1. **Código:** Escrito en TypeScript sin advertencias de linter (`strict: true`).
2. **Escenarios Gherkin:** 100% validados para HU-02 (modo avión, guardado local SQLite, reintento sin duplicación) y HU-03 (creación de OT, denegación 403 a técnicos, log de auditoría).
3. **Multi-Tenant:** Todas las consultas a MongoDB Atlas incluyen `{ tenant_id }`.
4. **Ergonomía:** Interfaces móviles con botones de al menos $48 \times 48\text{ px}$.
5. **Git:** Commits limpios en ramas `feature/hu-02-anomalias` o `feature/hu-03-ots`.

## 6. PROMPT MAESTRO DE EJECUCIÓN (USAR EN CHAT DE COPILOT / IDE)
Copia y pega la siguiente instrucción al iniciar una sesión de desarrollo:

"Actúa como la dupla de desarrollo SIGMA: GEMINI como Desarrollador Principal y CLAUDE como Auditor de Calidad. 
Estamos trabajando en el Sprint 2 del Proyecto SIGMA. 
Requisitos clave:
1. Usar TypeScript con arquitectura limpia y Patrón Repositorio.
2. Móvil: React Native / Expo con PowerSync para SQLite local offline-first.
3. Backend: Node.js + Express con Mongoose conectado a MongoDB Atlas (Multi-tenant por tenant_id).
4. Web: React con Tailwind CSS para el panel supervisor.
5. RBAC estricto: El rol 'TECNICO' tiene denegado el acceso a la creación de OTs (HTTP 403).
6. Asistente IA: Integrar hooks para el SIGMA Copilot según el rol del usuario autenticado.

Genera el código solicitado asegurando que cumpla los escenarios Gherkin de las HU-02 y HU-03, e indica la auditoría de seguridad realizada por Claude al final del bloque."
```

---

## 5. Cronograma de Integración para el Cierre de Sprint 2

| Hito / Fecha | Entregable Técnico | Validación QA (Gherkin) | Responsable |
| :--- | :--- | :--- | :--- |
| **20 Nov** | Abstracción con Repositorio y esquema local PowerSync en App Móvil. | Prueba de captura sin red ($< 2\text{ s}$) y compresión de foto. | Daniel Miranda / Gemini |
| **22 Nov** | API Backend Node.js con MongoDB Atlas, RBAC y middleware Multi-Tenant. | Prueba de denegación de permisos HTTP 403 y aislación por `tenant_id`. | Daniel Miranda / Claude |
| **24 Nov** | Panel Web Supervisor integrado con actualización reactiva vía PowerSync/Atlas. | Flujo extremo a extremo: Anomalía offline $\rightarrow$ Sync $\rightarrow$ OT creada. | Equipo Scrum Completo |
| **27 Nov (Hito 3)** | Demostración final del Mínimo Producto Viable (MPV) del Sprint 2 y presentación. | 100% Escenarios Gherkin validados y DoD firmado. | Leonor B. / Cristina E. / Daniel M. |

---