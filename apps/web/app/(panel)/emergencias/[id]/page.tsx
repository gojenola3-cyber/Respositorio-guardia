'use client';
import {
  countRecipients,
  errorMessage,
  estimateArrival,
  isAwaitingResponse,
  isComing,
  locationFreshness,
  priorityLabel,
  summarize,
  t,
  type RecipientStatus,
} from '@guardia/core';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MapView, type MapPoint } from '@/components/Map';
import { StatusBadge } from '@/components/StatusBadge';
import { supabaseBrowser } from '@/lib/supabase/client';

interface Row {
  id: string;
  member_id: string;
  status: RecipientStatus;
  status_changed_at: string;
  responded_at: string | null;
  location_consent: boolean;
  last_manual_contact_at: string | null;
  name: string;
  phone: string | null;
  delivery: { status: string; error_code: string | null; created_at: string } | null;
  location: { lat: number; lng: number; accuracy_m: number | null; recorded_at: string } | null;
}

type Filter = 'all' | 'pending' | 'yes' | 'no' | 'en_route' | 'arrived' | 'problems';
const FILTERS: Record<Filter, string> = {
  all: 'Todos', pending: 'Pendientes', yes: 'Acuden', no: 'No acuden', en_route: 'En camino', arrived: 'En base', problems: 'Sin aviso',
};
const DELIVERY_TEXT: Record<string, string> = {
  queued: 'En cola', provider_accepted: 'Enviada al proveedor', provider_error: '⚠ Fallo de envío',
  platform_accepted: 'Aceptada por Apple/Google', platform_error: '⚠ Rechazada por Apple/Google',
  no_token: '📵 Sin dispositivo', manual_contact: '📞 Contactado por teléfono',
};
const PROBLEM = new Set(['provider_error', 'platform_error', 'no_token']);

