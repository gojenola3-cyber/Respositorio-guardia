-- =============================================================================
-- Guardia · Esquema base
-- Organizaciones, miembros, cualificaciones, guardias, agenda, emergencias,
-- ubicaciones, notificaciones y auditoría.
--
-- Convenciones:
--  * Todas las tablas de una organización llevan org_id y una clave única
--    (org_id, id). Las relaciones entre ellas usan claves foráneas compuestas
--    (org_id, x_id): la base de datos impide enlazar filas de organizaciones
--    distintas aunque falle una comprobación en el código.
--  * Estados con tipos enumerados; fechas siempre timestamptz.
--  * El esquema "private" guarda funciones internas que la API no expone.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('admin', 'responsable', 'voluntario');
create type public.member_status as enum ('pending', 'active', 'suspended', 'deactivated');
create type public.availability_status as enum ('available', 'unavailable');
create type public.shift_status as enum ('open', 'full', 'closed', 'cancelled');
create type public.signup_status as enum ('signed_up', 'confirmed', 'cancelled');
create type public.event_type as enum ('service', 'practice', 'training', 'meeting', 'event', 'maintenance', 'other');
create type public.event_status as enum ('scheduled', 'cancelled', 'completed');
create type public.event_signup_status as enum ('signed_up', 'cancelled');
create type public.emergency_priority as enum ('low', 'medium', 'high', 'critical');
create type public.emergency_status as enum ('active', 'closed', 'cancelled');
-- Ciclo de vida de la alerta de cada destinatario. "sent" significa que el
-- proveedor de push aceptó la petición, NO que el móvil la haya recibido.
-- "opened" solo se marca cuando la app confirma que el voluntario la abrió.
create type public.recipient_status as enum (
  'pending_send', 'sent', 'opened', 'accepted', 'declined', 'en_route', 'arrived', 'cancelled'
);
create type public.exclusion_kind as enum ('manual', 'ineligible');
create type public.delivery_channel as enum ('expo_push', 'manual_call', 'sms', 'email');
create type public.delivery_kind as enum ('alert', 'reminder', 'cancellation', 'test');
create type public.delivery_status as enum (
  'queued',             -- registrado, aún sin respuesta del proveedor
  'provider_accepted',  -- Expo devolvió ticket "ok"
  'provider_error',     -- Expo rechazó o no respondió (red, 5xx)
  'platform_accepted',  -- el recibo de Expo confirma entrega a APNs/FCM
  'platform_error',     -- APNs/FCM rechazó (p. ej. token caducado)
  'no_token',           -- el voluntario no tiene ningún dispositivo registrado
  'manual_contact'      -- el responsable contactó por otro canal
);
create type public.device_platform as enum ('ios', 'android', 'web');

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function private.prevent_org_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'org_id_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function private.valid_coordinates(lat double precision, lng double precision) returns boolean
language sql immutable as $$
  select (lat is null and lng is null)
      or (lat between -90 and 90 and lng between -180 and 180)
$$;

-- ---------------------------------------------------------------------------
-- Organizaciones
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  -- Quién aparece como elegible por defecto al activar una emergencia.
  eligibility_mode text not null default 'on_shift_or_available'
    check (eligibility_mode in ('on_shift', 'available', 'on_shift_or_available', 'all_active')),
  -- Cuánto vive como máximo una posición GPS si nadie la borra antes.
  location_retention_minutes integer not null default 720 check (location_retention_minutes between 15 and 2880),
  resend_interval_seconds integer not null default 120 check (resend_interval_seconds between 60 and 3600),
  max_resends integer not null default 3 check (max_resends between 0 and 10),
  -- Solo activar cuando Apple haya concedido el entitlement de alertas críticas.
  critical_alerts_enabled boolean not null default false,
  time_zone text not null default 'Europe/Madrid',
  default_locale text not null default 'es' check (default_locale in ('es', 'eu')),
  delivery_log_retention_days integer not null default 180 check (delivery_log_retention_days between 7 and 3650),
  audit_retention_days integer not null default 730 check (audit_retention_days between 30 and 3650),
  emergency_retention_days integer not null default 1825 check (emergency_retention_days between 30 and 7300),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- ---------------------------------------------------------------------------
