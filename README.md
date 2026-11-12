# SIGMA-V3
SIGMA — Sistema híbrido (Web/Móvil) de Gestión de Mantenimiento Industrial con arquitectura offline-first, captura de anomalías en terreno con fotos y gestión de OTs con RBAC. Proyecto de Ingeniería de Requisitos (RQY1101) - Duoc UC.

## Backend

El backend Express está en `apps/backend`. Para ejecutarlo localmente, copia
`.env.example` a `.env`, configura `MONGODB_URI` y un `JWT_SECRET` aleatorio de
al menos 32 caracteres, instala las dependencias con `pnpm install` y ejecuta
`pnpm dev`. MongoDB debe ser un replica set (por ejemplo, MongoDB Atlas) para
que la creación y modificación de órdenes de trabajo y sus eventos de auditoría
se confirmen en una misma transacción.

Para poblar una organización de demostración, define `SEED_PASSWORD` en `.env`
y ejecuta `pnpm --filter backend seed`. El seed crea el tenant
`org_sigma_demo`, cuatro usuarios (`tecnico@sigma.demo`, `supervisor@sigma.demo`,
`bodega@sigma.demo`, `gerencia@sigma.demo`) y tres activos con códigos QR de
prueba; todos los usuarios reciben la contraseña definida en `SEED_PASSWORD`.
Configura `POWERSYNC_URL` y `POWERSYNC_PRIVATE_KEY` para habilitar la emisión de
tokens de PowerSync, y `GEMINI_API_KEY` para habilitar SIGMA Copilot.
