-- =============================================================================
-- Guardia · Auditoría automática, Realtime y retención de datos
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Auditoría de cambios administrativos
-- Guarda qué columnas cambiaron. Los datos personales y las coordenadas no se
-- copian al registro: solo se indica que cambiaron.
-- ---------------------------------------------------------------------------
create function private.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  sensitive constant text[] := array['token_hash', 'lat', 'lng', 'phone', 'email', 'notes', 'description'];
  old_j jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) else '{}'::jsonb end;
  new_j jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) else '{}'::jsonb end;
  details jsonb := '{}'::jsonb;
  k text;
  v_org uuid := coalesce(new_j ->> 'org_id', old_j ->> 'org_id')::uuid;
  v_id uuid := coalesce(new_j ->> 'id', old_j ->> 'id', new_j ->> 'org_id')::uuid;
begin
  -- Borrado en cascada de toda la organización: no queda dónde auditar.
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = v_org) then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(new_j) loop
      continue when k in ('updated_at', 'created_at');
      if new_j -> k is distinct from old_j -> k then
        details := details || jsonb_build_object(k,
          case when k = any (sensitive) then '"(cambiado)"'::jsonb
               else jsonb_build_object('from', old_j -> k, 'to', new_j -> k) end);
      end if;
    end loop;
    if details = '{}'::jsonb then
      return null;
    end if;
  elsif tg_op = 'INSERT' then
    details := new_j - sensitive;
  end if;

  insert into public.audit_logs (org_id, actor_user_id, action, target_table, target_id, details)
  values (v_org, auth.uid(), lower(tg_op), tg_table_name, v_id, details);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'organization_members', 'organization_settings', 'bases', 'qualifications',
    'member_qualifications', 'shifts', 'events'
  ] loop
    execute format(
      'create trigger audit_row after insert or update or delete on public.%I
         for each row execute function private.audit_row()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Realtime: cambios que los clientes reciben al instante. Supabase aplica la
-- RLS de cada suscriptor antes de enviarle una fila.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.emergencies, public.emergency_recipients, public.location_updates,
      public.notification_deliveries, public.shifts, public.shift_signups,
      public.events, public.event_signups, public.organization_members;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retención
--  * Ubicaciones: se borran al terminar el seguimiento; si algo falla,
--    caducan en expires_at (y la RLS ya no las muestra desde ese momento).
--  * Registros de entrega, auditoría y emergencias: según
--    organization_settings (por defecto 180 días, 2 años y 5 años).
--  * Dispositivos revocados (30 días) o sin uso (180 días).
--  * Invitaciones caducadas (30 días).
-- ---------------------------------------------------------------------------
create function private.run_retention() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_locations integer;
  v_deliveries integer;
  v_audit integer;
  v_emergencies integer;
  v_tokens integer;
  v_invitations integer;
begin
  perform set_config('guardia.retention_purge', 'on', true);

  delete from public.location_updates where expires_at <= now();
  get diagnostics v_locations = row_count;

  delete from public.notification_deliveries d using public.organization_settings s
  where s.org_id = d.org_id and d.created_at < now() - make_interval(days => s.delivery_log_retention_days);
  get diagnostics v_deliveries = row_count;

  delete from public.audit_logs a using public.organization_settings s
  where s.org_id = a.org_id and a.created_at < now() - make_interval(days => s.audit_retention_days);
  get diagnostics v_audit = row_count;

  delete from public.emergencies e using public.organization_settings s
  where s.org_id = e.org_id and e.status <> 'active'
    and e.closed_at < now() - make_interval(days => s.emergency_retention_days);
  get diagnostics v_emergencies = row_count;

  delete from public.push_tokens
  where (revoked_at is not null and revoked_at < now() - interval '30 days')
     or last_seen_at < now() - interval '180 days';
  get diagnostics v_tokens = row_count;

  delete from public.invitations
  where accepted_at is null and expires_at < now() - interval '30 days';
  get diagnostics v_invitations = row_count;

  perform set_config('guardia.retention_purge', 'off', true);
  return jsonb_build_object(
    'locations', v_locations, 'deliveries', v_deliveries, 'audit', v_audit,
    'emergencies', v_emergencies, 'push_tokens', v_tokens, 'invitations', v_invitations
  );
end;
$$;

revoke execute on function private.run_retention() from public, authenticated;
grant execute on function private.run_retention() to service_role;

-- Programación con pg_cron si está activado (en Supabase: Database →
-- Extensions → pg_cron). Si no, ver docs/DESPLIEGUE.md.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('guardia-retention', '*/15 * * * *', 'select private.run_retention()');
  end if;
end;
$$;
