-- Guardias: inscripción, duplicados, solapes, plazas y cobertura.
\set QUIET on
select tests.fixture();

select tests.login('rafa@cruz.test');
insert into public.shifts (org_id, title, starts_at, ends_at, min_volunteers, max_volunteers)
values
  (tests.id('org'), 'Mañana', date_trunc('hour', now()) + interval '1 day', date_trunc('hour', now()) + interval '1 day 6 hours', 2, 2),
  (tests.id('org'), 'Solapada', date_trunc('hour', now()) + interval '1 day 3 hours', date_trunc('hour', now()) + interval '1 day 9 hours', 0, null),
  (tests.id('org'), 'Pasada', now() - interval '1 day', now() - interval '20 hours', 0, null);
select tests.as_admin();
insert into tests.ids select 'shift_' || lower(title), id from public.shifts where org_id = tests.id('org');
select tests.ok((select created_by = tests.id('rafa') from public.shifts where id = tests.id('shift_mañana')),
  'la guardia registra quién la creó (no se puede falsear)');

select tests.login('vera@cruz.test');
select tests.ok(public.sign_up_for_shift(tests.id('shift_mañana')) is not null, 'un voluntario se apunta a una guardia');
-- [12] duplicados
select tests.throws(format($$select public.sign_up_for_shift(%L)$$, tests.id('shift_mañana')),
  'duplicate_signup', 'no se puede apuntar dos veces a la misma guardia');
select tests.throws(format($$select public.sign_up_for_shift(%L)$$, tests.id('shift_solapada')),
  'overlapping_shift', 'no se puede estar en dos guardias que se solapan');
select tests.throws(format($$select public.sign_up_for_shift(%L)$$, tests.id('shift_pasada')),
  'shift_finished', 'no se puede apuntar a una guardia terminada');
select tests.throws(format($$insert into public.shift_signups (org_id, shift_id, member_id) values (%L, %L, %L)$$,
  tests.id('org'), tests.id('shift_mañana'), tests.id('m_victor')),
  'permission denied for table shift_signups', 'nadie puede apuntar a otra persona con INSERT directo');

-- Cobertura por debajo del mínimo
select tests.eq((select coverage from public.shift_coverage where id = tests.id('shift_mañana')), 'below_minimum',
  'la guardia con 1 de 2 personas mínimas aparece sin cubrir');

select tests.login('victor@cruz.test');
select public.sign_up_for_shift(tests.id('shift_mañana'));
select tests.eq((select coverage from public.shift_coverage where id = tests.id('shift_mañana')), 'covered',
  'con 2 personas la guardia queda cubierta');
select tests.eq((select status from public.shifts where id = tests.id('shift_mañana')), 'full'::public.shift_status,
  'al llenarse las plazas pasa a completa');

select tests.login('rafa@cruz.test');
select tests.throws(format($$select public.sign_up_for_shift(%L)$$, tests.id('shift_mañana')),
  'shift_full', 'no se admite a nadie en una guardia completa');
select tests.throws(format($$update public.shifts set status = 'full' where id = %L$$, tests.id('shift_solapada')),
  'invalid_status', 'el estado completa solo lo pone el sistema');

-- Todos los miembros ven quién está apuntado (sin datos de contacto)
select tests.login('valen@cruz.test');
select tests.eq((select count(*) from public.shift_signups where shift_id = tests.id('shift_mañana') and status <> 'cancelled'),
  2::bigint, 'los voluntarios ven las inscripciones de la guardia');

-- Cancelación de inscripción libera plaza
select tests.login('victor@cruz.test');
select public.cancel_shift_signup(tests.id('shift_mañana'));
select tests.eq((select status from public.shifts where id = tests.id('shift_mañana')), 'open'::public.shift_status,
  'al desapuntarse alguien la guardia vuelve a estar abierta');
select tests.throws(format($$select public.cancel_shift_signup(%L)$$, tests.id('shift_mañana')),
  'not_signed_up', 'no se cancela una inscripción inexistente');
select tests.ok(public.sign_up_for_shift(tests.id('shift_mañana')) is not null,
  'tras cancelar se puede volver a apuntar');

-- Guardia confirmada por el responsable
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.manage_shift_signup(id, 'confirmed') from public.shift_signups where member_id = %L and status <> 'cancelled'$$, tests.id('m_vera')),
  'forbidden', 'un voluntario no confirma inscripciones');
select tests.login('rafa@cruz.test');
select public.manage_shift_signup(id, 'confirmed') from public.shift_signups
where member_id = tests.id('m_vera') and shift_id = tests.id('shift_mañana') and status <> 'cancelled';
select tests.eq((select confirmed_count from public.shift_coverage where id = tests.id('shift_mañana')), 1::bigint,
  'el responsable confirma la guardia de una persona');

-- Disponibilidad declarada
select tests.login('valen@cruz.test');
select public.set_my_availability(tests.id('org'), 'available');
select tests.eq((select availability from public.organization_members where id = tests.id('m_valen')),
  'available'::public.availability_status, 'cada uno declara su disponibilidad');

-- Otra organización no ve estas guardias
select tests.login('oscar@otra.test');
select tests.eq((select count(*) from public.shifts), 0::bigint, 'las guardias no se ven desde otra organización');
select tests.throws(format($$select public.sign_up_for_shift(%L)$$, tests.id('shift_solapada')),
  'forbidden', 'no se puede apuntar a guardias de otra organización');
