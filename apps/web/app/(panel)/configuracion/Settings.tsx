'use client';
import { errorMessage } from '@guardia/core';
import { useCallback, useEffect, useState } from 'react';

import { MapView } from '@/components/Map';
import { useOrg } from '@/components/OrgContext';
import { supabaseBrowser } from '@/lib/supabase/client';

const MODES = {
  on_shift: 'Solo quien está de guardia',
  available: 'Solo quien se declara disponible',
  on_shift_or_available: 'De guardia o disponible (recomendado)',
  all_active: 'Todos los miembros activos',
};

export function Settings() {
  const { orgId } = useOrg();
  const supabase = supabaseBrowser();
  const [settings, setSettings] = useState<any>(null);
  const [bases, setBases] = useState<any[]>([]);
  const [quals, setQuals] = useState<any[]>([]);
  const [pick, setPick] = useState<{ lat: number; lng: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [{ data: s }, { data: b }, { data: q }] = await Promise.all([
      supabase.from('organization_settings').select('*').eq('org_id', orgId).single(),
      supabase.from('bases').select('*').eq('org_id', orgId).order('name'),
      supabase.from('qualifications').select('*').eq('org_id', orgId).order('code'),
    ]);
    setSettings(s);
    setBases(b ?? []);
    setQuals(q ?? []);
  }, [orgId, supabase]);
  useEffect(() => { load(); }, [load]);

  async function run(fn: () => PromiseLike<{ error: unknown }>, ok: string) {
    const { error } = await fn();
    setMsg(error ? { ok: false, text: errorMessage('es', error) } : { ok: true, text: ok });
    load();
  }

  if (!settings) return <p>Cargando…</p>;
  return (
    <>
      <h1>Configuración</h1>
      {msg && <p className={msg.ok ? 'notice' : 'notice notice-danger'} role="status">{msg.text}</p>}

      <form className="card" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run(() => supabase.from('organization_settings').update({
          eligibility_mode: String(f.get('mode')),
          resend_interval_seconds: Number(f.get('interval')),
          max_resends: Number(f.get('resends')),
          location_retention_minutes: Number(f.get('loc')),
          critical_alerts_enabled: f.get('critical') === 'on',
          delivery_log_retention_days: Number(f.get('dlog')),
          audit_retention_days: Number(f.get('audit')),
          emergency_retention_days: Number(f.get('emerg')),
        }).eq('org_id', orgId), 'Configuración guardada.');
      }}>
        <h2>Activaciones</h2>
        <label>Quién aparece seleccionado por defecto
          <select name="mode" defaultValue={settings.eligibility_mode}>
            {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <div className="grid">
          <label>Intervalo de recordatorios (s)<input name="interval" type="number" min={60} max={3600} defaultValue={settings.resend_interval_seconds} /></label>
          <label>Recordatorios máximos<input name="resends" type="number" min={0} max={10} defaultValue={settings.max_resends} /></label>
        </div>
        <label className="row"><input type="checkbox" name="critical" defaultChecked={settings.critical_alerts_enabled} />
          Alertas críticas de iOS en emergencias de prioridad crítica
          <span className="hint">Actívalo solo cuando Apple haya concedido el permiso a la app (ver docs/NOTIFICACIONES.md).</span></label>
        <h2>Conservación de datos</h2>
        <div className="grid">
          <label>Caducidad de la ubicación (min)<input name="loc" type="number" min={15} max={2880} defaultValue={settings.location_retention_minutes} /></label>
          <label>Registro de envíos (días)<input name="dlog" type="number" min={7} max={3650} defaultValue={settings.delivery_log_retention_days} /></label>
          <label>Auditoría (días)<input name="audit" type="number" min={30} max={3650} defaultValue={settings.audit_retention_days} /></label>
          <label>Emergencias cerradas (días)<input name="emerg" type="number" min={30} max={7300} defaultValue={settings.emergency_retention_days} /></label>
        </div>
        <button className="btn btn-primary">Guardar</button>
      </form>

      <section className="card">
        <h2>Bases</h2>
        <ul>{bases.map((b) => (
          <li key={b.id} className="row" style={{ marginBottom: 8 }}>
            <strong>{b.name}</strong> {b.address} {b.is_default && <span className="badge tone-info">Por defecto</span>}
            {!b.is_default && <button className="btn btn-ghost" onClick={() => run(async () => {
              const r1 = await supabase.from('bases').update({ is_default: false }).eq('org_id', orgId).eq('is_default', true);
              return r1.error ? r1 : supabase.from('bases').update({ is_default: true }).eq('id', b.id);
            }, 'Base por defecto actualizada.')}>Hacer por defecto</button>}
            <button className="btn btn-ghost" onClick={() => confirm('¿Eliminar la base?') && run(() => supabase.from('bases').delete().eq('id', b.id), 'Base eliminada.')}>Eliminar</button>
          </li>))}</ul>
        <form onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          run(() => supabase.from('bases').insert({
            org_id: orgId, name: String(f.get('name')), address: String(f.get('address')) || null,
            lat: pick?.lat ?? null, lng: pick?.lng ?? null, is_default: bases.length === 0,
          }), 'Base creada.').then(() => { form.reset(); setPick(null); });
        }}>
          <div className="grid">
            <label>Nombre<input name="name" required minLength={2} /></label>
            <label>Dirección<input name="address" /></label>
          </div>
          <p className="muted">Toca el mapa para situar la base {pick && `(${pick.lat.toFixed(5)}, ${pick.lng.toFixed(5)})`}.</p>
          <MapView points={[
            ...bases.filter((b) => b.lat != null).map((b) => ({ id: b.id, lat: b.lat, lng: b.lng, label: b.name, kind: 'base' as const })),
            ...(pick ? [{ id: 'new', ...pick, label: 'Nueva base', kind: 'emergency' as const }] : []),
          ]} onPick={setPick} />
          <button className="btn btn-primary" style={{ marginTop: 12 }}>Añadir base</button>
        </form>
      </section>

      <section className="card">
        <h2>Especialidades y acreditaciones</h2>
        <ul>{quals.map((q) => (
          <li key={q.id} className="row" style={{ marginBottom: 8 }}><strong>{q.code}</strong> {q.name} {q.has_expiry && <span className="badge tone-neutral">Caduca</span>}
            <button className="btn btn-ghost" onClick={() => confirm('¿Eliminar la especialidad? Se quitará a todas las personas.') && run(() => supabase.from('qualifications').delete().eq('id', q.id), 'Especialidad eliminada.')}>Eliminar</button></li>))}</ul>
        <form className="grid" onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          run(() => supabase.from('qualifications').insert({
            org_id: orgId, code: String(f.get('code')).toUpperCase(), name: String(f.get('name')), has_expiry: f.get('expiry') === 'on',
          }), 'Especialidad creada.').then(() => form.reset());
        }}>
          <label>Código<input name="code" required pattern="[A-Za-z0-9_\-]{2,24}" placeholder="SVB" /></label>
          <label>Nombre<input name="name" required placeholder="Soporte vital básico" /></label>
          <label className="row"><input type="checkbox" name="expiry" /> Tiene caducidad</label>
          <button className="btn btn-primary">Añadir</button>
        </form>
      </section>
    </>
  );
}
