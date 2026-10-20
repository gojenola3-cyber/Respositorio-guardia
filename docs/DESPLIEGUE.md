# Despliegue

Pasos para poner Guardia en marcha. Lo marcado con ⚠️ no se ha podido ejecutar en el entorno de desarrollo y hay que verificarlo en el primer despliegue real.

## 1. Supabase

1. Crea un proyecto en <https://supabase.com> en una **región de la UE** (p. ej. Frankfurt). Para uso operativo, plan **Pro**: los proyectos gratuitos se pausan tras unos 7 días sin actividad (ver `COSTES.md`).
2. Instala la CLI de Supabase y vincula el proyecto:
   ```bash
   npx supabase login
   npx supabase link --project-ref <ref-del-proyecto>
   npx supabase db push            # aplica supabase/migrations
   ```
3. Activa las extensiones **pg_cron** y **pg_net** (Database → Extensions). Si activas pg_cron después de aplicar las migraciones, programa la purga a mano:
   ```sql
   select cron.schedule('guardia-retention', '*/15 * * * *', 'select private.run_retention()');
   ```
4. Auth (Authentication → Providers / URL Configuration):
   - Email con confirmación activada.
   - `Site URL`: la URL del panel web. Redirecciones: `https://<panel>/auth/callback` y `guardia://auth/callback`.
   - Revisa los límites de frecuencia y, para producción, configura un SMTP propio (el de Supabase está muy limitado).
5. Secretos de la Edge Function y despliegue:
   ```bash
   npx supabase secrets set CRON_SECRET="$(openssl rand -hex 32)" \
     ALLOWED_ORIGINS="https://<panel>" EXPO_ACCESS_TOKEN="<opcional>"
   npx supabase functions deploy dispatch --no-verify-jwt
   ```
6. ⚠️ Programa los recordatorios y recibos cada minuto (SQL Editor). Los secretos se guardan en Vault, no en el texto del cron:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/dispatch', 'dispatch_url');
   select vault.create_secret('<el mismo CRON_SECRET>', 'dispatch_cron_secret');

   select cron.schedule('guardia-dispatch-sweep', '* * * * *', $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_url'),
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
       ),
       body := '{"action":"sweep"}'::jsonb
     )
   $$);
   ```
7. Primer administrador: regístrate en el panel web y crea la organización (pantalla de alta). Quien la crea queda como admin y desde ahí invita al resto.

## 2. Panel web (Next.js)

⚠️ Pendiente de instalar y compilar (ver TASKS.md).

- Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_MAP_TILE_URL`, `NEXT_PUBLIC_MAP_ATTRIBUTION`.
- Alojamiento: Vercel, Netlify o Cloudflare. **Revisa las condiciones del plan gratuito**: el plan Hobby de Vercel es para uso personal y no comercial. Para una organización, valora un plan de pago o un proveedor cuyo plan gratuito lo permita.
- Mapa: `tile.openstreetmap.org` **no** sirve para producción (política de uso: no admite aplicaciones distribuidas sin permiso, sin SLA). Usa un proveedor con clave restringida por dominio y cambia la variable de entorno.

## 3. App móvil (Expo / EAS)

⚠️ Pendiente de instalar y compilar (ver TASKS.md).

```bash
cd apps/mobile
npx expo install --fix         # alinea versiones con el SDK de Expo instalado
npx eas init                   # crea el proyecto EAS → EXPO_PUBLIC_EAS_PROJECT_ID
npx eas credentials            # claves APNs (iOS) y FCM v1 (Android)
npx eas build --profile preview --platform all
```

- **iOS**: cuenta Apple Developer (de organización, para publicar como la entidad). En el App ID: Push Notifications y Time Sensitive Notifications. El entitlement de alertas críticas solo se añade tras la aprobación de Apple.
- **Android**: proyecto de Firebase para FCM; sube la clave de cuenta de servicio FCM v1 a EAS (`eas credentials`). Cuenta de Google Play Console.
- **Distribución interna** antes de las tiendas: TestFlight (iOS) y prueba interna de Play (Android).
- Si se activa el seguimiento en segundo plano: Google Play exige la declaración de ubicación en segundo plano con vídeo, y App Store Review pide justificarlo en la descripción y en el texto del permiso.
