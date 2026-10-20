# Arquitectura

Decisiones técnicas de Guardia y por qué. Se actualiza cuando cambia una decisión.

> Guardia es una herramienta de coordinación interna. **No sustituye al 112 ni a los sistemas oficiales de despacho.**

## 1. Visión general

```
┌──────────────────────┐   ┌──────────────────────┐
│ App móvil (Expo, RN) │   │ Panel web (Next.js)  │
│ voluntarios          │   │ responsables/admins  │
└─────────┬────────────┘   └──────────┬───────────┘
          │ supabase-js (JWT del usuario)       │
          ▼                                     ▼
┌────────────────────────────────────────────────────────┐
│ Supabase                                               │
│  Auth ─ PostgREST ─ Realtime ─ Edge Function "dispatch"│
│                 PostgreSQL                             │
│   RLS en todas las tablas · RPC security definer       │
│   historial inmutable · auditoría · retención (cron)   │
└───────────────────────┬────────────────────────────────┘
                        │ Expo Push API (solo servidor)
                        ▼
                APNs (iOS) / FCM (Android)
```

| Pieza | Elección | Motivo |
| --- | --- | --- |
| Backend | Supabase (PostgreSQL + Auth + Realtime + Edge Functions) | Una sola pieza gestionada; la seguridad se expresa en SQL (RLS) y se prueba contra PostgreSQL real; región UE disponible; coste bajo y predecible. |
| Lógica sensible | Funciones RPC `security definer` en PostgreSQL | Validación y permisos junto a los datos, en una transacción. Ningún cliente puede saltárselas: no hay permisos de escritura directa en las tablas críticas. |
| Envío de avisos | Edge Function `dispatch` + Expo Push | Credenciales solo en servidor. Expo unifica APNs y FCM, es gratuito y devuelve tickets y recibos que se registran. |
| App móvil | React Native + Expo (TypeScript) | Una base de código para iOS y Android; notificaciones, ubicación y almacenamiento seguro con módulos mantenidos; builds en la nube (EAS) sin Mac propio. |
| Panel web | Next.js (App Router, TypeScript) | Responsive, render en servidor y protección de rutas en servidor con `@supabase/ssr`. |
| Lógica compartida | `packages/core` (TypeScript sin dependencias) | Estados, textos (es/eu), selección de destinatarios, ETA y validaciones idénticos en móvil, web y servidor. |
| Mapas | Leaflet en el panel con plantilla de teselas configurable; en el móvil, navegación externa | Sin claves privadas en el cliente; se cambia de proveedor con una variable de entorno. |

## 2. Modelo de datos

Migraciones en `supabase/migrations/`, en orden:

1. `…0100_schema.sql`: tipos, tablas, claves, índices y disparadores comunes.
2. `…0200_security.sql`: funciones de permisos, privilegios y políticas RLS.
3. `…0300_rpc.sql`: operaciones de negocio (RPC), reglas de estado y vistas.
4. `…0400_audit_realtime_retention.sql`: auditoría automática, Realtime y purga.

Entidades principales (todas con `created_at`/`updated_at` cuando aplica):

| Tabla | Para qué |
| --- | --- |
| `organizations`, `organization_settings` | Organización y parámetros (elegibilidad, reintentos, retención, alertas críticas). |
| `profiles` | Datos personales mínimos (1:1 con `auth.users`). |
| `organization_members` | Rol (`admin`/`responsable`/`voluntario`), estado (`pending`/`active`/`suspended`/`deactivated`), código interno y disponibilidad declarada. |
| `invitations` | Invitaciones; solo se guarda el hash del token. |
| `bases` | Bases y ubicaciones operativas. |
| `qualifications`, `member_qualifications` | Especialidades y acreditaciones con caducidad. |
| `shifts`, `shift_signups` | Guardias e inscripciones (inscrito / confirmada / cancelada). |
| `events`, `event_signups` | Agenda: servicios, prácticas, formación, reuniones, eventos, mantenimiento. |
| `emergencies`, `emergency_required_qualifications` | Activación, requisitos y clave de idempotencia. |
| `emergency_recipients` | Una alerta individual por destinatario con su ciclo de vida. |
| `emergency_exclusions` | Candidatos que no recibieron la alerta y el motivo (privado). |
| `emergency_status_events` | Historial inmutable: quién, qué y cuándo. |
| `location_updates` | **Solo la última posición** por destinatario, con caducidad. |
| `push_tokens`, `notification_deliveries` | Dispositivos y cada intento de envío con su resultado. |
| `audit_logs` | Cambios administrativos (sin datos personales ni coordenadas). |

