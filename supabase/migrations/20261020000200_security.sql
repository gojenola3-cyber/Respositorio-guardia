-- =============================================================================
-- Guardia · Permisos, Row Level Security y privilegios
--
-- Modelo:
--  * Lectura: RLS filtra fila a fila según la organización y el rol.
--  * Escritura: casi todo pasa por funciones RPC (migración rpc) que validan
--    rol, estado y coherencia. Solo se permite escritura directa donde la RLS
--    basta (guardias, agenda, bases, cualificaciones, perfil propio).
--  * anon no tiene acceso a ninguna tabla.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Funciones de permisos (security definer para no recursar en la RLS)
-- ---------------------------------------------------------------------------
create function private.member_id(p_org uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.organization_members m
  where m.org_id = p_org and m.user_id = auth.uid() and m.status = 'active'
$$;

create function private.has_role(p_org uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = p_org and m.user_id = auth.uid()
      and m.status = 'active' and m.role = any (p_roles)
  )
$$;

create function private.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.member_id(p_org) is not null
$$;

create function private.is_manager(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org, array['admin', 'responsable']::public.member_role[])
$$;

create function private.is_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_role(p_org, array['admin']::public.member_role[])
$$;

-- ¿Puede el usuario actual ver el perfil completo de otra persona?
-- Solo responsables y administradores de una organización en la que esa
-- persona sea miembro (también pendiente, para poder aprobarla).
create function private.can_view_profile(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user = auth.uid() or exists (
    select 1 from public.organization_members target
    where target.user_id = p_user and private.is_manager(target.org_id)
  )
$$;

-- ¿Es el usuario actual destinatario de esta emergencia?
create function private.is_recipient(p_emergency uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.emergency_recipients r
    join public.organization_members m on m.id = r.member_id
    where r.emergency_id = p_emergency and m.user_id = auth.uid() and m.status = 'active'
  )
$$;


-- ---------------------------------------------------------------------------
-- Privilegios: se retira todo lo que Supabase concede por defecto y se
-- concede solo lo necesario.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage on all sequences in schema public to service_role;

-- Escritura directa permitida (siempre filtrada por RLS):
grant update (name) on public.organizations to authenticated;
grant update (
  eligibility_mode, location_retention_minutes, resend_interval_seconds, max_resends,
  critical_alerts_enabled, time_zone, default_locale, delivery_log_retention_days,
  audit_retention_days, emergency_retention_days
) on public.organization_settings to authenticated;
grant update (
  first_name, last_name, phone, locale, notify_shift_reminders, notify_agenda_changes, notify_email
) on public.profiles to authenticated;
grant insert, update, delete on public.bases to authenticated;
grant insert, update, delete on public.qualifications to authenticated;
grant insert, update, delete on public.member_qualifications to authenticated;
grant insert (org_id, title, starts_at, ends_at, min_volunteers, max_volunteers, status,
              responsable_member_id, base_id, notes) on public.shifts to authenticated;
grant update (title, starts_at, ends_at, min_volunteers, max_volunteers, status,
              responsable_member_id, base_id, notes) on public.shifts to authenticated;
grant insert (org_id, type, title, description, starts_at, ends_at, location_text, base_id,
              organizer_member_id, capacity, status, notes) on public.events to authenticated;
grant update (type, title, description, starts_at, ends_at, location_text, base_id,
              organizer_member_id, capacity, status, notes, cancel_reason) on public.events to authenticated;

-- ---------------------------------------------------------------------------
-- RLS en todas las tablas
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    -- Sin FORCE: las funciones security definer (propiedad del dueño de las
    -- tablas) aplican sus propias comprobaciones explícitas.
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- Organizaciones y configuración
create policy organizations_select on public.organizations for select to authenticated
  using (private.is_member(id));
create policy organizations_update on public.organizations for update to authenticated
  using (private.is_admin(id)) with check (private.is_admin(id));

create policy settings_select on public.organization_settings for select to authenticated
  using (private.is_member(org_id));
create policy settings_update on public.organization_settings for update to authenticated
  using (private.is_admin(org_id)) with check (private.is_admin(org_id));

-- Perfiles: cada uno el suyo; responsables y admins los de su organización.
-- Los voluntarios ven a los demás solo por nombre (función member_directory).
create policy profiles_select on public.profiles for select to authenticated
  using (private.can_view_profile(id));
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Miembros
create policy members_select on public.organization_members for select to authenticated
  using (user_id = auth.uid() or private.is_manager(org_id));

create policy invitations_select on public.invitations for select to authenticated
  using (private.is_admin(org_id));

-- Bases y cualificaciones: todos los miembros leen, los admins gestionan.
create policy bases_select on public.bases for select to authenticated
  using (private.is_member(org_id));
create policy bases_write on public.bases for all to authenticated
  using (private.is_admin(org_id)) with check (private.is_admin(org_id));

create policy qualifications_select on public.qualifications for select to authenticated
  using (private.is_member(org_id));
create policy qualifications_write on public.qualifications for all to authenticated
  using (private.is_admin(org_id)) with check (private.is_admin(org_id));

create policy member_qualifications_select on public.member_qualifications for select to authenticated
  using (member_id = private.member_id(org_id) or private.is_manager(org_id));
create policy member_qualifications_write on public.member_qualifications for all to authenticated
  using (private.is_admin(org_id)) with check (private.is_admin(org_id));

-- Guardias y agenda: todos los miembros leen; responsables y admins gestionan.
create policy shifts_select on public.shifts for select to authenticated
  using (private.is_member(org_id));
create policy shifts_insert on public.shifts for insert to authenticated
  with check (private.is_manager(org_id));
create policy shifts_update on public.shifts for update to authenticated
  using (private.is_manager(org_id)) with check (private.is_manager(org_id));

create policy shift_signups_select on public.shift_signups for select to authenticated
  using (private.is_member(org_id));

create policy events_select on public.events for select to authenticated
  using (private.is_member(org_id));
create policy events_insert on public.events for insert to authenticated
  with check (private.is_manager(org_id));
create policy events_update on public.events for update to authenticated
  using (private.is_manager(org_id)) with check (private.is_manager(org_id));

create policy event_signups_select on public.event_signups for select to authenticated
  using (private.is_member(org_id));

-- Emergencias: responsables y admins de la organización, o destinatarios.
create policy emergencies_select on public.emergencies for select to authenticated
  using (private.is_manager(org_id) or private.is_recipient(id));

create policy emergency_required_qualifications_select on public.emergency_required_qualifications
  for select to authenticated
  using (private.is_manager(org_id) or private.is_recipient(emergency_id));

-- Cada voluntario ve solo su propia fila; el recuento global lo da
-- emergency_counts().
create policy emergency_recipients_select on public.emergency_recipients for select to authenticated
  using (private.is_manager(org_id) or member_id = private.member_id(org_id));

create policy emergency_exclusions_select on public.emergency_exclusions for select to authenticated
  using (private.is_manager(org_id));

create policy emergency_status_events_select on public.emergency_status_events for select to authenticated
  using (
    private.is_manager(org_id)
    or recipient_id in (
      select r.id from public.emergency_recipients r where r.member_id = private.member_id(r.org_id)
    )
  );

-- Ubicaciones: el propio voluntario y los responsables/admins. Nunca otros
-- voluntarios. Una posición caducada deja de ser visible aunque la purga
-- todavía no la haya borrado.
create policy location_updates_select on public.location_updates for select to authenticated
  using (
    expires_at > now()
    and (private.is_manager(org_id) or member_id = private.member_id(org_id))
  );

create policy push_tokens_select on public.push_tokens for select to authenticated
  using (user_id = auth.uid());

create policy notification_deliveries_select on public.notification_deliveries for select to authenticated
  using (private.is_manager(org_id));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (private.is_admin(org_id));

-- ---------------------------------------------------------------------------
-- Integridad en escrituras directas
-- ---------------------------------------------------------------------------
create function private.set_created_by() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;

create trigger set_created_by before insert on public.shifts
  for each row execute function private.set_created_by();
create trigger set_created_by before insert on public.events
  for each row execute function private.set_created_by();

-- "full" lo gestiona el sistema según las plazas; a mano solo se puede abrir,
-- cerrar o cancelar.
create function private.shift_status_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- current_user es "authenticated" en escrituras directas desde la API y el
  -- propietario dentro de las funciones del sistema.
  if current_user = 'authenticated' and new.status = 'full'
     and (tg_op = 'INSERT' or old.status is distinct from 'full') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger shift_status_guard before insert or update of status on public.shifts
  for each row execute function private.shift_status_guard();
