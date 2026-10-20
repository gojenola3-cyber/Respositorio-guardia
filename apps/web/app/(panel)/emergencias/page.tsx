import Link from 'next/link';

import { requireMembership } from '@/lib/session';

const fmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

// Historial de activaciones de la organización.
export default async function EmergenciesPage() {
  const { supabase, membership } = await requireMembership(['admin', 'responsable']);
  const { data } = await supabase.from('emergencies')
    .select('id, title, priority, status, activated_at, closed_at, address')
    .eq('org_id', membership.org_id).order('activated_at', { ascending: false }).limit(100);
  return (
    <>
      <div className="row between"><h1>Emergencias</h1><Link className="btn btn-danger" href="/emergencias/nueva">🚨 Activar</Link></div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Fecha</th><th>Emergencia</th><th>Estado</th><th>Cierre</th></tr></thead>
          <tbody>
            {(data ?? []).map((e: any) => (
              <tr key={e.id}>
                <td>{fmt.format(new Date(e.activated_at))}</td>
                <td><Link href={`/emergencias/${e.id}`}><strong>{e.title}</strong></Link><div className="muted">{e.address}</div></td>
                <td><span className={`badge ${e.status === 'active' ? 'tone-danger' : 'tone-neutral'}`}>{{ active: '● Activa', closed: 'Cerrada', cancelled: 'Cancelada' }[e.status as string]}</span></td>
                <td className="muted">{e.closed_at ? fmt.format(new Date(e.closed_at)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.length && <p className="muted">Todavía no hay activaciones.</p>}
      </div>
    </>
  );
}