Reglas de integridad destacables:

- **Claves foráneas compuestas `(org_id, id)`**: una inscripción, alerta o posición no puede apuntar a una fila de otra organización aunque falle una comprobación en el código.
- **Únicos parciales**: una persona no puede tener dos inscripciones vivas en la misma guardia o evento.
- **Estados controlados**: tipos enumerados y un disparador que solo permite transiciones válidas en `emergency_recipients`, también para `service_role`.
- `check (not location_consent or status in ('accepted','en_route'))`: imposible tener consentimiento de ubicación sin haber aceptado.
- **Borrado**: al borrar una organización se borra todo en cascada. Las alertas de una persona usan `on delete restrict`: su historial no desaparece por borrar la cuenta. Para el derecho de supresión se anonimiza el perfil (ver `docs/PRIVACIDAD-RGPD.md`).

## 3. Seguridad

- **anon** no tiene acceso a ninguna tabla ni función.
- **authenticated** solo lee lo que permite la RLS y solo escribe directamente en guardias y agenda (responsables), bases y cualificaciones (admins), configuración (admins) y su propio perfil (columnas concretas). Todo lo demás pasa por RPC.
- Las funciones de permisos (`private.is_member`, `is_manager`, `is_admin`, …) viven en el esquema `private`, que la API no expone.
- **Un voluntario no puede convertirse en responsable**: no tiene `UPDATE` sobre `organization_members` y la RPC `set_member_role` exige ser admin de esa organización. Está probado (`supabase/tests/01_access.test.sql`).
- **Ubicaciones**: solo las ven el propio voluntario y los responsables/admins de su organización, solo si aceptó y autorizó, y dejan de verse al caducar aunque la purga no haya corrido.
- **Directorio**: los voluntarios ven a los demás como "Nombre I." mediante `member_directory()`. Correo y teléfono solo los ven responsables y admins.
- **Errores**: las RPC devuelven claves (`forbidden`, `shift_full`, …) sin detalles internos. La Edge Function no registra tokens, coordenadas ni datos personales.
- **Límites de frecuencia**: posiciones (máximo 1 cada 3 s por destinatario), invitaciones (100/h por organización), creación de organizaciones (3/día por usuario), además de los límites de Supabase Auth.

## 4. Activación de emergencias

```
Responsable                 PostgreSQL                         Edge Function           Expo/APNs/FCM
    │ get_emergency_candidates ─▶ elegibles = marcados por defecto
    │ (desmarca, revisa, confirma)
    │ POST dispatch {activate, idempotency_key, recipients}
    │ ───────────────────────────────────────────────────────▶│
    │                           ◀── rpc create_emergency (JWT)│  permisos aquí
    │                           emergencia + alertas pending_send + exclusiones + historial
    │                                                         │── send (lotes de 100) ──▶
    │                           ◀── deliveries (ticket ok/error), alertas → sent
    │◀── {emergencyId, delivery: accepted/failed/noDevice/unreachable}
    │ Realtime: emergency_recipients / notification_deliveries
```

- **Idempotencia**: el cliente genera `idempotency_key` al abrir el formulario. Repetir la petición (doble pulsación, reintento de red) devuelve la misma emergencia y no reenvía la alerta inicial.
- **Destinatarios**: todos los elegibles empiezan marcados. Elegible significa activo, de guardia o disponible según `eligibility_mode`, y con las cualificaciones vigentes requeridas. El responsable puede desmarcar a cualquiera (con motivo privado opcional) e incluso incluir a alguien no elegible: la decisión final es suya y queda registrada (`eligible_at_selection`, `emergency_exclusions`).
- **Recordatorios**: `dispatch` con `action: sweep`, llamada cada minuto por pg_cron + pg_net, reenvía a quien sigue sin contestar según `resend_interval_seconds` y `max_resends`, y consulta los recibos.

### Estados de cada alerta

| Estado | Significa | Quién lo pone |
| --- | --- | --- |
| `pending_send` | Creada; aún no aceptada por el proveedor (o falló el envío) | Sistema |
| `sent` | **Expo aceptó la petición.** No confirma que el móvil la recibiera | Sistema |
| `opened` | La app confirmó que la persona abrió la alerta | App |
| `accepted` | Acude | Voluntario |
| `declined` | No acude (puede cambiar a `accepted` mientras siga activa) | Voluntario |
| `en_route` | Acude y está enviando posición | Sistema (primera posición) |
| `arrived` | En la base | Voluntario o responsable |
| `cancelled` | Activación cancelada | Responsable |

