-- Réplica mínima de lo que Supabase ya trae de serie, SOLO para ejecutar las
-- pruebas sobre un PostgreSQL normal. No se aplica nunca en producción.
--
-- Reproduce: roles anon/authenticated/service_role, esquema auth con
-- auth.users, auth.uid() y auth.jwt() leyendo los claims del JWT como hace
-- PostgREST, los privilegios por defecto (que conceden TODO a anon y
-- authenticated: las migraciones deben retirarlos) y la publicación de Realtime.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Igual que Supabase: todo lo que se cree en public queda concedido a los roles
-- de la API salvo que la migración lo revoque.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

set client_min_messages = error;
create publication supabase_realtime;
