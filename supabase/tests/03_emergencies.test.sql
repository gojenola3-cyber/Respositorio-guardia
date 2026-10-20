-- Activación de emergencias: candidatos, selección, envío, respuestas,
-- seguimiento GPS, cierre, cancelación e historial.
\set QUIET on
select tests.fixture();

-- Preparación: cualificaciones, guardia en curso y disponibilidad
select tests.login('ana@cruz.test');
insert into public.qualifications (org_id, code, name, has_expiry) values
  (tests.id('org'), 'SVB', 'Soporte vital básico', true);
select tests.as_admin();
insert into tests.ids select 'q_svb', id from public.qualifications where code = 'SVB' and org_id = tests.id('org');
select tests.login('ana@cruz.test');
insert into public.member_qualifications (org_id, member_id, qualification_id, obtained_on, expires_on) values
  (tests.id('org'), tests.id('m_vera'), tests.id('q_svb'), current_date - 100, current_date + 300),
  (tests.id('org'), tests.id('m_victor'), tests.id('q_svb'), current_date - 800, current_date - 1);
select tests.login('rafa@cruz.test');
insert into public.shifts (org_id, title, starts_at, ends_at) values
  (tests.id('org'), 'Guardia en curso', now() - interval '2 hours', now() + interval '4 hours');
select tests.as_admin();
insert into tests.ids select 'shift_now', id from public.shifts where title = 'Guardia en curso';
select tests.login('vera@cruz.test');
select public.sign_up_for_shift(tests.id('shift_now'));
select public.register_push_token('ExponentPushToken[abcdefghijklmnop]', 'ios', 'iPhone de Vera');
select tests.throws($$select public.register_push_token('no-es-un-token', 'ios')$$, 'invalid_input',
  'se rechazan tokens push con formato no válido');
select tests.login('victor@cruz.test');
select public.sign_up_for_shift(tests.id('shift_now'));
select tests.login('valen@cruz.test');
select public.set_my_availability(tests.id('org'), 'available');

-- [4] Candidatos: elegibles marcados por defecto
select tests.login('rafa@cruz.test');
create temporary table cand as select * from public.get_emergency_candidates(tests.id('org'));
select tests.eq((select count(*) from cand), 5::bigint, 'aparecen todos los miembros activos (no el pendiente)');
select tests.ok((select bool_and(selected_by_default) from cand where member_id in (tests.id('m_vera'), tests.id('m_victor'), tests.id('m_valen'))),
  'de guardia y disponibles aparecen seleccionados por defecto');
select tests.ok((select bool_and(selected_by_default = eligible) from cand), 'seleccionado por defecto = elegible');
select tests.eq((select ineligible_reason from cand where member_id = tests.id('m_ana')), 'not_available',
  'quien no está de guardia ni disponible aparece como no elegible con motivo');
select tests.eq((select ineligible_reason from cand where member_id = tests.id('m_rafa')), 'self',
  'quien activa no se avisa a sí mismo');
select tests.ok((select on_shift and not shift_confirmed and has_push_device from cand where member_id = tests.id('m_vera')),
  'se distingue guardia inscrita de confirmada y si tiene dispositivo');
select tests.ok((select not on_shift and availability = 'available' from cand where member_id = tests.id('m_valen')),
  'se distingue disponibilidad declarada de estar de guardia');
drop table cand;

-- Requisitos de formación: la acreditación caducada no cuenta
create temporary table cand as select * from public.get_emergency_candidates(tests.id('org'), array[tests.id('q_svb')]);
select tests.ok((select eligible from cand where member_id = tests.id('m_vera')), 'con SVB vigente es elegible');
select tests.eq((select missing_qualification_codes from cand where member_id = tests.id('m_victor')), array['SVB'],
  'con SVB caducado falta la cualificación');
select tests.eq((select ineligible_reason from cand where member_id = tests.id('m_valen')), 'missing_qualifications',
  'sin la cualificación requerida no es elegible');
drop table cand;

-- Validación en servidor
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.create_emergency(%L, gen_random_uuid(), 'Rescate', array[%L]::uuid[])$$,
  tests.id('org'), tests.id('m_victor')), 'forbidden', 'un voluntario no puede activar emergencias');
select tests.login('rafa@cruz.test');
select tests.throws(format($$select public.create_emergency(%L, gen_random_uuid(), 'Rescate', '{}')$$, tests.id('org')),
  'no_recipients', 'no se activa sin destinatarios');
select tests.throws(format($$select public.create_emergency(%L, gen_random_uuid(), 'Rescate', array[%L]::uuid[])$$,
  tests.id('org'), tests.id('m_oscar')), 'invalid_recipients', 'no se puede avisar a miembros de otra organización');
