# Instrucciones permanentes de desarrollo - SIGMA

## Arquitectura y seguridad

- SIGMA es una plataforma SaaS multi-tenant. `tenant_id` es obligatorio en cada registro y consulta de dominio; nunca se debe confiar en un tenant enviado libremente por el cliente.
- Toda lectura o escritura debe quedar limitada al `tenant_id` autenticado. Los índices de MongoDB deben comenzar por `tenant_id`.
- La autorización se aplica en el backend con RBAC de mínimo privilegio. Los roles del sistema son Técnico, Supervisor, Bodega y Gerencia; la matriz compartida es la fuente central de permisos. Un Técnico no puede crear órdenes de trabajo.
- Las funciones offline-first deben usar el patrón Repositorio para desacoplar la interfaz del almacenamiento. PowerSync administra la persistencia local y la sincronización; los cambios no deben depender de una conexión disponible para guardarse localmente.
- Nunca sincronizar datos de otro tenant. Los parámetros de sincronización deben derivarse de la identidad autenticada, no de parámetros de cliente sin validar.
- Los registros de auditoría son append-only. Bloquear modificaciones y eliminaciones en la aplicación y reforzar la inmutabilidad con permisos de base de datos.

## Desarrollo

- Usar TypeScript estricto, validación de datos con Zod y paquetes compartidos cuando los contratos se usen en más de una aplicación.
- Mantener los modelos, consultas y reglas de sincronización tenant-scoped; incluir pruebas para denegaciones RBAC y aislamiento entre tenants.
- Seguir el patrón Repositorio en las capas de acceso a datos y mantener la lógica de negocio fuera de la UI.

## Roles de IA

- **Gemini** es el desarrollador principal y arquitecto del sistema: implementa las historias siguiendo los contratos y decisiones de arquitectura de SIGMA.
- **Claude** actúa como auditor de seguridad y QA: revisa RBAC, aislamiento multi-tenant, casos offline/online, criterios de aceptación y manejo de errores.