-- Perfiles (1:1 con auth.users) y miembros
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text not null default '' check (char_length(first_name) <= 80),
  last_name text not null default '' check (char_length(last_name) <= 120),
  email text,
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{6,20}$'),
  locale text not null default 'es' check (locale in ('es', 'eu')),
  -- Preferencias. Las alertas de emergencia no se pueden desactivar mientras
  -- se está de guardia; estas preferencias afectan a recordatorios y agenda.
  notify_shift_reminders boolean not null default true,
  notify_agenda_changes boolean not null default true,
  notify_email boolean not null default false,
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null default 'voluntario',
  status public.member_status not null default 'pending',
  internal_code text check (internal_code is null or char_length(internal_code) between 1 and 32),
  availability public.availability_status not null default 'unavailable',
  availability_updated_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id),
  unique (org_id, id)
);
create unique index organization_members_internal_code_key
  on public.organization_members (org_id, internal_code) where internal_code is not null;
create index organization_members_user_idx on public.organization_members (user_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.member_role not null default 'voluntario',
  -- Solo se guarda el hash. El token en claro se entrega una vez al crearla.
  token_hash text not null unique,
  invited_by uuid not null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index invitations_one_open_per_email
  on public.invitations (org_id, email) where accepted_at is null and revoked_at is null;

-- Bases y ubicaciones operativas
create table public.bases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  address text check (char_length(address) <= 240),
  lat double precision,
  lng double precision,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  check (private.valid_coordinates(lat, lng)),
  check ((lat is null) = (lng is null))
);
create unique index bases_one_default_per_org on public.bases (org_id) where is_default;

-- ---------------------------------------------------------------------------
-- Cualificaciones
-- ---------------------------------------------------------------------------
create table public.qualifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{2,24}$'),
  name text not null check (char_length(name) between 2 and 120),
  description text check (char_length(description) <= 1000),
  has_expiry boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, code),
  unique (org_id, id)
);

create table public.member_qualifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  member_id uuid not null,
  qualification_id uuid not null,
  obtained_on date,
  expires_on date,
  verified_by uuid,
  verified_at timestamptz,
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, qualification_id),
  foreign key (org_id, member_id) references public.organization_members (org_id, id) on delete cascade,
  foreign key (org_id, qualification_id) references public.qualifications (org_id, id) on delete cascade,
  check (expires_on is null or obtained_on is null or expires_on >= obtained_on)
);
create index member_qualifications_member_idx on public.member_qualifications (member_id);

-- ---------------------------------------------------------------------------
-- Guardias
-- ---------------------------------------------------------------------------
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  title text not null default 'Guardia' check (char_length(title) between 2 and 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  min_volunteers integer not null default 0 check (min_volunteers between 0 and 500),
  max_volunteers integer check (max_volunteers is null or max_volunteers between 1 and 500),
  status public.shift_status not null default 'open',
  responsable_member_id uuid,
  base_id uuid,
  notes text check (char_length(notes) <= 2000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, responsable_member_id) references public.organization_members (org_id, id) on delete set null (responsable_member_id),
  foreign key (org_id, base_id) references public.bases (org_id, id) on delete set null (base_id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '7 days'),
  check (max_volunteers is null or max_volunteers >= min_volunteers)
);
create index shifts_org_time_idx on public.shifts (org_id, starts_at);

create table public.shift_signups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  shift_id uuid not null,
  member_id uuid not null,
  status public.signup_status not null default 'signed_up',
  confirmed_by uuid,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, shift_id) references public.shifts (org_id, id) on delete cascade,
  foreign key (org_id, member_id) references public.organization_members (org_id, id) on delete cascade
);
-- Una persona no puede tener dos inscripciones vivas en la misma guardia.
create unique index shift_signups_active_key
  on public.shift_signups (shift_id, member_id) where status <> 'cancelled';
create index shift_signups_member_idx on public.shift_signups (member_id) where status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Agenda
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  type public.event_type not null,
  title text not null check (char_length(title) between 2 and 160),
  description text check (char_length(description) <= 4000),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location_text text check (char_length(location_text) <= 240),
  base_id uuid,
  organizer_member_id uuid,
  capacity integer check (capacity is null or capacity between 1 and 2000),
  status public.event_status not null default 'scheduled',
  notes text check (char_length(notes) <= 2000),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, base_id) references public.bases (org_id, id) on delete set null (base_id),
  foreign key (org_id, organizer_member_id) references public.organization_members (org_id, id) on delete set null (organizer_member_id),
  check (ends_at > starts_at)
);
create index events_org_time_idx on public.events (org_id, starts_at);

