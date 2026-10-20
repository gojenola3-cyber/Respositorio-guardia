# Tareas

Estado real del proyecto. ✅ hecho y probado · 🟡 hecho sin poder probar aquí · ⬜ pendiente.

## Fase 1 · Base del proyecto
- ✅ Inspección del entorno (sin acceso a npm: no se pueden instalar Expo, Next.js, supabase-js ni la CLI de Supabase).
- ✅ Monorepo: `supabase/`, `packages/core`, `apps/` (web y móvil).
- ✅ TypeScript estricto compartido (`tsconfig.base.json`).
- ✅ Variables de entorno de ejemplo (`.env.example`).
- ✅ Decisiones técnicas (`ARCHITECTURE.md`).
- ✅ Migraciones de Supabase y configuración de la CLI (`supabase/config.toml`).
- ⬜ ESLint con typescript-eslint y Prettier en CI (necesita npm).
- ⬜ CI (GitHub Actions) que ejecute `npm test` con un servicio PostgreSQL.

## Fase 2 · Producto básico
- ✅ Organizaciones, roles, invitaciones con token de un solo uso ligado al correo, solicitud de alta con aprobación.
- ✅ Perfiles con datos mínimos y directorio sin datos de contacto.
- ✅ Cualificaciones con caducidad.
- ✅ Guardias: inscripción, duplicados, solapes, plazas, completa/abierta, cobertura mínima, confirmación.
- ✅ Agenda: eventos de 7 tipos, inscripción con plazas, cancelación, vista unificada con guardias.
- ⬜ Avisos push de cambios y cancelaciones de la agenda (el canal existe; falta el disparador).
- ⬜ Exportación iCal de la agenda (endpoint de suscripción con token por usuario).
- 🟡 Pantallas del panel web y de la app (ver Fase 4).

## Fase 3 · Emergencias
- ✅ Candidatos con elegibilidad (guardia, disponibilidad, cualificaciones vigentes) y motivo.
- ✅ Elegibles seleccionados por defecto; exclusión individual con motivo privado; incluir no elegibles.
- ✅ Creación idempotente (doble pulsación) con registro de destinatarios y exclusiones.
- ✅ Alertas individuales con ciclo de vida y transiciones validadas en base de datos.
- ✅ Respuesta Sí/No, cambio de opinión, llegada a la base.
- ✅ Recuentos y estado en tiempo real (tablas en la publicación de Realtime).
- ✅ Cierre y cancelación con aviso a los afectados.
- ✅ Historial inmutable con autor y hora; auditoría administrativa.
- ✅ Reenvío manual y registro de contacto alternativo.

## Fase 4 · GPS, notificaciones y clientes
- ✅ Consentimiento de ubicación por activación; solo la última posición; caducidad; borrado automático.
- ✅ Envío Expo Push con lotes, reintentos, tickets, recibos y revocación de tokens caducados.
- ✅ Recordatorios automáticos con intervalo y límite.
- 🟡 Edge Function `dispatch` (tipos comprobados con tsc; sin ejecutar en Deno).
- 🟡 Panel web Next.js (código escrito, sin instalar ni compilar).
- 🟡 App móvil Expo (código escrito, sin instalar ni compilar).
- ⬜ Pruebas en dispositivos reales iOS y Android (ver `docs/NOTIFICACIONES.md`).
- ⬜ Seguimiento en segundo plano (expo-task-manager) tras validar el primer plano en dispositivos.
- ⬜ Solicitud del entitlement de alertas críticas a Apple.

## Fase 5 · Seguridad y pruebas
- ✅ RLS en todas las tablas; privilegios por defecto de Supabase retirados.
- ✅ 151 comprobaciones SQL (4 ficheros) y 20 tests TypeScript.
- ⬜ Repetir las pruebas SQL en la pila real (`supabase start` + `supabase test db`).
- ⬜ Pruebas de extremo a extremo (Playwright para el panel, Maestro o Detox para la app).
- ⬜ Prueba de carga de la activación (50+ destinatarios).
- ⬜ Revisión de dependencias (`npm audit`) cuando se instalen.

## Fase 6 · Despliegue
- ✅ Guía de despliegue, costes, notificaciones y RGPD (`docs/`).
- ⬜ Proyecto Supabase en región UE (plan Pro) y `db push`.
- ⬜ Programar `sweep` con pg_cron + pg_net.
- ⬜ Builds EAS de prueba (TestFlight y prueba interna de Play).
- ⬜ Revisión jurídica y EIPD (`docs/PRIVACIDAD-RGPD.md`).
- ⬜ Procedimiento alternativo de aviso escrito por la organización.
- ⬜ Pantalla de admin para anonimizar miembros (la función ya existe).