select tests.throws(format($$select public.create_emergency(%L, gen_random_uuid(), 'Rescate', array[%L]::uuid[])$$,
  tests.id('org'), tests.id('m_pili')), 'invalid_recipients', 'no se puede avisar a miembros no activos');
select tests.throws(format($$select public.create_emergency(%L, gen_random_uuid(), 'Rescate', array[%L]::uuid[], p_lat => 95, p_lng => 0)$$,
  tests.id('org'), tests.id('m_vera')), 'invalid_input', 'se rechazan coordenadas imposibles');

-- [3] [5] Crear la emergencia excluyendo a Víctor con un motivo privado
select set_config('tests.key', gen_random_uuid()::text, false);
select set_config('tests.e1', public.create_emergency(
  tests.id('org'), current_setting('tests.key')::uuid, 'Bañista arrastrado en Isuntza',
  array[tests.id('m_vera'), tests.id('m_valen')],
  p_address => 'Playa de Isuntza', p_lat => 43.3606, p_lng => -2.5057, p_priority => 'critical',
  p_exclusion_reasons => jsonb_build_object(tests.id('m_victor'), 'Baja médica temporal')
)::text, false);
select tests.ok(current_setting('tests.e1') <> '', 'un responsable crea una emergencia');
select tests.eq((select count(*) from public.emergency_recipients where emergency_id = current_setting('tests.e1')::uuid),
  2::bigint, 'solo se crean alertas para los seleccionados');
select tests.ok((select bool_and(status = 'pending_send') from public.emergency_recipients where emergency_id = current_setting('tests.e1')::uuid),
  'cada alerta empieza "pendiente de envío"');
select tests.eq((select reason from public.emergency_exclusions where emergency_id = current_setting('tests.e1')::uuid and member_id = tests.id('m_victor')),
  'Baja médica temporal', 'la exclusión manual guarda el motivo');
select tests.eq((select kind from public.emergency_exclusions where emergency_id = current_setting('tests.e1')::uuid and member_id = tests.id('m_ana')),
  'ineligible'::public.exclusion_kind, 'los no elegibles quedan registrados como tales');
select tests.ok((select base_id is not null from public.emergencies where id = current_setting('tests.e1')::uuid),
  'sin base indicada se usa la base por defecto');

-- [14] Doble pulsación o reintento: misma emergencia, sin duplicados
select tests.eq(public.create_emergency(tests.id('org'), current_setting('tests.key')::uuid, 'Bañista arrastrado en Isuntza',
  array[tests.id('m_vera'), tests.id('m_valen'), tests.id('m_victor')])::text, current_setting('tests.e1'),
  'repetir la petición devuelve la misma emergencia');
select tests.eq((select count(*) from public.emergencies), 1::bigint, 'no se crea una segunda emergencia');
select tests.eq((select count(*) from public.emergency_recipients), 2::bigint, 'no se duplican alertas');

select tests.as_admin();
insert into tests.ids select 'r_' || split_part(p.email, '@', 1), r.id
from public.emergency_recipients r join public.organization_members m on m.id = r.member_id
join public.profiles p on p.id = m.user_id where r.emergency_id = current_setting('tests.e1')::uuid;

-- [6] Solo los destinatarios la ven
select tests.login('vera@cruz.test');
select tests.eq((select count(*) from public.emergencies), 1::bigint, 'la destinataria ve la emergencia');
select tests.eq((select count(*) from public.emergency_recipients), 1::bigint, 'la destinataria ve solo su propia alerta');
select tests.eq((select count(*) from public.emergency_exclusions), 0::bigint, 'los voluntarios no ven exclusiones ni motivos');
select tests.eq((public.emergency_counts(current_setting('tests.e1')::uuid) ->> 'total')::int, 2,
  'la destinataria ve el recuento global');
select tests.login('victor@cruz.test');
select tests.eq((select count(*) from public.emergencies), 0::bigint, 'el excluido no ve la emergencia');
select tests.throws(format($$select public.emergency_counts(%L)$$, current_setting('tests.e1')),
  'forbidden', 'el excluido no puede consultar el recuento');
select tests.throws(format($$select public.respond_to_alert(%L, true)$$, tests.id('r_vera')),
  'forbidden', 'nadie puede responder la alerta de otra persona');
-- [2] Otra organización
select tests.login('olga@otra.test');
select tests.eq((select count(*) from public.emergencies), 0::bigint, 'el admin de otra organización no ve la emergencia');
select tests.throws(format($$select public.close_emergency(%L)$$, current_setting('tests.e1')),
  'forbidden', 'el admin de otra organización no puede cerrarla');

