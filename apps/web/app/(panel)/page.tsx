import Link from 'next/link';

import { requireMembership } from '@/lib/session';

const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

// Dashboard: emergencias activas, guardias de los próximos 7 días y avisos de cobertura.
export default async function Dashboard() {
  const { supabase, membership } = await requireMembership(['admin', 'responsable']);
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86400_000);

  const [{ data: active }, { data: shifts }, { count: pendingCount }] = await Promise.all([
    supabase.from('emergencies').select('id, title, priority, activated_at').eq('org_id', membership.org_id)
      .eq('status', 'active').order('activated_at', { ascending: false }),
    supabase.from('shift_coverage').select('*').eq('org_id', membership.org_id)
      .gte('ends_at', now.toISOString()).lte('starts_at', week.toISOString()).neq('status', 'cancelled').order('starts_at'),
    supabase.from('organization_members').select('id', { count: 'exact', head: true })
      .eq('org_id', membership.org_id).eq('status', 'pending'),
  ]);
  const uncovered = (shifts ?? []).filter((s: any) => s.coverage === 'below_minimum');
  const onDutyNow = (shifts ?? []).filter((s: any) => new Date(s.starts_at) <= now && new Date(s.ends_at) > now);

  return (
    <>
      <h1>Inicio</h1>
      <Link href="/emergencias/nueva" className="btn btn-sos" style={{ marginBottom: 20 }}>🚨 ACTIVAR EMERGENCIA</Link>

      {(active ?? []).map((e: any) => (
        <Link key={e.id} href={`/emergencias/${e.id}`} className="card notice notice-danger" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
          <strong>Emergencia activa: {e.title}</strong>
          <div className="muted">Desde {fmt.format(new Date(e.activated_at))} · Ver panel en tiempo real →</div>
        </Link>
      ))}

      <div className="grid">
        <section className="card">
          <h2>De guardia ahora</h2>
          {onDutyNow.length ? onDutyNow.map((s: any) => (
            <p key={s.id}><strong>{s.title}</strong> · {s.signed_up_count} personas
              {s.coverage === 'below_minimum' && <span className="badge tone-warning" style={{ marginLeft: 8 }}>⚠ Bajo mínimo ({s.min_volunteers})</span>}</p>
          )) : <p className="notice">⚠ No hay ninguna guardia en curso.</p>}
        </section>
        <section className="card">
          <h2>Cobertura próximos 7 días</h2>
          {uncovered.length ? (
            <ul>{uncovered.map((s: any) => (
              <li key={s.id}><span className="badge tone-warning">⚠ {s.signed_up_count}/{s.min_volunteers}</span> {s.title} · {fmt.format(new Date(s.starts_at))}</li>
            ))}</ul>
          ) : <p><span className="badge tone-success">✅ Todas cubiertas</span></p>}
          <Link href="/guardias">Ver calendario</Link>
        </section>
        {membership.role === 'admin' && (pendingCount ?? 0) > 0 && (
          <section className="card">
            <h2>Solicitudes de alta</h2>
            <Link href="/voluntarios">{pendingCount} pendientes de aprobar</Link>
          </section>
        )}
      </div>
    </>
  );
}