Por separado, `notification_deliveries` registra cada intento: `provider_accepted` (ticket ok), `provider_error`, `platform_accepted` (recibo: APNs/FCM lo aceptó), `platform_error`, `no_token`, `manual_contact`. **Ningún estado del proveedor se presenta como "recibida"**: solo `opened` lo confirma.

## 5. Seguimiento GPS

- Solo con `accepted`/`en_route` **y** consentimiento explícito por activación (`set_location_consent`).
- Se guarda **una fila por destinatario** que se sobrescribe; no hay recorrido histórico.
- Se borra al rechazar, llegar, retirar el permiso, cancelar o cerrar (lo hace un disparador, valga el camino que valga). Caduca sola en `location_retention_minutes` (por defecto 12 h) y la RLS deja de mostrarla en ese momento.
- El panel marca cada posición como **actualizada** (< 2 min), **desfasada** (< 10 min) o **antigua**.

**Limitaciones reales**:

- **iOS**: con permiso "Mientras se usa" la posición solo se envía con la app en primer plano (o recién minimizada, con el indicador azul). Para seguir en segundo plano hace falta el permiso "Siempre" y el modo de fondo `location`. Aun así, iOS puede suspender la app; si el usuario la cierra a la fuerza, solo la despiertan los "cambios significativos" (unos 500 m). No se puede garantizar un seguimiento continuo.
- **Android**: el seguimiento en segundo plano exige un servicio en primer plano con notificación visible y el permiso de ubicación en segundo plano. Google Play pide una declaración y justificar el uso. Los ahorros de batería de algunos fabricantes pueden matar el servicio.
- Por eso la app siempre ofrece **abrir la ruta en Apple Maps, Google Maps o Waze** y el panel muestra la antigüedad de cada posición.

## 6. Notificaciones

Detalle y requisitos de plataforma en [`docs/NOTIFICACIONES.md`](docs/NOTIFICACIONES.md). Resumen:

- Canal Android `emergency-alerts` de importancia máxima con sonido propio; categoría iOS `emergency_response` con acciones "SÍ, ACUDO" / "NO PUEDO ACUDIR".
- iOS `interruptionLevel: time-sensitive` por defecto. `critical` (suena en silencio) solo si Apple concede el entitlement y la organización activa `critical_alerts_enabled`.
- Sin bucles de sonido ni trucos para saltarse el sistema. La insistencia se hace con recordatorios espaciados y limitados.
- Plan B: el panel destaca a quien no tiene dispositivo, a quien tiene el envío fallido y a quien no contesta, con botón de llamada y registro del contacto manual (`log_manual_contact`).

## 7. Tiempo real

Supabase Realtime (`postgres_changes`) sobre emergencias, alertas, posiciones, entregas, guardias, agenda y miembros. Realtime aplica la RLS de cada suscriptor. **No se depende de él**: la alerta llega por push (sin la app abierta), y los clientes recargan el estado al volver al primer plano y al reconectar.

## 8. Internacionalización

`packages/core/src/i18n.ts`: diccionario `es` completo y `eu` parcial, con recurso al castellano. Los errores del servidor son claves que se traducen en el cliente. `missingTranslations('eu')` lista lo pendiente.

## 9. Pruebas

| Capa | Cómo | Dónde |
| --- | --- | --- |
| Base de datos (RLS, RPC, estados, retención) | PostgreSQL real + réplica mínima de Supabase (`auth.uid()`, roles, privilegios por defecto) | `supabase/tests/*.test.sql`, `scripts/test-db.sh` |
| Envío de avisos | Node `--test` con proveedor simulado (fallos de red, 5xx, tokens caducados, recibos) | `supabase/functions/_shared/test` |
| Lógica compartida | Node `--test` | `packages/core/test` |

La réplica (`supabase/tests/support/supabase_stub.sql`) reproduce los privilegios por defecto de Supabase (todo concedido a `anon`/`authenticated`) para comprobar que las migraciones los retiran. Antes de producción conviene repetir las pruebas con `supabase start` + `supabase test db` sobre la pila real.

## 10. Decisiones descartadas

- **Firebase**: modelo documental, peor para relaciones e historial auditable; reglas de seguridad más difíciles de probar.
- **WebSockets propios para la alerta**: no despiertan un móvil con la app cerrada. El aviso tiene que ir por APNs/FCM.
- **SMS como canal principal**: coste por mensaje y dependencia de un proveedor comercial. Queda preparado (`delivery_channel = 'sms'`) como canal opcional de respaldo.
- **Guardar el recorrido GPS**: innecesario para la finalidad (saber quién llega y cuándo) y desproporcionado según el RGPD.