-- [10] Sin aceptar no hay ubicación
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.report_location(%L, 43.33, -2.6)$$, tests.id('r_vera')),
  'location_not_authorized', 'no se acepta ubicación antes de aceptar');
select tests.throws(format($$select public.set_location_consent(%L, true)$$, tests.id('r_vera')),
  'must_accept_first', 'no se puede autorizar ubicación sin aceptar antes');

-- Apertura confirmada por la app
select tests.eq(public.mark_alert_opened(tests.id('r_vera')), 'opened'::public.recipient_status,
  'abrir la alerta en la app la marca como abierta');

-- [7] Acepta
select tests.eq(public.respond_to_alert(tests.id('r_vera'), true), 'accepted'::public.recipient_status, 'la voluntaria acepta');
select tests.throws(format($$select public.report_location(%L, 43.33, -2.6)$$, tests.id('r_vera')),
  'location_not_authorized', 'aceptar no implica compartir ubicación sin autorización expresa');
select public.set_location_consent(tests.id('r_vera'), true);
select tests.eq((public.report_location(tests.id('r_vera'), 43.3167, -2.6786, 12) ->> 'stored')::boolean, true,
  'con aceptación y autorización se guarda la posición');
select tests.eq((public.report_location(tests.id('r_vera'), 43.3168, -2.6785, 12) ->> 'reason'), 'throttled',
  'las posiciones demasiado seguidas se descartan (límite de frecuencia)');
select tests.throws(format($$select public.report_location(%L, 43.3, -2.6, 10, now() - interval '1 hour')$$, tests.id('r_vera')),
  'stale_location', 'se rechazan posiciones antiguas');

-- [8] Rechaza
select tests.login('valen@cruz.test');
select tests.eq(public.respond_to_alert(tests.id('r_valen'), false), 'declined'::public.recipient_status, 'el voluntario rechaza');
select tests.throws(format($$select public.set_location_consent(%L, true)$$, tests.id('r_valen')),
  'must_accept_first', 'quien rechaza no puede compartir ubicación');
select tests.eq((select count(*) from public.location_updates), 0::bigint, 'un voluntario no ve la ubicación de otros');

-- [9] El panel del responsable refleja las respuestas
select tests.login('rafa@cruz.test');
select tests.eq((select status from public.emergency_recipients where id = tests.id('r_vera')), 'en_route'::public.recipient_status,
  'el responsable ve que va en camino');
select tests.eq((select status from public.emergency_recipients where id = tests.id('r_valen')), 'declined'::public.recipient_status,
  'el responsable ve el rechazo');
select tests.eq(public.emergency_counts(current_setting('tests.e1')::uuid),
  '{"total": 2, "en_route": 1, "declined": 1}'::jsonb, 'el recuento por estados es correcto');
select tests.ok((select responded_at is not null and opened_at is not null from public.emergency_recipients where id = tests.id('r_valen')),
  'se registra la hora de la respuesta');
select tests.eq((select count(*) from public.location_updates where recipient_id = tests.id('r_vera')), 1::bigint,
  'el responsable ve la posición de quien acude y autorizó');

-- Cambia de opinión: rechazar detiene el seguimiento y borra la posición
select tests.login('vera@cruz.test');
select public.respond_to_alert(tests.id('r_vera'), false);
select tests.login('rafa@cruz.test');
select tests.eq((select count(*) from public.location_updates), 0::bigint, 'al rechazar se borra su posición');
select tests.ok((select not location_consent and tracking_stopped_at is not null from public.emergency_recipients where id = tests.id('r_vera')),
  'al rechazar se detiene el seguimiento');

-- Vuelve a aceptar, comparte y llega a la base
select tests.login('vera@cruz.test');
select public.respond_to_alert(tests.id('r_vera'), true);
select public.set_location_consent(tests.id('r_vera'), true);
select public.report_location(tests.id('r_vera'), 43.35, -2.52, 20);
select public.mark_arrived(tests.id('r_vera'));
select tests.login('rafa@cruz.test');
select tests.ok((select status = 'arrived' and arrived_at is not null and not location_consent
                 from public.emergency_recipients where id = tests.id('r_vera')),
  'al llegar a la base se registra la llegada y termina el seguimiento');
select tests.eq((select count(*) from public.location_updates), 0::bigint, 'al llegar se borra la posición');

-- Historial: quién y cuándo
select tests.eq((select array_agg(from_status || '>' || to_status order by id) from public.emergency_status_events
                 where recipient_id = tests.id('r_vera') and event_type = 'recipient_status'),
  array['pending_send>opened', 'opened>accepted', 'accepted>en_route', 'en_route>declined',
        'declined>accepted', 'accepted>en_route', 'en_route>arrived'],
  'el historial guarda cada cambio de estado en orden');
