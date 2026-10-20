'use client';
import { errorMessage } from '@guardia/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useOrg } from '@/components/OrgContext';
import { supabaseBrowser } from '@/lib/supabase/client';

type View = 'day' | 'week' | 'month';
const DAY = 86400_000;
const time = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });

function range(view: View, anchor: Date) {
  const start = new Date(anchor);
  start.setHours(0, 0, 0, 0);
  if (view === 'week') start.setTime(start.getTime() - ((start.getDay() + 6) % 7) * DAY);
  if (view === 'month') start.setDate(1);
  const end = new Date(start);
  if (view === 'day') end.setDate(end.getDate() + 1);
  if (view === 'week') end.setDate(end.getDate() + 7);
  if (view === 'month') end.setMonth(end.getMonth() + 1);
  return { start, end };
}

/** Calendario de guardias con cobertura, inscritos y alta de turnos. */
export default function ShiftsPage() {
  const { orgId } = useOrg();
  const supabase = supabaseBrowser();
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [shifts, setShifts] = useState<any[]>([]);
  const [signups, setSignups] = useState<any[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { start, end } = useMemo(() => range(view, anchor), [view, anchor]);

  const load = useCallback(async () => {
    const { data } = await supabase.from('shift_coverage').select('*').eq('org_id', orgId)
      .lt('starts_at', end.toISOString()).gt('ends_at', start.toISOString()).order('starts_at');
    setShifts(data ?? []);
    const ids = (data ?? []).map((s: any) => s.id);
    const { data: su } = ids.length
      ? await supabase.from('shift_signups').select('id, shift_id, member_id, status').in('shift_id', ids).neq('status', 'cancelled')
      : { data: [] };
    setSignups(su ?? []);
  }, [orgId, start, end, supabase]);

  useEffect(() => {
    supabase.rpc('member_directory', { p_org: orgId }).then(({ data }) =>
      setNames(new Map((data ?? []).map((m: any) => [m.member_id, m.display_name]))));
  }, [orgId, supabase]);

  useEffect(() => {
    load();
    const ch = supabase.channel(`shifts-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_signups', filter: `org_id=eq.${orgId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts', filter: `org_id=eq.${orgId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, orgId, supabase]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const max = String(f.get('max'));
    const { error } = await supabase.from('shifts').insert({
      org_id: orgId,
      title: String(f.get('title')) || 'Guardia',
      starts_at: new Date(String(f.get('starts'))).toISOString(),
      ends_at: new Date(String(f.get('ends'))).toISOString(),
      min_volunteers: Number(f.get('min') || 0),
      max_volunteers: max ? Number(max) : null,
      notes: String(f.get('notes')) || null,
    });
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: 'Guardia creada.' });
    if (!error) { form.reset(); load(); }
  }

  async function setStatus(id: string, status: string) {
    const { error } = await supabase.from('shifts').update({ status }).eq('id', id);
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: 'Guardia actualizada.' });
    load();
  }

  async function manage(signupId: string, status: 'confirmed' | 'cancelled') {
    const { error } = await supabase.rpc('manage_shift_signup', { p_signup: signupId, p_status: status });
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: status === 'confirmed' ? 'Guardia confirmada.' : 'Inscripción retirada.' });
    load();
  }

  const days: Date[] = [];
  for (let d = new Date(start); d < end; d = new Date(d.getTime() + DAY)) days.push(d);
  const shift = shifts.find((s) => s.id === selected);
  const move = (dir: number) => {
    const a = new Date(anchor);
    if (view === 'day') a.setDate(a.getDate() + dir);
    if (view === 'week') a.setDate(a.getDate() + 7 * dir);
    if (view === 'month') a.setMonth(a.getMonth() + dir);
    setAnchor(a);
  };

  return (
    <>
      <h1>Guardias</h1>
      {msg && <p className={msg.ok ? 'notice' : 'notice notice-danger'} role="status">{msg.text}</p>}
      <div className="row between card">
        <div className="row">
          {(['day', 'week', 'month'] as View[]).map((v) => (
            <button key={v} className={`btn ${view === v ? 'btn-primary' : ''}`} onClick={() => setView(v)}>{{ day: 'Día', week: 'Semana', month: 'Mes' }[v]}</button>
          ))}
        </div>
        <div className="row">
          <button className="btn" onClick={() => move(-1)} aria-label="Anterior">←</button>
          <button className="btn" onClick={() => setAnchor(new Date())}>Hoy</button>
          <button className="btn" onClick={() => move(1)} aria-label="Siguiente">→</button>
        </div>
      </div>

      <div className="calendar" style={view === 'day' ? { gridTemplateColumns: '1fr' } : undefined}>
        {days.map((d) => {
          const items = shifts.filter((s) => new Date(s.starts_at) < new Date(d.getTime() + DAY) && new Date(s.ends_at) > d);
          return (
            <div className="day" key={d.toISOString()}>
              <div className="n">{dayFmt.format(d)}</div>
              {items.map((s) => {
                const tone = s.status === 'cancelled' ? 'neutral' : s.coverage === 'below_minimum' ? 'warning' : 'success';
                return (
                  <button key={s.id} className={`item badge tone-${tone}`} style={{ width: '100%', textAlign: 'left' }} onClick={() => setSelected(s.id)}>
                    {tone === 'warning' ? '⚠' : tone === 'success' ? '✅' : '⛔'} {time.format(new Date(s.starts_at))} {s.title} · {s.signed_up_count}{s.max_volunteers ? `/${s.max_volunteers}` : ''}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {shift && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="row between">
            <h2>{shift.title} · {dayFmt.format(new Date(shift.starts_at))} {time.format(new Date(shift.starts_at))}–{time.format(new Date(shift.ends_at))}</h2>
            <button className="btn btn-ghost" onClick={() => setSelected(null)}>Cerrar</button>
          </div>
          <p>
            {shift.coverage === 'below_minimum'
              ? <span className="badge tone-warning">⚠ Bajo mínimo: {shift.signed_up_count} de {shift.min_volunteers}</span>
              : <span className="badge tone-success">✅ Cubierta: {shift.signed_up_count} personas</span>}{' '}
            <span className="badge tone-neutral">Estado: {{ open: 'Abierta', full: 'Completa', closed: 'Cerrada', cancelled: 'Cancelada' }[shift.status as string]}</span>
          </p>
          <ul>
            {signups.filter((x) => x.shift_id === shift.id).map((x) => (
              <li key={x.id} className="row" style={{ marginBottom: 8 }}>
                {names.get(x.member_id) ?? '—'} {x.status === 'confirmed' ? <span className="badge tone-success">✅ Confirmada</span> : <span className="badge tone-info">Inscrito</span>}
                {x.status !== 'confirmed' && <button className="btn" onClick={() => manage(x.id, 'confirmed')}>Confirmar</button>}
                <button className="btn btn-ghost" onClick={() => manage(x.id, 'cancelled')}>Retirar</button>
              </li>
            ))}
          </ul>
          <div className="row">
            {shift.status !== 'closed' && shift.status !== 'cancelled' && <button className="btn" onClick={() => setStatus(shift.id, 'closed')}>Cerrar inscripciones</button>}
            {shift.status === 'closed' && <button className="btn" onClick={() => setStatus(shift.id, 'open')}>Reabrir</button>}
            {shift.status !== 'cancelled' && <button className="btn btn-danger" onClick={() => confirm('¿Cancelar la guardia?') && setStatus(shift.id, 'cancelled')}>Cancelar guardia</button>}
          </div>
        </section>
      )}

      <form className="card" onSubmit={create} style={{ marginTop: 16 }}>
        <h2>Nueva guardia</h2>
        <div className="grid">
          <label>Título<input name="title" defaultValue="Guardia" maxLength={120} /></label>
          <label>Inicio<input name="starts" type="datetime-local" required /></label>
          <label>Fin<input name="ends" type="datetime-local" required /></label>
          <label>Mínimo de personas<input name="min" type="number" min={0} max={500} defaultValue={2} /></label>
          <label>Máximo<span className="hint"> (vacío = sin límite)</span><input name="max" type="number" min={1} max={500} /></label>
        </div>
        <label>Observaciones<textarea name="notes" rows={2} maxLength={2000} /></label>
        <button className="btn btn-primary">Crear guardia</button>
      </form>
    </>
  );
}
