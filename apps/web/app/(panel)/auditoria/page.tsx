import { requireMembership } from '@/lib/session';

const fmt = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Madrid' });

// Auditoría: solo administradores (lo exige también la RLS de audit_logs).
export default async function AuditPage() {
  const { supabase, membership } = await requireMembership(['admin']);
  const { data } = await supabase.from('audit_logs').select('*').eq('org_id', membership.org_id)
    .order('created_at', { ascending: false }).limit(300);
  const { data: names } = await supabase.rpc('member_directory', { p_org: membership.org_id });
  const { data: members } = await supabase.from('organization_members').select('id, user_id').eq('org_id', membership.org_id);
  const nameByUser = new Map((members ?? []).map((m: any) => [m.user_id, (names ?? []).find((n: any) => n.member_id === m.id)?.display_name]));
  return (
    <>
      <h1>Auditoría</h1>
      <p className="muted">Cambios administrativos de los últimos registros. Los datos personales y las coordenadas no se copian al registro.</p>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Cuándo</th><th>Quién</th><th>Acción</th><th>Tabla</th><th>Detalle</th></tr></thead>
          <tbody>
            {(data ?? []).map((a: any) => (
              <tr key={a.id}>
                <td>{fmt.format(new Date(a.created_at))}</td>
                <td>{a.actor_user_id ? nameByUser.get(a.actor_user_id) ?? 'Usuario' : 'Sistema'}</td>
                <td>{a.action}</td>
                <td className="muted">{a.target_table}</td>
                <td><code style={{ fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>{JSON.stringify(a.details)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
