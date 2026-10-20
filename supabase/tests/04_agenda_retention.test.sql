-- Agenda, caducidad de ubicaciones, retención y operaciones del servidor
-- de notificaciones (service_role).
\set QUIET on
select tests.fixture();

-- Agenda
select tests.login('vera@cruz.test');
select tests.throws(format($$insert into public.events (org_id, type, title, starts_at, ends_at) values (%L, 'practice', 'Práctica', now() + interval '1 day', now() + interval '1 day 2 hours')$$, tests.id('org')),
  'new row violates row-level security policy for table "events"', 'un voluntario no crea eventos');
select tests.login('rafa@cruz.test');
insert into public.events (org_id, type, title, starts_at, ends_at, location_text, capacity) values
  (tests.id('org'), 'training', 'Curso de primeros auxilios', now() + interval '3 days', now() + interval '3 days 4 hours', 'Aula de la base', 1),
  (tests.id('org'), 'maintenance', 'Revisión de la embarcación', now() + interval '5 days', now() + interval '5 days 2 hours', 'Puerto', null);
insert into public.shifts (org_id, title, starts_at, ends_at) values
  (tests.id('org'), 'Guardia fin de semana', now() + interval '4 days', now() + interval '4 days 12 hours');
select tests.as_admin();
insert into tests.ids select 'ev_curso', id from public.events where title like 'Curso%';
select tests.login('vera@cruz.test');
select tests.eq((select array_agg(kind order by starts_at) from public.agenda_items), array['training', 'shift', 'maintenance'],
  'la agenda une guardias y eventos en orden');
select tests.ok(public.sign_up_for_event(tests.id('ev_curso')) is not null, 'un voluntario se inscribe a un curso');
select tests.throws(format($$select public.sign_up_for_event(%L)$$, tests.id('ev_curso')),
  'duplicate_signup', 'no se inscribe dos veces al mismo evento');
select tests.login('victor@cruz.test');
select tests.throws(format($$select public.sign_up_for_event(%L)$$, tests.id('ev_curso')),
  'event_full', 'no se admiten inscripciones sin plazas');
select tests.login('rafa@cruz.test');
update public.events set status = 'cancelled', cancel_reason = 'Instructor enfermo' where id = tests.id('ev_curso');
select tests.login('victor@cruz.test');
select tests.throws(format($$select public.sign_up_for_event(%L)$$, tests.id('ev_curso')),
  'event_not_open', 'no se inscribe a eventos cancelados');
select tests.login('oscar@otra.test');
select tests.eq((select count(*) from public.agenda_items), 0::bigint, 'la agenda no se ve desde otra organización');

-- Ubicaciones caducadas: invisibles al momento, borradas por la purga
select tests.login('rafa@cruz.test');
select set_config('tests.e', public.create_emergency(tests.id('org'), gen_random_uuid(), 'Búsqueda en monte',
  array[tests.id('m_vera')])::text, false);
select tests.as_admin();
insert into tests.ids select 'r_vera', id from public.emergency_recipients where emergency_id = current_setting('tests.e')::uuid;
select tests.login('vera@cruz.test');
select public.respond_to_alert(tests.id('r_vera'), true);
select public.set_location_consent(tests.id('r_vera'), true);
select public.report_location(tests.id('r_vera'), 43.30, -2.50, 30);
select tests.as_admin();
update public.location_updates set expires_at = now() - interval '1 second' where recipient_id = tests.id('r_vera');
select tests.login('rafa@cruz.test');
select tests.eq((select count(*) from public.location_updates), 0::bigint, 'una posición caducada deja de verse');
select tests.as_admin();
set local role service_role;
select tests.eq((private.run_retention() ->> 'locations')::int, 1, 'la purga borra las posiciones caducadas');
reset role;

-- Servidor de notificaciones (service_role, la Edge Function)
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.record_notification_attempts(array[%L]::uuid[], '{}')$$, tests.id('r_vera')),
  'permission denied for function record_notification_attempts', 'solo el servidor registra intentos de envío');
select tests.as_admin();
set local role service_role;
select public.record_notification_attempts(array[tests.id('r_vera')], array[tests.id('r_vera')]);
select tests.eq((select status from public.emergency_recipients where id = tests.id('r_vera')), 'en_route'::public.recipient_status,
  'registrar el envío no pisa el estado de quien ya va en camino');
select tests.eq((select notify_attempts from public.emergency_recipients where id = tests.id('r_vera')), 1,
  'se cuenta el intento de envío');
insert into public.notification_deliveries (org_id, emergency_id, recipient_id, channel, kind, status, provider_ticket_id)
values (tests.id('org'), current_setting('tests.e')::uuid, tests.id('r_vera'), 'expo_push', 'alert', 'provider_accepted', 'ticket-1');
reset role;
select tests.login('rafa@cruz.test');
select tests.eq((select status from public.notification_deliveries where provider_ticket_id = 'ticket-1'),
  'provider_accepted'::public.delivery_status, 'el responsable ve el resultado del envío');

-- Retención de emergencias antiguas
select tests.as_admin();
select public.close_emergency(current_setting('tests.e')::uuid) from (select tests.claims('rafa@cruz.test')) x;
select tests.as_admin();
update public.organization_settings set emergency_retention_days = 30 where org_id = tests.id('org');
update public.emergencies set closed_at = now() - interval '31 days' where id = current_setting('tests.e')::uuid;
set local role service_role;
select tests.eq((private.run_retention() ->> 'emergencies')::int, 1, 'las emergencias fuera del plazo de retención se borran');
reset role;
select tests.eq((select count(*) from public.emergency_status_events where emergency_id = current_setting('tests.e')::uuid), 0::bigint,
  'con la emergencia se borra su historial (tras el plazo configurado)');

-- Configuración: solo admins
select tests.login('rafa@cruz.test');
update public.organization_settings set max_resends = 9 where org_id = tests.id('org');
select tests.as_admin();
select tests.eq((select max_resends from public.organization_settings where org_id = tests.id('org')), 3,
  'un responsable no cambia la configuración');
select tests.login('ana@cruz.test');
update public.organization_settings set max_resends = 5 where org_id = tests.id('org');
select tests.eq((select max_resends from public.organization_settings where org_id = tests.id('org')), 5,
  'un admin sí cambia la configuración');
select tests.throws(format($$update public.organization_settings set location_retention_minutes = 100000 where org_id = %L$$, tests.id('org')),
  'new row for relation "organization_settings" violates check constraint "organization_settings_location_retention_minutes_check"',
  'los parámetros tienen límites en servidor');
