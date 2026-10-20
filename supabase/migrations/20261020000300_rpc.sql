-- =============================================================================
-- Guardia · Operaciones de servidor (RPC)
--
-- Todas son security definer con search_path vacío y comprueban
-- explícitamente: usuario autenticado, membresía activa, rol y organización.
-- Errores: mensajes-clave en inglés (el cliente los traduce).
--   42501 forbidden / not_authenticated · P0002 not_found · 22023 invalid_input
--   P0001 conflictos de negocio (duplicate_signup, shift_full, ...)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Ayudantes internos
-- ---------------------------------------------------------------------------
create function private.current_member(p_org uuid, p_roles public.member_role[] default null)
returns public.organization_members
language plpgsql stable security definer set search_path = '' as $$
declare m public.organization_members;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into m from public.organization_members
  where org_id = p_org and user_id = auth.uid() and status = 'active';
  if not found or (p_roles is not null and not (m.role = any (p_roles))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return m;
end;
$$;

create function private.manager_roles() returns public.member_role[]
language sql immutable as $$ select array['admin', 'responsable']::public.member_role[] $$;

create function private.audit(p_org uuid, p_action text, p_table text, p_target uuid, p_details jsonb default '{}')
returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs (org_id, actor_user_id, action, target_table, target_id, details)
  values (p_org, auth.uid(), p_action, p_table, p_target, coalesce(p_details, '{}'::jsonb))
$$;

-- Destinatario del usuario actual en una emergencia ACTIVA, bloqueado para
-- actualizar. Si no es suyo: forbidden. Si la emergencia terminó: conflicto.
create function private.my_active_recipient(p_recipient uuid)
returns public.emergency_recipients
language plpgsql security definer set search_path = '' as $$
declare
  r public.emergency_recipients;
  e_status public.emergency_status;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select r0.* into r
  from public.emergency_recipients r0
  join public.organization_members m on m.id = r0.member_id
  where r0.id = p_recipient and m.user_id = auth.uid() and m.status = 'active'
  for update of r0;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select status into e_status from public.emergencies where id = r.emergency_id;
  if e_status <> 'active' then
    raise exception 'emergency_not_active' using errcode = 'P0001';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organización, invitaciones y miembros
-- ---------------------------------------------------------------------------
create function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.organization_members
      where user_id = auth.uid() and role = 'admin' and created_at > now() - interval '1 day') >= 3 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  insert into public.organizations (name, slug) values (trim(p_name), lower(trim(p_slug)))
  returning id into v_org;
  insert into public.organization_settings (org_id, updated_by) values (v_org, auth.uid());
  insert into public.organization_members (org_id, user_id, role, status, approved_by, approved_at)
  values (v_org, auth.uid(), 'admin', 'active', auth.uid(), now());
  perform private.audit(v_org, 'organization_created', 'organizations', v_org);
  return v_org;
end;
$$;

-- Devuelve el token de invitación en claro UNA vez. Solo se guarda su hash.
create function public.invite_member(p_org uuid, p_email text, p_role public.member_role default 'voluntario')
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id uuid;
begin
  perform private.current_member(p_org, array['admin']::public.member_role[]);
  if (select count(*) from public.invitations
      where org_id = p_org and created_at > now() - interval '1 hour') >= 100 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.organization_members m join public.profiles p on p.id = m.user_id
    where m.org_id = p_org and p.email = v_email and m.status = 'active'
  ) then
    raise exception 'already_member' using errcode = 'P0001';
  end if;
  update public.invitations set revoked_at = now()
  where org_id = p_org and email = v_email and accepted_at is null and revoked_at is null;
  insert into public.invitations (org_id, email, role, token_hash, invited_by)
  values (p_org, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid())
  returning id into v_id;
  perform private.audit(p_org, 'member_invited', 'invitations', v_id, jsonb_build_object('role', p_role));
  return v_token;
end;
$$;

