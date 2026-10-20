# Notificaciones y alertas críticas

Qué hace hoy el sistema, qué depende de permisos de Apple/Google y qué hacer cuando falla.

## Cadena de entrega y qué sabemos en cada punto

| Paso | Registro | ¿Confirma que el voluntario la vio? |
| --- | --- | --- |
| Alerta creada | `emergency_recipients.status = pending_send` | No |
| Expo acepta la petición | `notification_deliveries.status = provider_accepted`, alerta → `sent` | **No** |
| Recibo de Expo: APNs/FCM aceptó | `platform_accepted` | **No**: solo que la plataforma la tiene |
| La app muestra la alerta | `mark_alert_opened` → `opened` | **Sí** |
| Responde | `accepted` / `declined` | Sí |

Errores registrados: `provider_error` (red, 5xx, credenciales), `platform_error` (p. ej. `DeviceNotRegistered`: el token se revoca solo), `no_token` (sin dispositivo).

## Configuración por plataforma

### Android

- Canal `emergency-alerts` con importancia máxima (`MAX`), sonido `emergency.wav`, vibración y visibilidad pública en pantalla de bloqueo. Lo crea la app al arrancar (`apps/mobile/src/notifications.ts`). En Android 8+ el sonido es del canal: si se cambia, hay que crear un canal nuevo.
- Mensajes con `priority: high` (FCM de alta prioridad, despierta el dispositivo en Doze).
- **No** se usa `USE_FULL_SCREEN_INTENT`: desde Android 14, Google Play solo lo concede por defecto a apps de llamadas y alarmas. Una app de coordinación de voluntarios probablemente no encaja; pedirlo sin justificación arriesga el rechazo en Play.
- **No** se pide acceso a "No molestar" (`ACCESS_NOTIFICATION_POLICY`). Cada voluntario puede marcar Guardia como excepción en su modo No molestar; la app lo explica en Preferencias.

### iOS

- Categoría `emergency_response` con acciones "SÍ, ACUDO" y "NO PUEDO ACUDIR".
- `interruptionLevel: time-sensitive`. Requiere la capacidad *Time Sensitive Notifications* en el App ID, sin aprobación previa de Apple. Rompe el resumen programado y los Modos de Concentración que lo permitan, pero **no** suena con el interruptor de silencio activado.
- **Alertas críticas** (`interruptionLevel: critical`, sonido aunque el iPhone esté en silencio o en No molestar):
  - Requieren el entitlement `com.apple.developer.usernotifications.critical-alerts`, que Apple concede caso por caso a apps de salud, seguridad o emergencias tras una solicitud. Hay que justificar el uso, y los desarrolladores reportan esperas de semanas.
  - Tras la concesión: añadir el entitlement (`apps/mobile/app.config.ts`, marcado como opcional), pedir el permiso `allowCriticalAlerts` al usuario y activar `critical_alerts_enabled` en la configuración de la organización. El servidor solo marca como críticas las emergencias de prioridad **crítica**.
  - El usuario puede rechazarlo o retirarlo en Ajustes.
  - Hasta tenerlo, **la alternativa funcional** es: time-sensitive + recordatorios + llamada telefónica desde el panel.

## Reintentos

- Petición a Expo: hasta 3 intentos con espera exponencial ante red caída, 429 o 5xx. Un 4xx (credenciales) no se reintenta y queda registrado.
- Recordatorios automáticos (`dispatch` → `sweep`, cada minuto): a quien sigue sin contestar, cada `resend_interval_seconds` (por defecto 120 s), hasta `max_resends` (por defecto 3). Si un envío falló sin llegar al proveedor, se reintenta en la siguiente pasada.
- Reenvío manual desde el panel (`resend`).
- Límite de Expo: 600 notificaciones/segundo por proyecto. Muy por encima de lo que necesita una organización.

## Plan B cuando falla el push

El panel de la emergencia separa a las personas en:

1. **Sin dispositivo** (`no_token`): nunca le llegará un push. Hay que llamar.
2. **Envío fallido** (`provider_error` / `platform_error`).
3. **Sin respuesta** tras N minutos.

Cada fila tiene botón de llamada (`tel:`) y **"Registrar contacto"** (`log_manual_contact`), que queda en el historial. Si el proveedor falla del todo (muchos `provider_error`), el panel muestra un aviso para activar el procedimiento alternativo de la organización (cadena telefónica, grupo de mensajería). **Ese procedimiento debe existir por escrito, fuera de esta app.**

## Qué falta por probar (requiere dispositivos y cuentas reales)

- [ ] Entrega en iPhone real con la app cerrada, en silencio, con Concentración activa y en modo bajo consumo.
- [ ] Entrega en Android de varios fabricantes (Samsung, Xiaomi y Pixel como mínimo) con ahorro de batería.
- [ ] Acciones de la notificación con la app terminada (iOS y Android).
- [ ] Tiempos reales de extremo a extremo (activación → sonido) con 1, 10 y 50 destinatarios.
- [ ] Solicitud del entitlement de alertas críticas a Apple.
