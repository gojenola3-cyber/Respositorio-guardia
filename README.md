# Guardia

Plataforma para equipos de voluntarios de emergencias: guardias, disponibilidad, agenda compartida y **activación de emergencias** con aviso a los voluntarios seleccionados, recogida de respuestas y localización temporal de quien acude hasta la base.

> ⚠️ **Herramienta de coordinación interna. No sustituye al 112 ni a los sistemas oficiales de despacho de emergencias.** No está lista para operaciones reales hasta superar las pruebas en dispositivos y de fiabilidad descritas en [`docs/NOTIFICACIONES.md`](docs/NOTIFICACIONES.md) y la revisión de [`docs/PRIVACIDAD-RGPD.md`](docs/PRIVACIDAD-RGPD.md).

## Estado

| Componente | Estado |
| --- | --- |
| Base de datos Supabase (esquema, RLS, RPC, historial, auditoría, retención) | ✅ Implementado y **probado contra PostgreSQL 16**: 151 comprobaciones |
| Envío de avisos (Expo Push: lotes, reintentos, recibos, recordatorios) | ✅ Lógica probada con proveedor simulado: 11 tests |
| Lógica compartida (`packages/core`: estados, i18n es/eu, selección, ETA) | ✅ Probada: 9 tests; tipos comprobados |
| Edge Function `dispatch` | 🟡 Tipos comprobados con `tsc`; **sin ejecutar en Deno** |
| Panel web Next.js (13 pantallas) | 🟡 Código escrito; **sin instalar ni compilar** |
| App móvil Expo (11 pantallas) | 🟡 Código escrito; **sin instalar ni compilar ni probar en dispositivos** |

El entorno donde se ha desarrollado no tenía acceso al registro de npm: Expo, Next.js, supabase-js y la CLI de Supabase no se han podido instalar. Lo marcado con 🟡 necesita `npm install`, compilación y corrección de los errores que aparezcan. Detalle en [`TASKS.md`](TASKS.md).

## Estructura

```
.
├── supabase/
│   ├── migrations/          # esquema, seguridad (RLS), RPC, auditoría/retención
│   ├── functions/
│   │   ├── _shared/         # lógica de envío (probada con node --test)
│   │   └── dispatch/        # Edge Function: activar, reenviar, cancelar, sweep
│   ├── tests/               # pruebas SQL de permisos y flujos
│   ├── config.toml          # CLI de Supabase (local)
│   └── seed.sql
├── packages/core/           # TypeScript compartido (sin dependencias)
├── apps/
│   ├── web/                 # Panel de responsables (Next.js)
│   └── mobile/              # App de voluntarios (Expo / React Native)
├── scripts/test-db.sh       # ejecuta las pruebas SQL en una base desechable
├── docs/                    # notificaciones, RGPD, despliegue, costes
├── ARCHITECTURE.md          # decisiones técnicas
└── TASKS.md                 # trabajo hecho y pendiente
```

## Tecnologías

Supabase (PostgreSQL, Auth, Realtime, Edge Functions) · Expo Push → APNs/FCM · React Native + Expo Router · Next.js App Router + `@supabase/ssr` · Leaflet con proveedor de teselas configurable · TypeScript estricto. Justificación en [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Pruebas

Requisitos: Node ≥ 22.18 (ejecuta TypeScript sin compilar) y PostgreSQL 15+ con `psql`/`createdb`.

```bash
npm run test:unit                 # core + lógica de envío (20 tests)
PGUSER=postgres npm run test:db   # 151 comprobaciones SQL en una base temporal
npm run typecheck                 # tsc sobre core y Edge Functions
```

Las pruebas SQL cubren, entre otras: un voluntario no accede a funciones de administración ni puede hacerse admin; nadie ve datos de otra organización; los elegibles salen seleccionados por defecto; excluir antes de enviar; solo los destinatarios ven la alerta; aceptar y rechazar; el panel refleja las respuestas; sin aceptación y autorización no hay ubicación; cerrar detiene el seguimiento; inscripciones duplicadas y solapadas rechazadas; una petición repetida no duplica alertas; historial inmutable; caducidad y purga de ubicaciones.

## Puesta en marcha (desarrollo)

```bash
npm install                       # instala los workspaces
npx supabase start                # pila local en Docker (aplica migrations y seed)
cp .env.example apps/web/.env.local     # rellena con la URL y anon key que imprime supabase start
cp .env.example apps/mobile/.env
npx supabase functions serve dispatch --no-verify-jwt --env-file .env

npm run dev -w @guardia/web       # panel en http://localhost:3000
npm run start -w @guardia/mobile  # Expo (las notificaciones push necesitan un build en un móvil real)
```

**Primer arranque**: crea una cuenta en el panel → "Crear una organización nueva" → quedas como admin → Configuración (bases y especialidades) → Voluntarios → invitar. Cada voluntario abre el enlace de invitación o pega el código en la app.

## Supabase, notificaciones y móviles

- **Supabase en producción**: [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) §1 (región UE, plan Pro, `db push`, secretos, pg_cron + pg_net para recordatorios).
- **Notificaciones push**: [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) §3 (EAS, claves APNs y FCM v1) y [`docs/NOTIFICACIONES.md`](docs/NOTIFICACIONES.md) (alertas time-sensitive y críticas, canales Android, plan B).
- **Probar en iPhone**: build `eas build --profile preview --platform ios` → TestFlight o instalación interna; permitir notificaciones y ubicación "Mientras se usa"; probar con la app cerrada, en silencio y con Concentración.
- **Probar en Android**: build `preview` (APK interno); comprobar el canal "Alertas de emergencia" en Ajustes → Notificaciones; probar con ahorro de batería en varios fabricantes.

## Costes

Infraestructura ≈ **25-45 $/mes** para operar con fiabilidad (Supabase Pro). Más Apple Developer (99 $/año) y Google Play (25 $ una vez). Sin coste por usuario. Detalle y fuentes en [`docs/COSTES.md`](docs/COSTES.md).

## Riesgos abiertos

1. Entrega real de avisos en iOS y Android sin probar: hacen falta dispositivos, cuentas de Apple y Google y un proyecto EAS.
2. Sin alertas críticas de Apple, un iPhone en silencio no suena. Mitigación: time-sensitive, recordatorios y llamada.
3. El seguimiento GPS es en primer plano: con el móvil bloqueado se detiene. La app lo advierte y ofrece navegación externa.
4. Los clientes no se han compilado: habrá errores de integración al instalar dependencias.
5. Revisión jurídica (EIPD, encargados del tratamiento) pendiente.