create function public.revoke_invitation(p_invitation uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.invitations where id = p_invitation;
  if v_org is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(v_org, array['admin']::public.member_role[]);
  update public.invitations set revoked_at = now()
  where id = p_invitation and accepted_at is null and revoked_at is null;
  perform private.audit(v_org, 'invitation_revoked', 'invitations', p_invitation);
end;
$$;

-- La invitación solo la puede aceptar la cuenta con el mismo correo: un enlace
-- reenviado a otra persona no sirve.
create function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  inv public.invitations;
  v_member public.organization_members;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into inv from public.invitations
  where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
    and accepted_at is null and revoked_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'invitation_invalid' using errcode = 'P0002';
  end if;
  if inv.email is distinct from lower(auth.jwt() ->> 'email') then
    raise exception 'invitation_email_mismatch' using errcode = '42501';
  end if;

  select * into v_member from public.organization_members
  where org_id = inv.org_id and user_id = auth.uid() for update;
  if found and v_member.status = 'suspended' then
    raise exception 'member_suspended' using errcode = '42501';
  end if;

  insert into public.organization_members (org_id, user_id, role, status, approved_by, approved_at)
  values (inv.org_id, auth.uid(), inv.role, 'active', inv.invited_by, now())
  on conflict (org_id, user_id) do update
    set role = excluded.role, status = 'active', approved_by = excluded.approved_by, approved_at = now()
  returning * into v_member;

  update public.invitations set accepted_at = now(), accepted_by = auth.uid() where id = inv.id;
  perform private.audit(inv.org_id, 'invitation_accepted', 'organization_members', v_member.id,
                        jsonb_build_object('role', inv.role));
  return v_member.id;
end;
$$;

-- Solicitud de alta sin invitación: queda PENDIENTE hasta que un admin la apruebe.
create function public.request_membership(p_slug text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select id into v_org from public.organizations where slug = lower(trim(p_slug));
  if v_org is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.organization_members (org_id, user_id, role, status)
  values (v_org, auth.uid(), 'voluntario', 'pending')
  on conflict (org_id, user_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.organization_members where org_id = v_org and user_id = auth.uid();
  else
    perform private.audit(v_org, 'membership_requested', 'organization_members', v_id);
  end if;
  return v_id;
end;
$$;

create function private.assert_not_last_admin(p_member public.organization_members) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_member.role = 'admin' and p_member.status = 'active' and not exists (
    select 1 from public.organization_members
    where org_id = p_member.org_id and role = 'admin' and status = 'active' and id <> p_member.id
  ) then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;
end;
$$;

create function public.set_member_status(p_member uuid, p_status public.member_status)
returns void
language plpgsql security definer set search_path = '' as $$
declare target public.organization_members;
begin
  select * into target from public.organization_members where id = p_member for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(target.org_id, array['admin']::public.member_role[]);
  if target.user_id = auth.uid() then
    raise exception 'cannot_change_self' using errcode = 'P0001';
  end if;
  if p_status <> 'active' then
    perform private.assert_not_last_admin(target);
  end if;
  update public.organization_members
  set status = p_status,
      approved_by = case when target.status = 'pending' and p_status = 'active' then auth.uid() else approved_by end,
      approved_at = case when target.status = 'pending' and p_status = 'active' then now() else approved_at end
  where id = p_member;
end;
$$;

create function public.set_member_role(p_member uuid, p_role public.member_role)
returns void
language plpgsql security definer set search_path = '' as $$
declare target public.organization_members;
begin
  select * into target from public.organization_members where id = p_member for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(target.org_id, array['admin']::public.member_role[]);
  if p_role <> 'admin' then
    perform private.assert_not_last_admin(target);
  end if;
  update public.organization_members set role = p_role where id = p_member;
end;
$$;

create function public.set_member_internal_code(p_member uuid, p_code text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.organization_members where id = p_member;
  if v_org is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(v_org, array['admin']::public.member_role[]);
  update public.organization_members set internal_code = nullif(trim(p_code), '') where id = p_member;
end;
$$;

-- Baja con derecho de supresión: se desactiva la membresía y, si la persona
-- no pertenece a ninguna otra organización, se anonimiza su perfil. El
-- historial de emergencias se conserva sin datos identificativos. La cuenta de
-- acceso (auth.users) se borra aparte con la API de administración.
create function public.anonymize_member(p_member uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  target public.organization_members;
  v_anonymized boolean := false;
begin
  select * into target from public.organization_members where id = p_member for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(target.org_id, array['admin']::public.member_role[]);
  if target.user_id = auth.uid() then
    raise exception 'cannot_change_self' using errcode = 'P0001';
  end if;
  perform private.assert_not_last_admin(target);

  update public.organization_members
  set status = 'deactivated', internal_code = null, availability = 'unavailable'
  where id = target.id;
  delete from public.member_qualifications where member_id = target.id;
  update public.shift_signups x set status = 'cancelled', cancelled_at = now()
  from public.shifts s
  where s.id = x.shift_id and x.member_id = target.id and x.status <> 'cancelled' and s.starts_at > now();
  update public.event_signups x set status = 'cancelled', cancelled_at = now()
  from public.events e
  where e.id = x.event_id and x.member_id = target.id and x.status <> 'cancelled' and e.starts_at > now();

  if not exists (
    select 1 from public.organization_members
    where user_id = target.user_id and id <> target.id and status <> 'deactivated'
  ) then
    update public.profiles
    set first_name = 'Persona', last_name = 'eliminada', email = null, phone = null, anonymized_at = now()
    where id = target.user_id;
    update public.push_tokens set revoked_at = now(), revoked_reason = 'anonymized'
    where user_id = target.user_id and revoked_at is null;
    v_anonymized := true;
  end if;
  perform private.audit(target.org_id, 'member_anonymized', 'organization_members', target.id,
                        jsonb_build_object('profile_anonymized', v_anonymized));
  return v_anonymized;
end;
$$;

create function public.set_my_availability(p_org uuid, p_availability public.availability_status)
returns void
language plpgsql security definer set search_path = '' as $$
declare m public.organization_members;
begin
  m := private.current_member(p_org);
  update public.organization_members
  set availability = p_availability, availability_updated_at = now()
  where id = m.id;
end;
$$;

-- Nombres visibles para cualquier miembro: nombre e inicial del apellido.
-- Correo y teléfono solo los ven responsables y admins (tabla profiles).
create function public.member_directory(p_org uuid)
returns table (member_id uuid, display_name text, role public.member_role)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.current_member(p_org);
  return query
    select m.id,
           trim(p.first_name || ' ' || coalesce(left(nullif(p.last_name, ''), 1) || '.', '')),
           m.role
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    where m.org_id = p_org and m.status = 'active'
    order by p.first_name, p.last_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Guardias
-- ---------------------------------------------------------------------------
create function private.refresh_shift_status(p_shift uuid) returns void
language sql security definer set search_path = '' as $$
  update public.shifts s
  set status = case
    when (select count(*) from public.shift_signups x
          where x.shift_id = s.id and x.status <> 'cancelled') >= s.max_volunteers
      then 'full'::public.shift_status
    else 'open'::public.shift_status
  end
  where s.id = p_shift and s.status in ('open', 'full') and s.max_volunteers is not null
$$;

create function public.sign_up_for_shift(p_shift uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  s public.shifts;
  m public.organization_members;
  v_id uuid;
begin
  select * into s from public.shifts where id = p_shift;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  m := private.current_member(s.org_id);
  -- Bloqueos: la persona (para comprobar solapes sin carreras) y la guardia
  -- (para las plazas).
  perform 1 from public.organization_members where id = m.id for update;
  select * into s from public.shifts where id = p_shift for update;

  if s.ends_at <= now() then
    raise exception 'shift_finished' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shift_signups
             where shift_id = s.id and member_id = m.id and status <> 'cancelled') then
    raise exception 'duplicate_signup' using errcode = 'P0001';
  end if;
  if s.status = 'full' then
    raise exception 'shift_full' using errcode = 'P0001';
  end if;
  if s.status <> 'open' then
    raise exception 'shift_not_open' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.shift_signups x join public.shifts o on o.id = x.shift_id
    where x.member_id = m.id and x.status <> 'cancelled' and o.status <> 'cancelled'
      and tstzrange(o.starts_at, o.ends_at) && tstzrange(s.starts_at, s.ends_at)
  ) then
    raise exception 'overlapping_shift' using errcode = 'P0001';
  end if;
  if s.max_volunteers is not null and (
    select count(*) from public.shift_signups where shift_id = s.id and status <> 'cancelled'
  ) >= s.max_volunteers then
    raise exception 'shift_full' using errcode = 'P0001';
  end if;

  insert into public.shift_signups (org_id, shift_id, member_id) values (s.org_id, s.id, m.id)
  returning id into v_id;
  perform private.refresh_shift_status(s.id);
  return v_id;
end;
$$;

create function public.cancel_shift_signup(p_shift uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.shifts;
  m public.organization_members;
begin
  select * into s from public.shifts where id = p_shift for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  m := private.current_member(s.org_id);
  if s.starts_at <= now() then
    -- Una guardia ya empezada se deja avisando al responsable, no desde la app.
    raise exception 'shift_started' using errcode = 'P0001';
  end if;
  update public.shift_signups set status = 'cancelled', cancelled_at = now()
  where shift_id = s.id and member_id = m.id and status <> 'cancelled';
  if not found then
    raise exception 'not_signed_up' using errcode = 'P0001';
  end if;
  perform private.refresh_shift_status(s.id);
end;
$$;

-- El responsable confirma (guardia confirmada) o retira una inscripción.
create function public.manage_shift_signup(p_signup uuid, p_status public.signup_status)
returns void
language plpgsql security definer set search_path = '' as $$
declare x public.shift_signups;
begin
  select * into x from public.shift_signups where id = p_signup for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(x.org_id, private.manager_roles());
  if p_status = 'signed_up' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  update public.shift_signups
  set status = p_status,
      confirmed_by = case when p_status = 'confirmed' then auth.uid() else confirmed_by end,
      confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end,
      cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end
  where id = p_signup;
  perform private.refresh_shift_status(x.shift_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Agenda
-- ---------------------------------------------------------------------------
create function public.sign_up_for_event(p_event uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  ev public.events;
  m public.organization_members;
  v_id uuid;
begin
  select * into ev from public.events where id = p_event for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  m := private.current_member(ev.org_id);
  if ev.status <> 'scheduled' or ev.ends_at <= now() then
    raise exception 'event_not_open' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.event_signups
             where event_id = ev.id and member_id = m.id and status <> 'cancelled') then
    raise exception 'duplicate_signup' using errcode = 'P0001';
  end if;
  if ev.capacity is not null and (
    select count(*) from public.event_signups where event_id = ev.id and status <> 'cancelled'
  ) >= ev.capacity then
    raise exception 'event_full' using errcode = 'P0001';
  end if;
  insert into public.event_signups (org_id, event_id, member_id) values (ev.org_id, ev.id, m.id)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.cancel_event_signup(p_event uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  ev public.events;
  m public.organization_members;
begin
  select * into ev from public.events where id = p_event;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  m := private.current_member(ev.org_id);
  update public.event_signups set status = 'cancelled', cancelled_at = now()
  where event_id = ev.id and member_id = m.id and status <> 'cancelled';
  if not found then
    raise exception 'not_signed_up' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Emergencias: candidatos y activación
-- ---------------------------------------------------------------------------

-- Distingue disponibilidad declarada (availability), guardia (inscrito o
-- confirmado en un turno que cubre p_at) y elegibilidad (cualificaciones
-- vigentes requeridas). "eligible" es lo que se marca por defecto.
create function private.emergency_candidates(
  p_org uuid, p_required uuid[], p_at timestamptz, p_self uuid
)
returns table (
  member_id uuid,
  display_name text,
  role public.member_role,
  availability public.availability_status,
  on_shift boolean,
  shift_confirmed boolean,
  qualification_codes text[],
  missing_qualification_codes text[],
  has_push_device boolean,
  eligible boolean,
  ineligible_reason text
)
language sql stable security definer set search_path = '' as $$
  with settings as (
    select
      coalesce((select eligibility_mode from public.organization_settings where org_id = p_org),
               'on_shift_or_available') as mode,
      (p_at at time zone coalesce(
        (select time_zone from public.organization_settings where org_id = p_org), 'Europe/Madrid'
      ))::date as today
  ),
  base as (
    select
      m.id,
      m.user_id,
      trim(p.first_name || ' ' || p.last_name) as display_name,
      m.role,
      m.availability,
      exists (
        select 1 from public.shift_signups x join public.shifts s on s.id = x.shift_id
        where x.member_id = m.id and x.status <> 'cancelled' and s.status <> 'cancelled'
          and p_at >= s.starts_at and p_at < s.ends_at
      ) as on_shift,
      exists (
        select 1 from public.shift_signups x join public.shifts s on s.id = x.shift_id
        where x.member_id = m.id and x.status = 'confirmed' and s.status <> 'cancelled'
          and p_at >= s.starts_at and p_at < s.ends_at
      ) as shift_confirmed,
      coalesce((
        select array_agg(q.code order by q.code)
        from public.member_qualifications mq join public.qualifications q on q.id = mq.qualification_id
        where mq.member_id = m.id and (mq.expires_on is null or mq.expires_on >= (select today from settings))
      ), '{}') as codes,
      coalesce((
        select array_agg(q.code order by q.code)
        from public.qualifications q
        where q.id = any (p_required) and not exists (
          select 1 from public.member_qualifications mq
          where mq.member_id = m.id and mq.qualification_id = q.id
            and (mq.expires_on is null or mq.expires_on >= (select today from settings))
        )
      ), '{}') as missing,
      exists (select 1 from public.push_tokens t where t.user_id = m.user_id and t.revoked_at is null) as has_push
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    where m.org_id = p_org and m.status = 'active'
  )
  select
    b.id, b.display_name, b.role, b.availability, b.on_shift, b.shift_confirmed,
    b.codes, b.missing, b.has_push,
    (b.id is distinct from p_self and cardinality(b.missing) = 0 and case s.mode
      when 'on_shift' then b.on_shift
      when 'available' then b.availability = 'available'
      when 'on_shift_or_available' then b.on_shift or b.availability = 'available'
      else true end) as eligible,
    case
      when b.id = p_self then 'self'
      when cardinality(b.missing) > 0 then 'missing_qualifications'
      when not case s.mode
        when 'on_shift' then b.on_shift
        when 'available' then b.availability = 'available'
        when 'on_shift_or_available' then b.on_shift or b.availability = 'available'
        else true end then 'not_available'
    end as ineligible_reason
  from base b cross join settings s
  order by (b.id is distinct from p_self and cardinality(b.missing) = 0) desc, b.on_shift desc, b.display_name
$$;

create function public.get_emergency_candidates(p_org uuid, p_required_qualifications uuid[] default '{}')
returns table (
  member_id uuid,
  display_name text,
  role public.member_role,
  availability public.availability_status,
  on_shift boolean,
  shift_confirmed boolean,
  qualification_codes text[],
  missing_qualification_codes text[],
  has_push_device boolean,
  eligible boolean,
  ineligible_reason text,
  selected_by_default boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare m public.organization_members;
begin
  m := private.current_member(p_org, private.manager_roles());
  if exists (
    select 1 from unnest(coalesce(p_required_qualifications, '{}')) q(id)
    where not exists (select 1 from public.qualifications where id = q.id and org_id = p_org)
  ) then
    raise exception 'invalid_qualification' using errcode = '22023';
  end if;
  return query
    select c.*, c.eligible
    from private.emergency_candidates(p_org, coalesce(p_required_qualifications, '{}'), now(), m.id) c;
end;
$$;

-- Crea la emergencia, registra la selección (destinatarios y excluidos con su
-- motivo privado) y deja cada alerta en "pending_send". El envío push lo hace
-- la Edge Function "dispatch" a continuación.
--
-- Idempotente: el mismo p_idempotency_key devuelve la emergencia ya creada.
create function public.create_emergency(
  p_org uuid,
  p_idempotency_key uuid,
  p_title text,
  p_recipients uuid[],
  p_description text default null,
  p_address text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_priority public.emergency_priority default 'high',
  p_base uuid default null,
  p_type text default null,
  p_notes text default null,
  p_required_qualifications uuid[] default '{}',
  p_exclusion_reasons jsonb default '{}'
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  m public.organization_members;
  v_id uuid;
  v_base uuid := p_base;
  v_recipients uuid[] := array(select distinct x from unnest(coalesce(p_recipients, '{}')) x);
  v_required uuid[] := array(select distinct x from unnest(coalesce(p_required_qualifications, '{}')) x);
  v_excluded integer;
begin
  m := private.current_member(p_org, private.manager_roles());
  if p_idempotency_key is null then
    raise exception 'invalid_input' using errcode = '22023', detail = 'idempotency_key';
  end if;

  select id into v_id from public.emergencies where org_id = p_org and idempotency_key = p_idempotency_key;
  if v_id is not null then
    return v_id;
  end if;

  if char_length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'invalid_input' using errcode = '22023', detail = 'title';
  end if;
  if cardinality(v_recipients) = 0 then
    raise exception 'no_recipients' using errcode = '22023';
  end if;
  if (select count(*) from public.organization_members
      where id = any (v_recipients) and org_id = p_org and status = 'active') <> cardinality(v_recipients) then
    raise exception 'invalid_recipients' using errcode = '22023';
  end if;
  if (p_lat is null) <> (p_lng is null) or not private.valid_coordinates(p_lat, p_lng) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'location';
  end if;
  if exists (select 1 from unnest(v_required) q(id)
             where not exists (select 1 from public.qualifications where id = q.id and org_id = p_org)) then
    raise exception 'invalid_qualification' using errcode = '22023';
  end if;
  if v_base is null then
    select id into v_base from public.bases where org_id = p_org and is_default;
  elsif not exists (select 1 from public.bases where id = v_base and org_id = p_org) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'base';
  end if;

  insert into public.emergencies (
    org_id, idempotency_key, title, emergency_type, description, address, lat, lng, priority,
    base_id, notes, created_by, created_by_member_id
  ) values (
    p_org, p_idempotency_key, trim(p_title), nullif(trim(p_type), ''), nullif(trim(p_description), ''),
    nullif(trim(p_address), ''), p_lat, p_lng, coalesce(p_priority, 'high'),
    v_base, nullif(trim(p_notes), ''), auth.uid(), m.id
  )
  on conflict (org_id, idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    -- Otra petición con la misma clave ganó la carrera.
    select id into v_id from public.emergencies where org_id = p_org and idempotency_key = p_idempotency_key;
    return v_id;
  end if;

  insert into public.emergency_required_qualifications (org_id, emergency_id, qualification_id)
  select p_org, v_id, q from unnest(v_required) q;

  insert into public.emergency_recipients (org_id, emergency_id, member_id, eligible_at_selection)
  select p_org, v_id, r.id, coalesce(c.eligible, false)
  from unnest(v_recipients) r(id)
  left join private.emergency_candidates(p_org, v_required, now(), m.id) c on c.member_id = r.id;

  -- Candidatos que no reciben la alerta: desmarcados a mano o no elegibles.
  insert into public.emergency_exclusions (org_id, emergency_id, member_id, kind, reason, excluded_by)
  select p_org, v_id, c.member_id,
         case when c.eligible then 'manual'::public.exclusion_kind else 'ineligible'::public.exclusion_kind end,
         left(nullif(trim(coalesce(p_exclusion_reasons, '{}'::jsonb) ->> c.member_id::text), ''), 300),
         auth.uid()
  from private.emergency_candidates(p_org, v_required, now(), m.id) c
  where c.member_id <> m.id and not (c.member_id = any (v_recipients));
  get diagnostics v_excluded = row_count;

  insert into public.emergency_status_events (org_id, emergency_id, actor_user_id, event_type, to_status, details)
  values (p_org, v_id, auth.uid(), 'emergency_created', 'active',
          jsonb_build_object('recipients', cardinality(v_recipients), 'excluded', v_excluded));
  perform private.audit(p_org, 'emergency_activated', 'emergencies', v_id,
                        jsonb_build_object('recipients', cardinality(v_recipients), 'priority', p_priority));
  return v_id;
end;
$$;

-- Recuento de estados: los voluntarios destinatarios ven cuántos acuden,
-- pero no quiénes ni dónde están.
create function public.emergency_counts(p_emergency uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  select org_id into v_org from public.emergencies where id = p_emergency;
  if v_org is null or not (private.is_manager(v_org) or private.is_recipient(p_emergency)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.emergency_recipients where emergency_id = p_emergency)
  ) || coalesce((
    select jsonb_object_agg(status, n) from (
      select status::text as status, count(*) as n
      from public.emergency_recipients where emergency_id = p_emergency group by status
    ) s
  ), '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Respuesta del voluntario y seguimiento
-- ---------------------------------------------------------------------------

-- La app lo llama al mostrar la alerta: es la ÚNICA confirmación de que el
-- aviso llegó al dispositivo y lo vio la persona.
create function public.mark_alert_opened(p_recipient uuid)
returns public.recipient_status
language plpgsql security definer set search_path = '' as $$
declare r public.emergency_recipients;
begin
  r := private.my_active_recipient(p_recipient);
  if r.status in ('pending_send', 'sent') then
    update public.emergency_recipients set status = 'opened' where id = r.id returning status into r.status;
  end if;
  return r.status;
end;
$$;

create function public.respond_to_alert(p_recipient uuid, p_accept boolean)
returns public.recipient_status
language plpgsql security definer set search_path = '' as $$
declare r public.emergency_recipients;
begin
  if p_accept is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  r := private.my_active_recipient(p_recipient);
  if p_accept then
    if r.status in ('pending_send', 'sent', 'opened', 'declined') then
      update public.emergency_recipients set status = 'accepted' where id = r.id returning status into r.status;
    end if;
  else
    if r.status = 'arrived' then
      raise exception 'already_arrived' using errcode = 'P0001';
    end if;
    if r.status <> 'declined' then
      update public.emergency_recipients set status = 'declined' where id = r.id returning status into r.status;
    end if;
  end if;
  return r.status;
end;
$$;

-- Consentimiento explícito para compartir ubicación en ESTA activación.
-- Retirarlo detiene el seguimiento y borra la última posición.
create function public.set_location_consent(p_recipient uuid, p_granted boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.emergency_recipients;
begin
  r := private.my_active_recipient(p_recipient);
  if p_granted and r.status not in ('accepted', 'en_route') then
    raise exception 'must_accept_first' using errcode = 'P0001';
  end if;
  update public.emergency_recipients set location_consent = coalesce(p_granted, false) where id = r.id;
end;
$$;

create function public.report_location(
  p_recipient uuid,
  p_lat double precision,
  p_lng double precision,
  p_accuracy_m integer default null,
  p_recorded_at timestamptz default now()
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r public.emergency_recipients;
  v_last timestamptz;
  v_retention integer;
begin
  r := private.my_active_recipient(p_recipient);
  if not r.location_consent or r.status not in ('accepted', 'en_route') then
    raise exception 'location_not_authorized' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or not private.valid_coordinates(p_lat, p_lng)
     or (p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m > 100000)) then
    raise exception 'invalid_input' using errcode = '22023', detail = 'location';
  end if;
  if p_recorded_at is null or p_recorded_at > now() + interval '1 minute'
     or p_recorded_at < now() - interval '15 minutes' then
    raise exception 'stale_location' using errcode = '22023';
  end if;

  select received_at into v_last from public.location_updates where recipient_id = r.id;
  if v_last is not null and v_last > now() - interval '3 seconds' then
    return jsonb_build_object('stored', false, 'reason', 'throttled');
  end if;

  select location_retention_minutes into v_retention from public.organization_settings where org_id = r.org_id;
  insert into public.location_updates (
    org_id, emergency_id, recipient_id, member_id, lat, lng, accuracy_m, recorded_at, expires_at
  ) values (
    r.org_id, r.emergency_id, r.id, r.member_id, p_lat, p_lng, p_accuracy_m, p_recorded_at,
    now() + make_interval(mins => coalesce(v_retention, 720))
  )
  on conflict (recipient_id) do update set
    lat = excluded.lat, lng = excluded.lng, accuracy_m = excluded.accuracy_m,
    recorded_at = excluded.recorded_at, received_at = now(), expires_at = excluded.expires_at;

  if r.status = 'accepted' then
    update public.emergency_recipients set status = 'en_route' where id = r.id;
  end if;
  return jsonb_build_object('stored', true);
end;
$$;

-- Llegada a la base: la marca el voluntario o un responsable. Detiene el
-- seguimiento.
create function public.mark_arrived(p_recipient uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.emergency_recipients;
  e_status public.emergency_status;
begin
  select * into r from public.emergency_recipients where id = p_recipient for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (private.is_manager(r.org_id) or r.member_id = private.member_id(r.org_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select status into e_status from public.emergencies where id = r.emergency_id;
  if e_status <> 'active' then
    raise exception 'emergency_not_active' using errcode = 'P0001';
  end if;
  if r.status not in ('accepted', 'en_route') then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  update public.emergency_recipients set status = 'arrived' where id = r.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cierre, cancelación, reenvío y contacto alternativo
-- ---------------------------------------------------------------------------
create function private.stop_all_tracking(p_emergency uuid) returns void
language sql security definer set search_path = '' as $$
  update public.emergency_recipients set location_consent = false
  where emergency_id = p_emergency and location_consent;
  delete from public.location_updates where emergency_id = p_emergency;
$$;

create function public.close_emergency(p_emergency uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare e public.emergencies;
begin
  select * into e from public.emergencies where id = p_emergency for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(e.org_id, private.manager_roles());
  if e.status <> 'active' then
    return;
  end if;
  update public.emergencies set status = 'closed', closed_at = now(), closed_by = auth.uid() where id = e.id;
  perform private.stop_all_tracking(e.id);
  insert into public.emergency_status_events (org_id, emergency_id, actor_user_id, event_type, from_status, to_status)
  values (e.org_id, e.id, auth.uid(), 'emergency_closed', 'active', 'closed');
  perform private.audit(e.org_id, 'emergency_closed', 'emergencies', e.id);
end;
$$;

-- Cancela la activación. Quien no había rechazado ni llegado pasa a
-- "cancelled"; la Edge Function avisa a esas personas.
create function public.cancel_emergency(p_emergency uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare e public.emergencies;
begin
  select * into e from public.emergencies where id = p_emergency for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(e.org_id, private.manager_roles());
  if e.status <> 'active' then
    return;
  end if;
  update public.emergencies
  set status = 'cancelled', closed_at = now(), closed_by = auth.uid(), cancel_reason = left(nullif(trim(p_reason), ''), 500)
  where id = e.id;
  update public.emergency_recipients set status = 'cancelled'
  where emergency_id = e.id and status not in ('declined', 'arrived', 'cancelled');
  perform private.stop_all_tracking(e.id);
  insert into public.emergency_status_events (org_id, emergency_id, actor_user_id, event_type, from_status, to_status, details)
  values (e.org_id, e.id, auth.uid(), 'emergency_cancelled', 'active', 'cancelled',
          jsonb_build_object('reason', left(nullif(trim(p_reason), ''), 500)));
  perform private.audit(e.org_id, 'emergency_cancelled', 'emergencies', e.id);
end;
$$;

-- Devuelve los destinatarios a los que reenviar (los que siguen sin contestar).
-- El envío real lo hace la Edge Function con estos ids.
create function public.request_resend(p_emergency uuid, p_recipients uuid[] default null)
returns setof uuid
language plpgsql security definer set search_path = '' as $$
declare e public.emergencies;
begin
  select * into e from public.emergencies where id = p_emergency;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(e.org_id, private.manager_roles());
  if e.status <> 'active' then
    raise exception 'emergency_not_active' using errcode = 'P0001';
  end if;
  insert into public.emergency_status_events (org_id, emergency_id, actor_user_id, event_type, details)
  values (e.org_id, e.id, auth.uid(), 'resend_requested',
          jsonb_build_object('recipients', coalesce(to_jsonb(p_recipients), '"all_pending"'::jsonb)));
  return query
    select r.id from public.emergency_recipients r
    where r.emergency_id = e.id and r.status in ('pending_send', 'sent', 'opened')
      and (p_recipients is null or r.id = any (p_recipients));
end;
$$;

-- Procedimiento alternativo: el responsable deja constancia de que contactó
-- por teléfono (u otro canal) cuando el push no llegó o no hubo respuesta.
create function public.log_manual_contact(p_recipient uuid, p_channel public.delivery_channel default 'manual_call', p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare r public.emergency_recipients;
begin
  select * into r from public.emergency_recipients where id = p_recipient for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.current_member(r.org_id, private.manager_roles());
  if p_channel = 'expo_push' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into public.notification_deliveries (org_id, emergency_id, recipient_id, channel, kind, status, error_message)
  values (r.org_id, r.emergency_id, r.id, p_channel, 'alert', 'manual_contact', left(p_note, 500));
  update public.emergency_recipients set last_manual_contact_at = now() where id = r.id;
  insert into public.emergency_status_events (org_id, emergency_id, recipient_id, actor_user_id, event_type, details)
  values (r.org_id, r.emergency_id, r.id, auth.uid(), 'manual_contact', jsonb_build_object('channel', p_channel));
end;
$$;

-- Solo para el servidor de notificaciones (service_role). Atómico: si el
-- voluntario responde mientras tanto, su respuesta no se pisa.
create function public.record_notification_attempts(
  p_recipients uuid[], p_succeeded uuid[], p_at timestamptz default now()
)
returns void
language sql security definer set search_path = '' as $$
  update public.emergency_recipients
  set notify_attempts = notify_attempts + 1,
      last_notified_at = p_at,
      status = case when id = any (p_succeeded) and status = 'pending_send'
                    then 'sent'::public.recipient_status else status end
  where id = any (p_recipients)
$$;

-- ---------------------------------------------------------------------------
-- Dispositivos
-- ---------------------------------------------------------------------------
create function public.register_push_token(
  p_token text, p_platform public.device_platform, p_device_label text default null, p_app_version text default null
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_token is null or p_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$' then
    raise exception 'invalid_input' using errcode = '22023', detail = 'token';
  end if;
  -- Un dispositivo pertenece a quien inició sesión en él por última vez.
  insert into public.push_tokens (user_id, token, platform, device_label, app_version)
  values (auth.uid(), p_token, p_platform, left(p_device_label, 80), left(p_app_version, 40))
  on conflict (token) do update set
    user_id = auth.uid(), platform = excluded.platform, device_label = excluded.device_label,
    app_version = excluded.app_version, last_seen_at = now(), revoked_at = null, revoked_reason = null
  returning id into v_id;
  return v_id;
end;
$$;

create function public.unregister_push_token(p_token text)
returns void
language sql security definer set search_path = '' as $$
  update public.push_tokens set revoked_at = now(), revoked_reason = 'user_logout'
  where token = p_token and user_id = auth.uid() and revoked_at is null
$$;

-- ---------------------------------------------------------------------------
-- Reglas de estado de los destinatarios (válidas para cualquier camino de
-- escritura, incluida la Edge Function con service_role)
-- ---------------------------------------------------------------------------
create function private.recipient_before_update() returns trigger
language plpgsql set search_path = '' as $$
declare allowed boolean;
begin
  if new.status is distinct from old.status then
    allowed := case old.status
      when 'pending_send' then new.status in ('sent', 'opened', 'accepted', 'declined', 'cancelled')
      when 'sent'         then new.status in ('opened', 'accepted', 'declined', 'cancelled')
      when 'opened'       then new.status in ('accepted', 'declined', 'cancelled')
      when 'accepted'     then new.status in ('en_route', 'arrived', 'declined', 'cancelled')
      when 'en_route'     then new.status in ('arrived', 'declined', 'cancelled')
      when 'declined'     then new.status in ('accepted', 'cancelled')
      else false
    end;
    if not allowed then
      raise exception 'invalid_transition' using errcode = 'P0001',
        detail = format('%s -> %s', old.status, new.status);
    end if;
    new.status_changed_at := now();
    case new.status
      when 'opened' then new.opened_at := coalesce(new.opened_at, now());
      when 'accepted' then new.responded_at := now();
      when 'declined' then new.responded_at := now();
      when 'en_route' then new.en_route_at := coalesce(new.en_route_at, now());
      when 'arrived' then new.arrived_at := now();
      else null;
    end case;
    if new.status in ('accepted', 'declined') and new.opened_at is null then
      new.opened_at := now();
    end if;
  end if;

  -- Fuera de "acude / en camino" no hay seguimiento posible.
  if new.status not in ('accepted', 'en_route') then
    new.location_consent := false;
  end if;
  if new.location_consent and not old.location_consent then
    new.location_consent_at := now();
    new.tracking_stopped_at := null;
  elsif old.location_consent and not new.location_consent then
    new.tracking_stopped_at := now();
  end if;
  return new;
end;
$$;

create trigger recipient_before_update before update on public.emergency_recipients
  for each row execute function private.recipient_before_update();

create function private.recipient_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into public.emergency_status_events (
      org_id, emergency_id, recipient_id, actor_user_id, event_type, from_status, to_status
    ) values (new.org_id, new.emergency_id, new.id, auth.uid(), 'recipient_status', old.status, new.status);
  end if;
  if new.location_consent is distinct from old.location_consent then
    insert into public.emergency_status_events (
      org_id, emergency_id, recipient_id, actor_user_id, event_type, to_status
    ) values (
      new.org_id, new.emergency_id, new.id, auth.uid(),
      case when new.location_consent then 'location_consent' else 'tracking_stopped' end,
      case when new.location_consent then 'granted' else 'stopped' end
    );
  end if;
  if not new.location_consent then
    delete from public.location_updates where recipient_id = new.id;
  end if;
  return null;
end;
$$;

create trigger recipient_after_update after update on public.emergency_recipients
  for each row execute function private.recipient_after_update();

-- ---------------------------------------------------------------------------
-- Vistas (security_invoker: aplican la RLS de quien consulta)
-- ---------------------------------------------------------------------------
create view public.shift_coverage with (security_invoker = true) as
select
  s.id, s.org_id, s.title, s.starts_at, s.ends_at, s.status, s.min_volunteers, s.max_volunteers,
  s.responsable_member_id, s.base_id,
  count(x.id) filter (where x.status <> 'cancelled') as signed_up_count,
  count(x.id) filter (where x.status = 'confirmed') as confirmed_count,
  case
    when s.status = 'cancelled' then 'cancelled'
    when count(x.id) filter (where x.status <> 'cancelled') < s.min_volunteers then 'below_minimum'
    else 'covered'
  end as coverage
from public.shifts s
left join public.shift_signups x on x.shift_id = s.id
group by s.id;

-- Agenda unificada: guardias + eventos.
create view public.agenda_items with (security_invoker = true) as
select s.id, s.org_id, 'shift'::text as kind, s.title, s.notes as description, s.starts_at, s.ends_at,
       null::text as location_text, s.base_id, s.status::text as status, s.max_volunteers as capacity
from public.shifts s
union all
select e.id, e.org_id, e.type::text, e.title, e.description, e.starts_at, e.ends_at,
       e.location_text, e.base_id, e.status::text, e.capacity
from public.events e;

grant select on public.shift_coverage, public.agenda_items to authenticated;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución: nada para anon/public; authenticated solo la API.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema public to authenticated, service_role;
grant execute on all functions in schema private to service_role;
revoke execute on function public.record_notification_attempts(uuid[], uuid[], timestamptz) from authenticated;
-- La RLS evalúa estas funciones con el rol de quien consulta.
grant execute on function
  private.member_id(uuid), private.has_role(uuid, public.member_role[]), private.is_member(uuid),
  private.is_manager(uuid), private.is_admin(uuid), private.can_view_profile(uuid),
  private.is_recipient(uuid), private.valid_coordinates(double precision, double precision)
to authenticated;
