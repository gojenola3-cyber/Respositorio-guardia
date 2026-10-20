-- Permisos, roles y aislamiento entre organizaciones.
\set QUIET on
select tests.fixture();

-- anon no ve nada ni puede ejecutar la API
select tests.as_anon();
select tests.throws('select count(*) from public.organizations', 'permission denied for table organizations',
  'anon no puede leer organizaciones');
select tests.throws($$select public.create_emergency(gen_random_uuid(), gen_random_uuid(), 'x', '{}')$$,
  'permission denied for function create_emergency', 'anon no puede activar emergencias');

-- [1] Un voluntario no accede a funciones ni datos de administración
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.invite_member(%L, 'nuevo@cruz.test')$$, tests.id('org')),
  'forbidden', 'voluntario no puede invitar');
select tests.throws(format($$select * from public.get_emergency_candidates(%L)$$, tests.id('org')),
  'forbidden', 'voluntario no puede ver candidatos de emergencia');
select tests.eq((select count(*) from public.audit_logs), 0::bigint, 'voluntario no ve la auditoría');
select tests.eq((select count(*) from public.invitations), 0::bigint, 'voluntario no ve invitaciones');
select tests.eq((select count(*) from public.organization_members), 1::bigint,
  'voluntario solo ve su propia membresía');
select tests.eq((select count(*) from public.profiles), 1::bigint, 'voluntario solo ve su propio perfil');
select tests.ok((select bool_and(display_name not like '%@%') and count(*) = 5
                 from public.member_directory(tests.id('org'))),
  'el directorio de miembros muestra nombres, sin correos, y solo miembros activos');
select tests.eq((select display_name from public.member_directory(tests.id('org')) where member_id = tests.id('m_victor')),
  'Víctor V.', 'el directorio muestra nombre e inicial del apellido');

-- [13] Escalada de privilegios bloqueada en servidor
select tests.throws(format($$select public.set_member_role(%L, 'admin')$$, tests.id('m_vera')),
  'forbidden', 'voluntario no puede hacerse admin con la RPC');
select tests.throws(format($$update public.organization_members set role = 'admin' where id = %L$$, tests.id('m_vera')),
  'permission denied for table organization_members', 'voluntario no puede cambiar su rol con UPDATE directo');
select tests.throws(format($$insert into public.organization_members (org_id, user_id, role, status) values (%L, %L, 'admin', 'active')$$,
  tests.id('org'), tests.id('vera')),
  'permission denied for table organization_members', 'voluntario no puede insertarse como admin');
select tests.throws(format($$insert into public.emergencies (org_id, idempotency_key, title, created_by, created_by_member_id) values (%L, gen_random_uuid(), 'x', %L, %L)$$,
  tests.id('org'), tests.id('vera'), tests.id('m_vera')),
  'permission denied for table emergencies', 'nadie inserta emergencias saltándose la RPC');
select tests.throws(format($$insert into public.shifts (org_id, starts_at, ends_at) values (%L, now(), now() + interval '1 hour')$$, tests.id('org')),
  'new row violates row-level security policy for table "shifts"', 'voluntario no puede crear guardias');
update public.profiles set first_name = 'Hackeado' where id = tests.id('rafa');
select tests.login('rafa@cruz.test');
select tests.eq((select first_name from public.profiles where id = tests.id('rafa')), 'Rafa',
  'un voluntario no puede modificar el perfil de otro');
select tests.login('vera@cruz.test');
update public.profiles set first_name = 'Verónica', phone = '+34 600000003' where id = tests.id('vera');
select tests.eq((select first_name from public.profiles where id = tests.id('vera')), 'Verónica',
  'cada uno puede editar su propio perfil');
select tests.throws(format($$update public.profiles set email = 'otro@x.test' where id = %L$$, tests.id('vera')),
  'permission denied for table profiles', 'el correo no se cambia desde el perfil');

-- [2] [15] Aislamiento entre organizaciones
select tests.login('oscar@otra.test');
select tests.eq((select count(*) from public.organizations), 1::bigint, 'cada uno ve solo su organización');
select tests.eq((select count(*) from public.bases where org_id = tests.id('org')), 0::bigint,
  'no se ven bases de otra organización');
select tests.throws(format($$select * from public.member_directory(%L)$$, tests.id('org')),
  'forbidden', 'no se ve el directorio de otra organización');
