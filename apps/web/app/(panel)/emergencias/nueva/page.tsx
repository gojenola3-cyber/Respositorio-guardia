'use client';
import {
  confirmationSummary,
  deselectAll,
  draftToRpc,
  EMERGENCY_PRIORITIES,
  errorMessage,
  initialSelection,
  newDraft,
  priorityLabel,
  selectAllEligible,
  selectionPayload,
  selectionSummary,
  setReason,
  t,
  toggle,
  validateDraft,
  type Candidate,
  type EmergencyDraft,
  type Selection,
} from '@guardia/core';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { MapView } from '@/components/Map';
import { useOrg } from '@/components/OrgContext';
import { supabaseBrowser } from '@/lib/supabase/client';

type Step = 'form' | 'recipients' | 'confirm';
type FullCandidate = Candidate & {
  role: string;
  availability: string;
  shift_confirmed: boolean;
  qualification_codes: string[];
  missing_qualification_codes: string[];
};

const REASON_TEXT = {
  self: t('es', 'ineligible.self'),
  missing_qualifications: t('es', 'ineligible.missing_qualifications'),
  not_available: t('es', 'ineligible.not_available'),
} as const;

/**
 * Activación en 3 pasos cortos. La clave de idempotencia se crea al abrir la
 * pantalla: reintentar o pulsar dos veces nunca crea dos emergencias.
 */