select tests.ok((select bool_and(actor_user_id = tests.id('vera')) from public.emergency_status_events
                 where recipient_id = tests.id('r_vera') and event_type = 'recipient_status'),
  'cada cambio guarda quién lo hizo');
select tests.as_admin();
select tests.throws(format($$update public.emergency_recipients set status = 'sent' where id = %L$$, tests.id('r_vera')),
  'invalid_transition', 'las transiciones de estado imposibles se rechazan incluso con service_role');
select tests.throws('delete from public.emergency_status_events', 'append_only', 'el historial no se puede borrar');

-- Reenvío y contacto alternativo
select tests.login('rafa@cruz.test');
select tests.eq((select count(*) from public.request_resend(current_setting('tests.e1')::uuid)), 0::bigint,
  'no se reenvía a quien ya respondió');
select public.log_manual_contact(tests.id('r_valen'), 'manual_call', 'Llamada: confirma que no puede');
select tests.eq((select status from public.notification_deliveries where recipient_id = tests.id('r_valen')),
  'manual_contact'::public.delivery_status, 'el contacto por teléfono queda registrado');
select tests.login('vera@cruz.test');
select tests.eq((select count(*) from public.notification_deliveries), 0::bigint, 'los voluntarios no ven el registro de envíos');
select tests.throws(format($$select * from public.request_resend(%L)$$, current_setting('tests.e1')),
  'forbidden', 'un voluntario no puede reenviar alertas');

-- [11] Cerrar la activación detiene el seguimiento de todos
select tests.login('rafa@cruz.test');
select set_config('tests.e2', public.create_emergency(tests.id('org'), gen_random_uuid(), 'Incendio en monte',
  array[tests.id('m_vera'), tests.id('m_victor')])::text, false);
select tests.as_admin();
insert into tests.ids select 'r2_' || split_part(p.email, '@', 1), r.id
from public.emergency_recipients r join public.organization_members m on m.id = r.member_id
join public.profiles p on p.id = m.user_id where r.emergency_id = current_setting('tests.e2')::uuid;
select tests.login('vera@cruz.test');
select public.respond_to_alert(tests.id('r2_vera'), true);
select public.set_location_consent(tests.id('r2_vera'), true);
select public.report_location(tests.id('r2_vera'), 43.34, -2.55, 15);
select tests.login('rafa@cruz.test');
select tests.eq((select count(*) from public.request_resend(current_setting('tests.e2')::uuid)), 1::bigint,
  'el reenvío incluye solo a quien sigue sin responder');
select public.close_emergency(current_setting('tests.e2')::uuid);
select tests.eq((select count(*) from public.location_updates where emergency_id = current_setting('tests.e2')::uuid), 0::bigint,
  'al cerrar se borran todas las posiciones');
select tests.ok((select bool_and(not location_consent) from public.emergency_recipients where emergency_id = current_setting('tests.e2')::uuid),
  'al cerrar se retira el seguimiento');
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.report_location(%L, 43.34, -2.55)$$, tests.id('r2_vera')),
  'emergency_not_active', 'tras el cierre no se acepta ubicación');
select tests.login('victor@cruz.test');
select tests.throws(format($$select public.respond_to_alert(%L, true)$$, tests.id('r2_victor')),
  'emergency_not_active', 'tras el cierre no se puede responder');

-- Cancelación: los no respondidos pasan a cancelados
select tests.login('rafa@cruz.test');
select set_config('tests.e3', public.create_emergency(tests.id('org'), gen_random_uuid(), 'Falsa alarma',
  array[tests.id('m_vera'), tests.id('m_victor')])::text, false);
select public.cancel_emergency(current_setting('tests.e3')::uuid, 'Resuelto por otro equipo');
select tests.ok((select bool_and(status = 'cancelled') from public.emergency_recipients where emergency_id = current_setting('tests.e3')::uuid),
  'al cancelar, las alertas pendientes pasan a canceladas');
select tests.eq((select cancel_reason from public.emergencies where id = current_setting('tests.e3')::uuid),
  'Resuelto por otro equipo', 'se guarda el motivo de cancelación');
select tests.eq((select count(*) from public.audit_logs), 0::bigint, 'un responsable no ve la auditoría (solo admins)');
select tests.ok(exists (select 1 from public.emergency_status_events where event_type = 'emergency_cancelled'
                        and actor_user_id = tests.id('rafa')),
  'el responsable sí ve el historial de la emergencia');
select tests.login('ana@cruz.test');
select tests.ok(exists (select 1 from public.audit_logs where action = 'emergency_cancelled' and actor_user_id = tests.id('rafa')),
  'la cancelación queda auditada con su autor');
