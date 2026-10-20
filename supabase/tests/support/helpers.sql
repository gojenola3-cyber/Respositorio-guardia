-- Ayudantes para las pruebas SQL. Solo se cargan en la base de pruebas.
create schema tests;
grant usage on schema tests to authenticated, anon, service_role;

-- Autentica como un usuario igual que PostgREST: claims del JWT + rol.
create function tests.login(p_email text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform set_config('role', 'postgres', false);
  select id into v_id from auth.users where email = p_email;
  if v_id is null then
    raise exception 'tests.login: no existe %', p_email;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'email', p_email, 'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
  return v_id;
end;
$$;

-- Vuelve a superusuario (para preparar datos) sin identidad.
create function tests.as_admin() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', false);
  perform set_config('request.jwt.claims', '', false);
end;
$$;

create function tests.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', false);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, false);
  perform set_config('role', 'anon', false);
end;
$$;

-- Fija claims sin cambiar de rol (para preparar datos llamando a RPC).
create function tests.claims(p_email text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where email = p_email;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_id, 'email', p_email, 'role', 'authenticated')::text, false);
  return v_id;
end;
$$;

-- Ejecuta p_sql y exige que falle con el mensaje p_message.
create function tests.throws(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm = p_message then
      raise notice 'ok - %', p_label;
      return;
    end if;
    raise exception 'FALLO: % -> esperado error "%", obtenido "%"', p_label, p_message, sqlerrm;
  end;
  raise exception 'FALLO: % -> esperado error "%", no falló', p_label, p_message;
end;
$$;

create function tests.ok(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FALLO: %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;

create function tests.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FALLO: % -> esperado %, obtenido %', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok - %', p_label;
end;
$$;

create function tests.create_user(p_email text, p_first text, p_last text) returns uuid
language sql as $$
  insert into auth.users (email, raw_user_meta_data)
  values (p_email, jsonb_build_object('first_name', p_first, 'last_name', p_last))
  returning id
$$;

-- Entorno de ejemplo: dos organizaciones con sus miembros.
--   cruz (Lekeitio): ana (admin), rafa (responsable), vera, victor, valen,
--                    pili (pendiente)
--   otra (Gernika): olga (admin), oscar (voluntario)
-- Guarda los ids en tests.ids(key, id) para usarlos en las pruebas.
create table tests.ids (key text primary key, id uuid not null);
grant select on tests.ids to authenticated, anon, service_role;

create function tests.fixture() returns void
language plpgsql as $$
declare
  v_org uuid;
  v_other uuid;
  v_tok text;
  u record;
begin
  perform tests.as_admin();
  delete from tests.ids;
  for u in select * from (values
    ('ana@cruz.test', 'Ana', 'Admin'), ('rafa@cruz.test', 'Rafa', 'Responsable'),
    ('vera@cruz.test', 'Vera', 'Voluntaria'), ('victor@cruz.test', 'Víctor', 'Voluntario'),
    ('valen@cruz.test', 'Valen', 'Voluntaria'), ('pili@cruz.test', 'Pili', 'Pendiente'),
    ('olga@otra.test', 'Olga', 'Otra'), ('oscar@otra.test', 'Óscar', 'Otro')
  ) t(email, first, last) loop
    insert into tests.ids values (split_part(u.email, '@', 1), tests.create_user(u.email, u.first, u.last));
  end loop;

  perform tests.claims('ana@cruz.test');
  v_org := public.create_organization('Cruz Lekeitio', 'cruz-lekeitio');
  insert into tests.ids values ('org', v_org);
  insert into public.bases (org_id, name, address, lat, lng, is_default)
  values (v_org, 'Base del puerto', 'Puerto de Lekeitio', 43.3622, -2.5049, true);

  foreach v_tok in array array['rafa:responsable', 'vera:voluntario', 'victor:voluntario', 'valen:voluntario'] loop
    perform tests.claims('ana@cruz.test');
    declare
      who text := split_part(v_tok, ':', 1);
      tok text;
    begin
      tok := public.invite_member(v_org, who || '@cruz.test', split_part(v_tok, ':', 2)::public.member_role);
      perform tests.claims(who || '@cruz.test');
      insert into tests.ids values ('m_' || who, public.accept_invitation(tok));
    end;
  end loop;
  insert into tests.ids select 'm_ana', id from public.organization_members where org_id = v_org and role = 'admin';

  perform tests.claims('pili@cruz.test');
  insert into tests.ids values ('m_pili', public.request_membership('cruz-lekeitio'));

  perform tests.claims('olga@otra.test');
  v_other := public.create_organization('Otra Gernika', 'otra-gernika');
  insert into tests.ids values ('other_org', v_other);
  v_tok := public.invite_member(v_other, 'oscar@otra.test', 'voluntario');
  perform tests.claims('oscar@otra.test');
  insert into tests.ids values ('m_oscar', public.accept_invitation(v_tok));

  perform tests.as_admin();
end;
$$;

create function tests.id(p_key text) returns uuid
language sql stable as $$ select id from tests.ids where key = p_key $$;

grant execute on all functions in schema tests to authenticated, anon, service_role;