create table public.event_signups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  event_id uuid not null,
  member_id uuid not null,
  status public.event_signup_status not null default 'signed_up',
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, event_id) references public.events (org_id, id) on delete cascade,
  foreign key (org_id, member_id) references public.organization_members (org_id, id) on delete cascade
);
create unique index event_signups_active_key
  on public.event_signups (event_id, member_id) where status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- Emergencias
-- ---------------------------------------------------------------------------
create table public.emergencies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- Generado por el cliente al abrir el formulario: una doble pulsación o un
  -- reintento de red devuelve la misma emergencia en vez de crear otra.
  idempotency_key uuid not null,
  title text not null check (char_length(title) between 2 and 120),
  emergency_type text check (char_length(emergency_type) <= 60),
  description text check (char_length(description) <= 2000),
  address text check (char_length(address) <= 240),
  lat double precision,
  lng double precision,
  priority public.emergency_priority not null default 'high',
  activated_at timestamptz not null default now(),
  base_id uuid,
  notes text check (char_length(notes) <= 2000),
  status public.emergency_status not null default 'active',
  created_by uuid not null,
  created_by_member_id uuid not null,
  closed_at timestamptz,
  closed_by uuid,
  cancel_reason text check (char_length(cancel_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  unique (org_id, id),
  foreign key (org_id, base_id) references public.bases (org_id, id) on delete set null (base_id),
  foreign key (org_id, created_by_member_id) references public.organization_members (org_id, id) on delete restrict,
  check (private.valid_coordinates(lat, lng)),
  check ((lat is null) = (lng is null)),
  check ((status = 'active') = (closed_at is null))
);
create index emergencies_org_status_idx on public.emergencies (org_id, status, activated_at desc);

create table public.emergency_required_qualifications (
  org_id uuid not null,
  emergency_id uuid not null,
  qualification_id uuid not null,
  primary key (emergency_id, qualification_id),
  foreign key (org_id, emergency_id) references public.emergencies (org_id, id) on delete cascade,
  foreign key (org_id, qualification_id) references public.qualifications (org_id, id) on delete restrict
);

create table public.emergency_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  emergency_id uuid not null,
  member_id uuid not null,
  status public.recipient_status not null default 'pending_send',
  eligible_at_selection boolean not null,
  status_changed_at timestamptz not null default now(),
  opened_at timestamptz,
  responded_at timestamptz,
  en_route_at timestamptz,
  arrived_at timestamptz,
  location_consent boolean not null default false,
  location_consent_at timestamptz,
  tracking_stopped_at timestamptz,
  notify_attempts integer not null default 0,
  last_notified_at timestamptz,
  last_manual_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (emergency_id, member_id),
  unique (org_id, id),
  foreign key (org_id, emergency_id) references public.emergencies (org_id, id) on delete cascade,
  -- restrict: el historial de servicios de una persona no desaparece por
  -- borrar su cuenta; para el derecho de supresión se anonimiza el perfil.
  foreign key (org_id, member_id) references public.organization_members (org_id, id) on delete restrict,
  -- Nunca hay consentimiento de ubicación sin haber aceptado acudir.
  check (not location_consent or status in ('accepted', 'en_route'))
);
create index emergency_recipients_member_idx on public.emergency_recipients (member_id, created_at desc);
create index emergency_recipients_pending_idx on public.emergency_recipients (emergency_id)
  where status in ('pending_send', 'sent', 'opened');

-- Personas candidatas que NO recibieron la alerta y por qué. El motivo solo lo
-- ven responsables y administradores.
create table public.emergency_exclusions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  emergency_id uuid not null,
  member_id uuid not null,
  kind public.exclusion_kind not null,
  reason text check (char_length(reason) <= 300),
  excluded_by uuid,
  created_at timestamptz not null default now(),
  unique (emergency_id, member_id),
  foreign key (org_id, emergency_id) references public.emergencies (org_id, id) on delete cascade,
  foreign key (org_id, member_id) references public.organization_members (org_id, id) on delete restrict
);

-- Historial inmutable: quién hizo qué y cuándo.
create table public.emergency_status_events (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  emergency_id uuid not null,
  recipient_id uuid,
  actor_user_id uuid, -- null = sistema (envío automático, reintentos)
  event_type text not null check (event_type in (
    'emergency_created', 'emergency_closed', 'emergency_cancelled',
    'recipient_status', 'location_consent', 'tracking_stopped',
    'resend_requested', 'manual_contact'
  )),
  from_status text,
  to_status text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, emergency_id) references public.emergencies (org_id, id) on delete cascade,
  foreign key (org_id, recipient_id) references public.emergency_recipients (org_id, id) on delete cascade
);
create index emergency_status_events_emergency_idx on public.emergency_status_events (emergency_id, created_at);

