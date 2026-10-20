'use client';
import { errorMessage, EVENT_TYPES, type EventType } from '@guardia/core';
import { useCallback, useEffect, useState } from 'react';

import { useOrg } from '@/components/OrgContext';
import { supabaseBrowser } from '@/lib/supabase/client';

const TYPE_LABEL: Record<EventType | 'shift', string> = {
  shift: 'Guardia', service: 'Servicio', practice: 'Práctica', training: 'Formación', meeting: 'Reunión',
  event: 'Evento', maintenance: 'Mantenimiento de material', other: 'Otro',
};
const fmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });

/** Agenda compartida: guardias y eventos, con filtros, inscritos y alta. */
export default function AgendaPage() {
  const { orgId } = useOrg();
  const supabase = supabaseBrowser();
  const [items, setItems] = useState<any[]>([]);
  const [signups, setSignups] = useState<any[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [type, setType] = useState<string>('all');
  const [past, setPast] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const now = new Date().toISOString();
    let q = supabase.from('agenda_items').select('*').eq('org_id', orgId);
    q = past ? q.lt('ends_at', now).order('starts_at', { ascending: false }) : q.gte('ends_at', now).order('starts_at');
    if (type !== 'all') q = q.eq('kind', type);
    const { data } = await q.limit(200);
    setItems(data ?? []);
    const ids = (data ?? []).filter((i: any) => i.kind !== 'shift').map((i: any) => i.id);
    const { data: su } = ids.length ? await supabase.from('event_signups').select('event_id, member_id').in('event_id', ids).neq('status', 'cancelled') : { data: [] };
    setSignups(su ?? []);
  }, [orgId, past, type, supabase]);

  useEffect(() => {
    supabase.rpc('member_directory', { p_org: orgId }).then(({ data }) =>
      setNames(new Map((data ?? []).map((m: any) => [m.member_id, m.display_name]))));
  }, [orgId, supabase]);

  useEffect(() => {
    load();
    const ch = supabase.channel(`agenda-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `org_id=eq.${orgId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'event_signups', filter: `org_id=eq.${orgId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, orgId, supabase]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const capacity = String(f.get('capacity'));
    const { error } = await supabase.from('events').insert({
      org_id: orgId,
      type: String(f.get('type')),
      title: String(f.get('title')),
      description: String(f.get('description')) || null,
      starts_at: new Date(String(f.get('starts'))).toISOString(),
      ends_at: new Date(String(f.get('ends'))).toISOString(),
      location_text: String(f.get('location')) || null,
      capacity: capacity ? Number(capacity) : null,
    });
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: 'Evento creado.' });
    if (!error) { form.reset(); load(); }
  }

  async function cancel(id: string) {
    const reason = prompt('Motivo de la cancelación:');
    if (reason === null) return;
    const { error } = await supabase.from('events').update({ status: 'cancelled', cancel_reason: reason || null }).eq('id', id);
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: 'Evento cancelado.' });
    load();
  }

  return (
    <>
      <h1>Agenda</h1>
      {msg && <p className={msg.ok ? 'notice' : 'notice notice-danger'} role="status">{msg.text}</p>}
      <div className="card row">
        <label style={{ margin: 0, minWidth: 220 }}>Tipo
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">Todos</option>
            {(['shift', ...EVENT_TYPES] as const).map((k) => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}
          </select>
        </label>
        <button className={`btn ${!past ? 'btn-primary' : ''}`} onClick={() => setPast(false)}>Próximos</button>
        <button className={`btn ${past ? 'btn-primary' : ''}`} onClick={() => setPast(true)}>Realizados</button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Cuándo</th><th>Qué</th><th>Dónde</th><th>Inscritos</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {items.map((i) => {
              const people = signups.filter((s) => s.event_id === i.id);
              return (
                <tr key={`${i.kind}-${i.id}`}>
                  <td>{fmt.format(new Date(i.starts_at))}</td>
                  <td><span className="badge tone-info">{TYPE_LABEL[i.kind as EventType]}</span> <strong>{i.title}</strong>
                    {i.description && <div className="muted">{i.description}</div>}</td>
                  <td>{i.location_text ?? '—'}</td>
                  <td>{i.kind === 'shift' ? 'Ver guardias' : (
                    <details><summary>{people.length}{i.capacity ? ` / ${i.capacity}` : ''}</summary>
                      <ul>{people.map((p) => <li key={p.member_id}>{names.get(p.member_id) ?? '—'}</li>)}</ul></details>)}</td>
                  <td>{i.status === 'cancelled' ? <span className="badge tone-neutral">⛔ Cancelado</span> : <span className="badge tone-success">✅ Programado</span>}</td>
                  <td>{i.kind !== 'shift' && i.status === 'scheduled' && !past && <button className="btn btn-ghost" onClick={() => cancel(i.id)}>Cancelar</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!items.length && <p className="muted">No hay elementos.</p>}
      </div>

      <form className="card" onSubmit={create}>
        <h2>Nuevo evento</h2>
        <div className="grid">
          <label>Tipo<select name="type" defaultValue="practice">{EVENT_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABEL[k]}</option>)}</select></label>
          <label>Título<input name="title" required minLength={2} maxLength={160} /></label>
          <label>Inicio<input name="starts" type="datetime-local" required /></label>
          <label>Fin<input name="ends" type="datetime-local" required /></label>
          <label>Lugar<input name="location" maxLength={240} /></label>
          <label>Plazas<span className="hint"> (vacío = sin límite)</span><input name="capacity" type="number" min={1} /></label>
        </div>
        <label>Descripción<textarea name="description" rows={2} maxLength={4000} /></label>
        <button className="btn btn-primary">Crear evento</button>
      </form>
    </>
  );
}