select tests.login('olga@otra.test');
select tests.throws(format($$select public.invite_member(%L, 'x@x.test')$$, tests.id('org')),
  'forbidden', 'el admin de otra organización no puede invitar en esta');
select tests.throws(format($$select public.set_member_status(%L, 'suspended')$$, tests.id('m_vera')),
  'forbidden', 'el admin de otra organización no puede suspender miembros ajenos');
select tests.throws(format($$select * from public.get_emergency_candidates(%L)$$, tests.id('org')),
  'forbidden', 'el admin de otra organización no puede ver candidatos ajenos');

-- Altas: pendiente sin acceso hasta aprobación
select tests.login('pili@cruz.test');
select tests.eq((select count(*) from public.organizations), 0::bigint, 'un miembro pendiente no ve la organización');
select tests.eq((select status from public.organization_members where id = tests.id('m_pili')), 'pending'::public.member_status,
  'la solicitud de alta queda pendiente');
select tests.login('ana@cruz.test');
select tests.eq((select email from public.profiles where id = tests.id('pili')), 'pili@cruz.test',
  'el admin ve los datos de quien solicita el alta');
select public.set_member_status(tests.id('m_pili'), 'active');
select tests.login('pili@cruz.test');
select tests.eq((select count(*) from public.organizations), 1::bigint, 'tras la aprobación ya tiene acceso');

-- Invitaciones: solo la cuenta invitada, una sola vez
select tests.login('ana@cruz.test');
select set_config('tests.token', public.invite_member(tests.id('org'), 'nuevo@cruz.test'), false);
select tests.as_admin();
select tests.create_user('nuevo@cruz.test', 'Nuevo', 'Voluntario') is not null;
select tests.login('oscar@otra.test');
select tests.throws(format($$select public.accept_invitation(%L)$$, current_setting('tests.token')),
  'invitation_email_mismatch', 'una invitación reenviada a otra cuenta no sirve');
select tests.login('nuevo@cruz.test');
select tests.ok(public.accept_invitation(current_setting('tests.token')) is not null, 'la cuenta invitada acepta');
select tests.throws(format($$select public.accept_invitation(%L)$$, current_setting('tests.token')),
  'invitation_invalid', 'una invitación no se reutiliza');
select tests.throws($$select public.accept_invitation('token-inventado')$$, 'invitation_invalid',
  'un token inventado no da acceso');

-- Admins: no se puede dejar la organización sin admin
select tests.login('ana@cruz.test');
select tests.throws(format($$select public.set_member_role(%L, 'voluntario')$$, tests.id('m_ana')),
  'last_admin', 'no se puede degradar al último admin');
select public.set_member_role(tests.id('m_rafa'), 'responsable');

-- Suspensión: pierde el acceso al instante
select public.set_member_status(tests.id('m_valen'), 'suspended');
select tests.login('valen@cruz.test');
select tests.eq((select count(*) from public.shifts), 0::bigint, 'un miembro suspendido no ve datos');
select tests.throws(format($$select public.set_my_availability(%L, 'available')$$, tests.id('org')),
  'forbidden', 'un miembro suspendido no puede operar');

-- La auditoría registra los cambios administrativos con su autor
select tests.login('ana@cruz.test');
select tests.ok(exists (select 1 from public.audit_logs where target_table = 'organization_members'
                        and target_id = tests.id('m_valen') and actor_user_id = tests.id('ana')
                        and details -> 'status' ->> 'to' = 'suspended'),
  'la suspensión queda auditada con quién la hizo');

-- Derecho de supresión: anonimizar sin perder el historial
select tests.login('vera@cruz.test');
select tests.throws(format($$select public.anonymize_member(%L)$$, tests.id('m_victor')),
  'forbidden', 'un voluntario no puede anonimizar a nadie');
select tests.login('ana@cruz.test');
select tests.eq(public.anonymize_member(tests.id('m_victor')), true, 'el admin anonimiza a un miembro');
select tests.ok((select first_name = 'Persona' and email is null and phone is null and anonymized_at is not null
                 from public.profiles where id = tests.id('victor')),
  'el perfil queda sin datos identificativos');
select tests.eq((select status from public.organization_members where id = tests.id('m_victor')),
  'deactivated'::public.member_status, 'la membresía queda desactivada');
select tests.login('victor@cruz.test');
select tests.eq((select count(*) from public.organizations), 0::bigint, 'la persona anonimizada pierde el acceso');