function ago(iso: string | null, now: number) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.floor(s / 60)} min` : `hace ${Math.floor(s / 3600)} h`;
}

export default function EmergencyPanel() {
  const { id } = useParams<{ id: string }>();
  const sendFailed = useSearchParams().get('envio') === 'fallido';
  const supabase = supabaseBrowser();
  const [emergency, setEmergency] = useState<any>(null);
  const [base, setBase] = useState<{ name: string; lat: number | null; lng: number | null } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastSync, setLastSync] = useState<number>(Date.now());
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const { data: e, error } = await supabase.from('emergencies').select('*').eq('id', id).single();
    if (error) return setMessage({ ok: false, text: errorMessage('es', error) });
    setEmergency(e);
    if (e.base_id) {
      const { data: b } = await supabase.from('bases').select('name, lat, lng').eq('id', e.base_id).single();
      setBase(b);
    }
    const [{ data: recipients }, { data: deliveries }, { data: locations }, { data: history }] = await Promise.all([
      supabase.from('emergency_recipients').select('*').eq('emergency_id', id),
      supabase.from('notification_deliveries').select('recipient_id, status, error_code, created_at').eq('emergency_id', id).order('created_at', { ascending: false }),
      supabase.from('location_updates').select('recipient_id, lat, lng, accuracy_m, recorded_at').eq('emergency_id', id),
      supabase.from('emergency_status_events').select('*').eq('emergency_id', id).order('created_at', { ascending: false }).limit(50),
    ]);
    const memberIds = (recipients ?? []).map((r: any) => r.member_id);
    const { data: members } = await supabase.from('organization_members').select('id, user_id').in('id', memberIds);
    const { data: profiles } = await supabase.from('profiles').select('id, first_name, last_name, phone')
      .in('id', (members ?? []).map((m: any) => m.user_id));
    const userOf = new Map((members ?? []).map((m: any) => [m.id, m.user_id]));
    const profileOf = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    setRows((recipients ?? []).map((r: any) => {
      const p: any = profileOf.get(userOf.get(r.member_id));
      return {
        ...r,
        name: p ? `${p.first_name} ${p.last_name}`.trim() : '—',
        phone: p?.phone ?? null,
        delivery: (deliveries ?? []).find((d: any) => d.recipient_id === r.id) ?? null,
        location: (locations ?? []).find((l: any) => l.recipient_id === r.id) ?? null,
      };
    }));
    setEvents(history ?? []);
    setLastSync(Date.now());
  }, [id, supabase]);

  useEffect(() => {
    load();
    // Tiempo real + respaldo por sondeo: el panel no depende de una sola conexión.
    const channel = supabase.channel(`emergency-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_recipients', filter: `emergency_id=eq.${id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'location_updates', filter: `emergency_id=eq.${id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notification_deliveries', filter: `emergency_id=eq.${id}` }, load)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'emergencies', filter: `id=eq.${id}` }, load)
      .subscribe();
    const poll = setInterval(load, 20_000);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, load, supabase]);

  const s = useMemo(() => summarize(countRecipients(rows.map((r) => r.status))), [rows]);
  const problems = rows.filter((r) => isAwaitingResponse(r.status) && r.delivery && PROBLEM.has(r.delivery.status));
  const target = base?.lat != null ? { lat: base.lat, lng: base.lng! } : null;

  const visible = rows.filter((r) => ({
    all: true,
    pending: isAwaitingResponse(r.status),
    yes: isComing(r.status),
    no: r.status === 'declined',
    en_route: r.status === 'en_route',
    arrived: r.status === 'arrived',
    problems: problems.includes(r),
  })[filter]).sort((a, b) => a.name.localeCompare(b.name));

  async function action(fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    setMessage(null);
    const { error } = await fn();
    setMessage(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: ok });
    load();
  }
  const dispatch = (body: object) => supabase.functions.invoke('dispatch', { body });

  if (!emergency) return <p>{message?.text ?? 'Cargando…'}</p>;
  const active = emergency.status === 'active';

  const points: MapPoint[] = [
    ...(emergency.lat != null ? [{ id: 'e', lat: emergency.lat, lng: emergency.lng, label: 'Emergencia', kind: 'emergency' as const }] : []),
    ...(target ? [{ id: 'b', ...target, label: base!.name, kind: 'base' as const }] : []),
    ...rows.filter((r) => r.location).map((r) => ({
      id: r.id, lat: r.location!.lat, lng: r.location!.lng, label: r.name, kind: 'volunteer' as const,
      freshness: locationFreshness(r.location!.recorded_at, new Date(now)),
    })),
  ];

  return (
    <>
      <div className="row between">
        <h1 style={{ margin: 0 }}>🚨 {emergency.title}</h1>
        <span className={`badge ${active ? 'tone-danger' : 'tone-neutral'}`}>{active ? '● Activa' : emergency.status === 'closed' ? 'Cerrada' : 'Cancelada'}</span>
      </div>
      <p className="muted">
        Prioridad {priorityLabel('es', emergency.priority)} · {emergency.address ?? 'Sin dirección'} · activada {ago(emergency.activated_at, now)}
        · actualizado {ago(new Date(lastSync).toISOString(), now)}
      </p>
      {sendFailed && <p className="notice notice-danger">La emergencia se creó, pero el envío de avisos falló. El sistema lo reintenta cada minuto. Mientras tanto, llama a los destinatarios.</p>}
      {problems.length > 0 && (
        <p className="notice notice-danger" role="alert">
          <strong>{problems.length} personas sin aviso confirmado</strong> (sin app o envío fallido). Contacta por teléfono y registra el contacto.
          {problems.length >= Math.max(3, rows.length / 2) && ' Si el fallo es general, activa el procedimiento alternativo de la organización.'}
        </p>
      )}
      {message && <p className={message.ok ? 'notice' : 'notice notice-danger'} role="status">{message.text}</p>}

      <div className="counts" style={{ margin: '16px 0' }}>
        <div className="count tone-neutral"><strong>{s.total}</strong>Seleccionados</div>
        <div className="count tone-success"><strong>{s.yes}</strong>✅ Acuden</div>
        <div className="count tone-neutral"><strong>{s.no}</strong>✖ No acuden</div>
        <div className="count tone-warning"><strong>{s.pending}</strong>⏳ Pendientes</div>
        <div className="count tone-info"><strong>{s.enRoute}</strong>🧭 En camino</div>
        <div className="count tone-success"><strong>{s.arrived}</strong>📍 En base</div>
      </div>

      {active && (
        <div className="row" style={{ marginBottom: 16 }}>
          <button className="btn btn-primary" disabled={s.pending === 0}
            onClick={() => action(() => dispatch({ action: 'resend', emergencyId: id }), 'Recordatorio enviado a quien no ha respondido.')}>
            Reenviar a pendientes ({s.pending})
          </button>
          <button className="btn" onClick={() => confirm('¿Cerrar la activación? Se detendrá el seguimiento de todos.') &&
            action(() => supabase.rpc('close_emergency', { p_emergency: id }), 'Activación cerrada. Seguimiento detenido.')}>
            Cerrar activación
          </button>
          <button className="btn btn-danger" onClick={() => {
            const reason = prompt('Motivo de la cancelación (se avisará a los afectados):');
            if (reason !== null) action(() => dispatch({ action: 'cancel', emergencyId: id, reason }), 'Cancelada. Se ha avisado a los afectados.');
          }}>Cancelar y avisar</button>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
        <section className="card">
          <div className="row" role="tablist" style={{ marginBottom: 10 }}>
            {(Object.keys(FILTERS) as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={`btn ${filter === f ? 'btn-primary' : ''}`} onClick={() => setFilter(f)}>
                {FILTERS[f]}
              </button>
            ))}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Persona</th><th>Estado</th><th>Aviso</th><th>Posición</th><th /></tr></thead>
              <tbody>
                {visible.map((r) => {
                  const eta = r.location ? estimateArrival(r.location, target) : null;
                  const fresh = r.location ? locationFreshness(r.location.recorded_at, new Date(now)) : null;
                  return (
                    <tr key={r.id}>
                      <td><strong>{r.name}</strong>{r.phone && <div><a href={`tel:${r.phone.replace(/\s/g, '')}`}>📞 {r.phone}</a></div>}</td>
                      <td><StatusBadge status={r.status} /><div className="muted">{ago(r.status_changed_at, now)}</div></td>
                      <td className="muted">{r.delivery ? DELIVERY_TEXT[r.delivery.status] ?? r.delivery.status : '—'}
                        {r.last_manual_contact_at && <div>📞 {ago(r.last_manual_contact_at, now)}</div>}</td>
                      <td>
                        {r.location ? (
                          <>
                            <span className={`badge tone-${fresh === 'fresh' ? 'success' : fresh === 'stale' ? 'warning' : 'neutral'}`}>
                              {t('es', `location.${fresh!}`)} · {ago(r.location.recorded_at, now)}
                            </span>
                            {eta && <div><strong>~{eta.minutes} min</strong> · {eta.km} km</div>}
                          </>
                        ) : isComing(r.status) && r.status !== 'arrived' ? <span className="muted">{r.location_consent ? 'Esperando GPS' : 'Sin ubicación autorizada'}</span> : null}
                      </td>
                      <td>
                        {active && (
                          <div className="row">
                            {(r.status === 'accepted' || r.status === 'en_route') && (
                              <button className="btn" onClick={() => action(() => supabase.rpc('mark_arrived', { p_recipient: r.id }), `${r.name}: en la base.`)}>En base</button>
                            )}
                            {isAwaitingResponse(r.status) && (
                              <>
                                <button className="btn" onClick={() => action(() => dispatch({ action: 'resend', emergencyId: id, recipientIds: [r.id] }), 'Recordatorio enviado.')}>Reenviar</button>
                                <button className="btn" onClick={() => {
                                  const note = prompt('Resultado del contacto telefónico:');
                                  if (note !== null) action(() => supabase.rpc('log_manual_contact', { p_recipient: r.id, p_channel: 'manual_call', p_note: note }), 'Contacto registrado.');
                                }}>Registrar llamada</button>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted">{t('es', 'emergency.eta_disclaimer')} {t('es', 'emergency.delivery_unconfirmed')}</p>
        </section>

        <section>
          <div className="card"><MapView points={points} /></div>
          <div className="card">
            <h2>Historial</h2>
            <ul className="muted" style={{ paddingLeft: 18 }}>
              {events.map((ev) => (
                <li key={ev.id}>{new Date(ev.created_at).toLocaleTimeString('es-ES')} · {ev.event_type}
                  {ev.from_status && ` ${ev.from_status} → ${ev.to_status}`}
                  {ev.recipient_id && ` · ${rows.find((r) => r.id === ev.recipient_id)?.name ?? ''}`}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}