-- Solo la ÚLTIMA posición de cada destinatario (una fila por destinatario,
-- se sobrescribe). No se guarda un recorrido. Se borra al llegar, rechazar,
-- retirar el permiso o cerrar la emergencia, y caduca sola en expires_at.
create table public.location_updates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  emergency_id uuid not null,
  recipient_id uuid not null unique,
  member_id uuid not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m integer check (accuracy_m is null or accuracy_m between 0 and 100000),
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (org_id, emergency_id) references public.emergencies (org_id, id) on delete cascade,
  foreign key (org_id, recipient_id) references public.emergency_recipients (org_id, id) on delete cascade,
  foreign key (org_id, member_id) references public.organization_members (org_id, id) on delete cascade,
  check (private.valid_coordinates(lat, lng))
);
create index location_updates_expiry_idx on public.location_updates (expires_at);
create index location_updates_emergency_idx on public.location_updates (emergency_id);

-- ---------------------------------------------------------------------------
-- Dispositivos y entregas de notificaciones
-- ---------------------------------------------------------------------------
create table public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  token text not null unique check (char_length(token) between 10 and 300),
  platform public.device_platform not null,
  device_label text check (char_length(device_label) <= 80),
  app_version text check (char_length(app_version) <= 40),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);
create index push_tokens_user_idx on public.push_tokens (user_id) where revoked_at is null;

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  emergency_id uuid not null,
  recipient_id uuid not null,
  push_token_id uuid references public.push_tokens (id) on delete set null,
  channel public.delivery_channel not null,
  kind public.delivery_kind not null,
  attempt integer not null default 1 check (attempt >= 1),
  status public.delivery_status not null default 'queued',
  provider_ticket_id text,
  error_code text check (char_length(error_code) <= 80),
  error_message text check (char_length(error_message) <= 500),
  receipt_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, emergency_id) references public.emergencies (org_id, id) on delete cascade,
  foreign key (org_id, recipient_id) references public.emergency_recipients (org_id, id) on delete cascade
);
create index notification_deliveries_recipient_idx on public.notification_deliveries (recipient_id, created_at desc);
create index notification_deliveries_receipt_idx on public.notification_deliveries (created_at)
  where status = 'provider_accepted' and provider_ticket_id is not null;

-- ---------------------------------------------------------------------------
-- Auditoría
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations (id) on delete cascade,
  actor_user_id uuid,
  action text not null check (char_length(action) <= 80),
  target_table text,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Disparadores comunes
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'organizations', 'organization_settings', 'profiles', 'organization_members', 'bases',
    'qualifications', 'member_qualifications', 'shifts', 'shift_signups', 'events',
    'event_signups', 'emergencies', 'emergency_recipients', 'notification_deliveries'
  ] loop
    execute format(
      'create trigger touch_updated_at before update on public.%I
         for each row execute function private.touch_updated_at()', t);
  end loop;

  foreach t in array array[
    'organization_members', 'bases', 'qualifications', 'member_qualifications', 'shifts',
    'shift_signups', 'events', 'event_signups', 'emergencies', 'emergency_recipients',
    'location_updates', 'notification_deliveries', 'invitations'
  ] loop
    execute format(
      'create trigger prevent_org_change before update on public.%I
         for each row execute function private.prevent_org_change()', t);
  end loop;
end;
$$;

-- El historial de emergencias y la auditoría no se modifican ni se borran a
-- mano (solo la purga de retención, que corre como propietario).
create function private.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_setting('guardia.retention_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'append_only' using errcode = '42501';
end;
$$;

create trigger append_only before update or delete on public.emergency_status_events
  for each row execute function private.forbid_mutation();
create trigger append_only before update or delete on public.audit_logs
  for each row execute function private.forbid_mutation();

-- Al crear un usuario en Supabase Auth se crea su perfil.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, first_name, last_name)
  values (
    new.id,
    lower(new.email),
    coalesce(left(new.raw_user_meta_data ->> 'first_name', 80), ''),
    coalesce(left(new.raw_user_meta_data ->> 'last_name', 120), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
