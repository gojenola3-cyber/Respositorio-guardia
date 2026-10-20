'use client';
import { errorMessage, MEMBER_ROLES, roleLabel, type MemberRole, type MemberStatus } from '@guardia/core';
import { useCallback, useEffect, useState } from 'react';

import { useOrg } from '@/components/OrgContext';
import { supabaseBrowser } from '@/lib/supabase/client';

const STATUS: Record<MemberStatus, { text: string; tone: string }> = {
  pending: { text: '⏳ Pendiente', tone: 'warning' },
  active: { text: '✅ Activa', tone: 'success' },
  suspended: { text: '⛔ Suspendida', tone: 'danger' },
  deactivated: { text: 'Desactivada', tone: 'neutral' },
};

/** Gestión de voluntarios: invitaciones, aprobación, roles, estado y cualificaciones. */
export default function MembersPage() {
  const { orgId, role, memberId } = useOrg();
  const isAdmin = role === 'admin';
  const supabase = supabaseBrowser();
  const [members, setMembers] = useState<any[]>([]);
  const [quals, setQuals] = useState<any[]>([]);
  const [mq, setMq] = useState<any[]>([]);
  const [filter, setFilter] = useState<'all' | MemberStatus>('all');
  const [invite, setInvite] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: m } = await supabase.from('organization_members')
      .select('id, user_id, role, status, internal_code, availability, created_at').eq('org_id', orgId);
    const { data: p } = await supabase.from('profiles').select('id, first_name, last_name, email, phone')
      .in('id', (m ?? []).map((x: any) => x.user_id));
    const byId = new Map((p ?? []).map((x: any) => [x.id, x]));
    setMembers((m ?? []).map((x: any) => ({ ...x, profile: byId.get(x.user_id) }))
      .sort((a: any, b: any) => (a.profile?.first_name ?? '').localeCompare(b.profile?.first_name ?? '')));
    const [{ data: q }, { data: link }] = await Promise.all([
      supabase.from('qualifications').select('id, code, name, has_expiry').eq('org_id', orgId).order('code'),
      supabase.from('member_qualifications').select('id, member_id, qualification_id, expires_on').eq('org_id', orgId),
    ]);
    setQuals(q ?? []);
    setMq(link ?? []);
  }, [orgId, supabase]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => PromiseLike<{ error: unknown; data?: unknown }>, ok: string) {
    const { error } = await fn();
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: ok });
    load();
  }

  async function sendInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const { data, error } = await supabase.rpc('invite_member', {
      p_org: orgId, p_email: String(f.get('email')), p_role: String(f.get('role')),
    });
    if (error) return setMsg({ ok: false, text: errorMessage('es', error) });
    // El código se muestra una sola vez: el servidor solo guarda su hash.
    setInvite(`${location.origin}/alta?token=${data}`);
    form.reset();
  }

  const today = new Date().toISOString().slice(0, 10);
  const shown = members.filter((m) => filter === 'all' || m.status === filter);

  return (
    <>
      <h1>Voluntarios</h1>
      {msg && <p className={msg.ok ? 'notice' : 'notice notice-danger'} role="status">{msg.text}</p>}

      {isAdmin && (
        <form className="card" onSubmit={sendInvite}>
          <h2>Invitar</h2>
          <div className="grid">
            <label>Correo<input name="email" type="email" required /></label>
            <label>Rol<select name="role" defaultValue="voluntario">{MEMBER_ROLES.map((r) => <option key={r} value={r}>{roleLabel('es', r)}</option>)}</select></label>
          </div>
          <button className="btn btn-primary">Crear invitación</button>
          {invite && (
            <p className="notice">Envía este enlace a la persona (solo funciona con su correo, caduca en 7 días y no se volverá a mostrar):<br />
              <code style={{ wordBreak: 'break-all' }}>{invite}</code>{' '}
              <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(invite)}>Copiar</button></p>
          )}
        </form>
      )}

      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          {(['all', 'pending', 'active', 'suspended', 'deactivated'] as const).map((f) => (
            <button key={f} className={`btn ${filter === f ? 'btn-primary' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Todos' : STATUS[f].text} ({f === 'all' ? members.length : members.filter((m) => m.status === f).length})
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Especialidades</th><th /></tr></thead>
            <tbody>
              {shown.map((m) => {
                const mine = mq.filter((x) => x.member_id === m.id);
                return (
                  <tr key={m.id}>
                    <td><strong>{m.profile?.first_name} {m.profile?.last_name}</strong> {m.internal_code && <span className="muted">· {m.internal_code}</span>}
                      <div className="muted">{m.profile?.email} {m.profile?.phone && `· ${m.profile.phone}`}</div></td>
                    <td>{isAdmin && m.id !== memberId ? (
                      <select value={m.role} aria-label="Rol" onChange={(e) => run(() => supabase.rpc('set_member_role', { p_member: m.id, p_role: e.target.value as MemberRole }), 'Rol actualizado.')}>
                        {MEMBER_ROLES.map((r) => <option key={r} value={r}>{roleLabel('es', r)}</option>)}
                      </select>) : roleLabel('es', m.role)}</td>
                    <td><span className={`badge tone-${STATUS[m.status as MemberStatus].tone}`}>{STATUS[m.status as MemberStatus].text}</span></td>
                    <td>{mine.map((x) => {
                      const q = quals.find((y) => y.id === x.qualification_id);
                      const expired = x.expires_on && x.expires_on < today;
                      return <span key={x.id} className={`badge ${expired ? 'tone-warning' : 'tone-info'}`} style={{ marginRight: 4 }}>{expired ? '⚠ ' : ''}{q?.code}{x.expires_on ? ` (${x.expires_on})` : ''}</span>;
                    })}</td>
                    <td>{isAdmin && m.id !== memberId && (
                      <div className="row">
                        {m.status === 'pending' && <button className="btn btn-success" onClick={() => run(() => supabase.rpc('set_member_status', { p_member: m.id, p_status: 'active' }), 'Alta aprobada.')}>Aprobar</button>}
                        {m.status === 'active' && <button className="btn" onClick={() => run(() => supabase.rpc('set_member_status', { p_member: m.id, p_status: 'suspended' }), 'Cuenta suspendida.')}>Suspender</button>}
                        {(m.status === 'suspended' || m.status === 'deactivated') && <button className="btn" onClick={() => run(() => supabase.rpc('set_member_status', { p_member: m.id, p_status: 'active' }), 'Cuenta reactivada.')}>Reactivar</button>}
                        <button className="btn btn-ghost" onClick={() => setEditing(editing === m.id ? null : m.id)}>Especialidades</button>
                        {m.status !== 'deactivated' && <button className="btn btn-ghost" onClick={() => confirm('¿Dar de baja y anonimizar? El historial se conserva sin datos personales. No se puede deshacer.') &&
                          run(() => supabase.rpc('anonymize_member', { p_member: m.id }), 'Baja tramitada y datos anonimizados.')}>Baja (RGPD)</button>}
                      </div>
                    )}
                    {editing === m.id && (
                      <form className="row" style={{ marginTop: 8 }} onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        run(() => supabase.from('member_qualifications').insert({
                          org_id: orgId, member_id: m.id, qualification_id: String(f.get('q')),
                          obtained_on: String(f.get('from')) || null, expires_on: String(f.get('to')) || null,
                        }), 'Especialidad añadida.');
                      }}>
                        <select name="q" required aria-label="Especialidad">{quals.map((q) => <option key={q.id} value={q.id}>{q.code} · {q.name}</option>)}</select>
                        <input name="from" type="date" aria-label="Obtenida" />
                        <input name="to" type="date" aria-label="Caduca" />
                        <button className="btn">Añadir</button>
                        {mine.map((x) => <button type="button" key={x.id} className="btn btn-ghost" onClick={() => run(() => supabase.from('member_qualifications').delete().eq('id', x.id), 'Especialidad retirada.')}>Quitar {quals.find((y) => y.id === x.qualification_id)?.code}</button>)}
                      </form>
                    )}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