export default function ActivatePage() {
  const { orgId } = useOrg();
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [step, setStep] = useState<Step>('form');
  const [draft, setDraft] = useState<EmergencyDraft>(() => newDraft(crypto.randomUUID()));
  const [bases, setBases] = useState<{ id: string; name: string; lat: number | null; lng: number | null; is_default: boolean }[]>([]);
  const [quals, setQuals] = useState<{ id: string; code: string; name: string }[]>([]);
  const [candidates, setCandidates] = useState<FullCandidate[]>([]);
  const [selection, setSelection] = useState<Selection>(() => deselectAll());
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    supabase.from('bases').select('id, name, lat, lng, is_default').eq('org_id', orgId).order('name')
      .then(({ data }) => {
        setBases(data ?? []);
        const def = data?.find((b) => b.is_default);
        if (def) setDraft((d) => ({ ...d, baseId: d.baseId ?? def.id }));
      });
    supabase.from('qualifications').select('id, code, name').eq('org_id', orgId).order('code')
      .then(({ data }) => setQuals(data ?? []));
  }, [orgId, supabase]);

  async function loadCandidates() {
    setError(null);
    const { data, error } = await supabase.rpc('get_emergency_candidates', {
      p_org: orgId,
      p_required_qualifications: draft.requiredQualificationIds,
    });
    if (error) return setError(errorMessage('es', error));
    const list = (data ?? []) as FullCandidate[];
    setCandidates(list);
    // Regla: todos los elegibles empiezan seleccionados.
    setSelection(initialSelection(list));
    setStep('recipients');
  }

  const summary = useMemo(() => selectionSummary(selection, candidates), [selection, candidates]);
  const formErrors = validateDraft(draft, Number.POSITIVE_INFINITY);

  async function send() {
    if (sending) return;
    setSending(true);
    setError(null);
    const { data, error } = await supabase.functions.invoke('dispatch', {
      body: { action: 'activate', params: { ...draftToRpc(orgId, draft), ...selectionPayload(selection) } },
    });
    if (error) {
      setSending(false);
      let key = 'unknown';
      try {
        key = (await (error as { context?: Response }).context?.json())?.error ?? key;
      } catch { /* sin cuerpo */ }
      // No se muestra éxito: la emergencia puede no haberse creado.
      return setError(`${errorMessage('es', { message: key })} Puedes reintentar: no se duplicará.`);
    }
    const params = data.deliveryError ? '?envio=fallido' : '';
    router.push(`/emergencias/${data.emergencyId}${params}`);
  }

  const update = (patch: Partial<EmergencyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const points = [
    ...(draft.location ? [{ id: 'e', ...draft.location, label: 'Emergencia', kind: 'emergency' as const }] : []),
    ...bases.filter((b) => b.lat != null).map((b) => ({ id: b.id, lat: b.lat!, lng: b.lng!, label: b.name, kind: 'base' as const })),
  ];

  return (
    <>
      <h1>Activar emergencia</h1>
      <p className="muted">{t('es', 'app.disclaimer')}</p>
      <ol className="row" aria-label="Pasos" style={{ listStyle: 'none', padding: 0 }}>
        {(['form', 'recipients', 'confirm'] as Step[]).map((s, i) => (
          <li key={s} className={`badge ${step === s ? 'tone-info' : 'tone-neutral'}`}>{i + 1}. {{ form: 'Qué y dónde', recipients: 'Destinatarios', confirm: 'Confirmar' }[s]}</li>
        ))}
      </ol>
      {error && <p className="notice notice-danger" role="alert">{error}</p>}

      {step === 'form' && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (!formErrors.length) loadCandidates(); }}>
          <label>Qué pasa *<input value={draft.title} onChange={(e) => update({ title: e.target.value })} required minLength={2} maxLength={120} placeholder="Rescate en playa de Isuntza" autoFocus /></label>
          <div className="row">
            {EMERGENCY_PRIORITIES.map((p) => (
              <button type="button" key={p} className={`btn ${draft.priority === p ? (p === 'critical' ? 'btn-danger' : 'btn-primary') : ''}`}
                aria-pressed={draft.priority === p} onClick={() => update({ priority: p })}>
                {priorityLabel('es', p)}
              </button>
            ))}
          </div>
          <label style={{ marginTop: 14 }}>Dirección o ubicación<input value={draft.address ?? ''} onChange={(e) => update({ address: e.target.value })} maxLength={240} /></label>
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="muted">Toca el mapa para marcar el punto{draft.location ? ` (${draft.location.lat.toFixed(5)}, ${draft.location.lng.toFixed(5)})` : ''}.</span>
            <button type="button" className="btn btn-ghost" onClick={() => navigator.geolocation.getCurrentPosition(
              (p) => update({ location: { lat: p.coords.latitude, lng: p.coords.longitude } }),
              () => setError('No se ha podido obtener tu ubicación. Marca el punto en el mapa.'))}>Usar mi ubicación</button>
            {draft.location && <button type="button" className="btn btn-ghost" onClick={() => update({ location: null })}>Quitar punto</button>}
          </div>
          <MapView points={points} onPick={(loc) => update({ location: loc })} />
          <div className="grid" style={{ marginTop: 14 }}>
            <label>Base de encuentro
              <select value={draft.baseId ?? ''} onChange={(e) => update({ baseId: e.target.value || null })}>
                <option value="">Sin base</option>
                {bases.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label>Tipo<input value={draft.type ?? ''} onChange={(e) => update({ type: e.target.value })} maxLength={60} placeholder="Rescate acuático, búsqueda…" /></label>
          </div>
          {quals.length > 0 && (
            <fieldset className="card" style={{ boxShadow: 'none', border: '1px solid var(--gray-300)' }}>
              <legend>Formación requerida</legend>
              <div className="row">
                {quals.map((q) => (
                  <label key={q.id} className="row" style={{ margin: 0 }}>
                    <input type="checkbox" checked={draft.requiredQualificationIds.includes(q.id)}
                      onChange={(e) => update({ requiredQualificationIds: e.target.checked
                        ? [...draft.requiredQualificationIds, q.id]
                        : draft.requiredQualificationIds.filter((x) => x !== q.id) })} />
                    {q.code} · {q.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <label>Descripción<textarea rows={2} value={draft.description ?? ''} onChange={(e) => update({ description: e.target.value })} maxLength={2000} /></label>
          <label>Observaciones operativas<textarea rows={2} value={draft.notes ?? ''} onChange={(e) => update({ notes: e.target.value })} maxLength={2000} /></label>
          <button className="btn btn-danger" style={{ width: '100%', minHeight: 56 }} disabled={formErrors.includes('title')}>Siguiente: destinatarios →</button>
        </form>
      )}

      {step === 'recipients' && (
        <section className="card">
          <div className="row between">
            <h2>{t('es', 'emergency.recipients_count', { count: summary.recipients })}</h2>
            <div className="row">
              <button className="btn" onClick={() => setSelection(selectAllEligible(selection, candidates))}>Seleccionar elegibles</button>
              <button className="btn" onClick={() => setSelection(deselectAll())}>Deseleccionar todos</button>
            </div>
          </div>
          {summary.withoutPush > 0 && <p className="notice">{t('es', 'emergency.no_push_warning', { count: summary.withoutPush })}</p>}
          <ul className="picker">
            {candidates.map((c) => {
              const checked = selection.selected.has(c.member_id);
              return (
                <li key={c.member_id}>
                  <label className={`pick ${c.eligible ? '' : 'ineligible'}`} style={{ margin: 0 }}>
                    <input type="checkbox" checked={checked} disabled={c.ineligible_reason === 'self'}
                      onChange={() => setSelection(toggle(selection, c))} aria-describedby={`why-${c.member_id}`} />
                    <span className="who">
                      <strong>{c.display_name}</strong>{' '}
                      {c.on_shift && <span className="badge tone-success">✅ {c.shift_confirmed ? 'Guardia confirmada' : 'De guardia'}</span>}{' '}
                      {!c.on_shift && c.availability === 'available' && <span className="badge tone-info">🟦 Disponible</span>}{' '}
                      {!c.has_push_device && <span className="badge tone-warning">📵 Sin app</span>}
                      <div className="muted" id={`why-${c.member_id}`}>
                        {c.qualification_codes.join(' · ') || 'Sin especialidades'}
                        {c.ineligible_reason && <> · <strong>{REASON_TEXT[c.ineligible_reason]}</strong>{c.missing_qualification_codes.length ? ` (${c.missing_qualification_codes.join(', ')})` : ''}</>}
                      </div>
                    </span>
                  </label>
                  {c.eligible && !checked && (
                    reasonFor === c.member_id ? (
                      <input placeholder="Motivo (privado, opcional; no indiques datos de salud)" maxLength={300} autoFocus
                        defaultValue={selection.reasons[c.member_id] ?? ''}
                        onBlur={(e) => { setSelection(setReason(selection, c.member_id, e.target.value)); setReasonFor(null); }} />
                    ) : (
                      <button className="btn btn-ghost" onClick={() => setReasonFor(c.member_id)}>
                        {selection.reasons[c.member_id] ? `Motivo: ${selection.reasons[c.member_id]}` : 'Añadir motivo de exclusión'}
                      </button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
          <div className="row between" style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => setStep('form')}>← Volver</button>
            <button className="btn btn-danger" disabled={summary.recipients === 0} onClick={() => setStep('confirm')}>Revisar y enviar →</button>
          </div>
        </section>
      )}

      {step === 'confirm' && (() => {
        const s = confirmationSummary(draft, summary.recipients);
        return (
          <section className="card stack">
            <h2>{t('es', 'emergency.confirm_title')}</h2>
            <p style={{ fontSize: '1.2rem' }}><strong>{s.title}</strong> · Prioridad {priorityLabel('es', s.priority)}</p>
            <p>📍 {s.where ?? 'Sin ubicación indicada'}</p>
            <p style={{ fontSize: '1.4rem' }}><strong>{s.recipients}</strong> destinatarios
              {summary.eligibleExcluded > 0 && <span className="muted"> · {summary.eligibleExcluded} elegibles excluidos</span>}
              {summary.ineligibleIncluded > 0 && <span className="muted"> · {summary.ineligibleIncluded} no elegibles incluidos</span>}</p>
            <button className="btn btn-sos" onClick={send} disabled={sending}>
              {sending ? 'Enviando…' : `ENVIAR ALERTA A ${s.recipients}`}
            </button>
            <button className="btn" onClick={() => setStep('recipients')} disabled={sending}>← Cambiar destinatarios</button>
          </section>
        );
      })()}
    </>
  );
}
