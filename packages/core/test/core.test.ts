import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countRecipients,
  deselectAll,
  draftToRpc,
  errorMessage,
  estimateArrival,
  initialSelection,
  locationFreshness,
  missingTranslations,
  navigationLinks,
  newDraft,
  selectAllEligible,
  selectionPayload,
  selectionSummary,
  setReason,
  summarize,
  t,
  toggle,
  validateDraft,
  type Candidate,
} from '../src/index.ts';

const cand = (id: string, eligible: boolean, extra: Partial<Candidate> = {}): Candidate => ({
  member_id: id,
  display_name: id,
  eligible,
  ineligible_reason: eligible ? null : 'not_available',
  on_shift: eligible,
  has_push_device: true,
  ...extra,
});

const candidates = [
  cand('vera', true),
  cand('victor', true, { has_push_device: false }),
  cand('ana', false),
  cand('rafa', false, { ineligible_reason: 'self' }),
];

test('[4] los elegibles empiezan seleccionados, los no elegibles no', () => {
  const sel = initialSelection(candidates);
  assert.deepEqual([...sel.selected].sort(), ['vera', 'victor']);
});

test('[5] se excluye a una persona con un toque y con motivo privado', () => {
  let sel = initialSelection(candidates);
  sel = toggle(sel, candidates[1]!);
  sel = setReason(sel, 'victor', '  Baja médica  ');
  assert.deepEqual([...sel.selected], ['vera']);
  assert.deepEqual(selectionPayload(sel), {
    p_recipients: ['vera'],
    p_exclusion_reasons: { victor: 'Baja médica' },
  });
  // Volver a marcarle borra el motivo.
  sel = toggle(sel, candidates[1]!);
  assert.deepEqual(selectionPayload(sel).p_exclusion_reasons, {});
});

test('el responsable no puede seleccionarse a sí mismo', () => {
  const sel = toggle(initialSelection(candidates), candidates[3]!);
  assert.equal(sel.selected.has('rafa'), false);
});

test('seleccionar/deseleccionar todos y resumen antes de enviar', () => {
  let sel = deselectAll();
  assert.equal(selectionSummary(sel, candidates).recipients, 0);
  sel = selectAllEligible(sel, candidates);
  sel = toggle(sel, candidates[2]!); // el responsable incluye a un no elegible
  assert.deepEqual(selectionSummary(sel, candidates), {
    recipients: 3,
    withoutPush: 1,
    ineligibleIncluded: 1,
    eligibleExcluded: 0,
  });
});

test('recuento y resumen del panel', () => {
  const s = summarize(countRecipients(['accepted', 'en_route', 'arrived', 'declined', 'sent', 'pending_send', 'opened']));
  assert.deepEqual(s, { total: 7, yes: 3, no: 1, pending: 3, enRoute: 1, arrived: 1, cancelled: 0 });
});

test('validación del borrador y parámetros de la RPC', () => {
  const d = newDraft('11111111-1111-4111-8111-111111111111');
  assert.deepEqual(validateDraft(d, 0), ['title', 'recipients']);
  d.title = '  Rescate  ';
  d.location = { lat: 200, lng: 0 };
  assert.deepEqual(validateDraft(d, 2), ['location']);
  d.location = { lat: 43.36, lng: -2.5 };
  assert.deepEqual(validateDraft(d, 2), []);
  const rpc = draftToRpc('org', d);
  assert.equal(rpc.p_title, 'Rescate');
  assert.equal(rpc.p_lat, 43.36);
  assert.equal(rpc.p_idempotency_key, d.idempotencyKey);
});

test('ETA orientativa y antigüedad de la posición', () => {
  const eta = estimateArrival({ lat: 43.3167, lng: -2.6786 }, { lat: 43.3622, lng: -2.5049 });
  assert.ok(eta && eta.minutes > 15 && eta.minutes < 30, JSON.stringify(eta));
  assert.equal(estimateArrival(null, { lat: 0, lng: 0 }), null);
  const now = new Date('2026-10-20T10:00:00Z');
  assert.equal(locationFreshness('2026-10-20T09:59:00Z', now), 'fresh');
  assert.equal(locationFreshness('2026-10-20T09:55:00Z', now), 'stale');
  assert.equal(locationFreshness('2026-10-20T09:40:00Z', now), 'old');
});

test('enlaces de navegación externa', () => {
  const l = navigationLinks({ lat: 43.36, lng: -2.5 }, 'Base del puerto');
  assert.match(l.apple, /daddr=43.36,-2.5/);
  assert.match(l.google, /destination=43.36,-2.5/);
  assert.match(l.waze, /ll=43.36,-2.5/);
});

test('i18n: castellano, euskera con respaldo y errores del servidor', () => {
  assert.equal(t('es', 'emergency.accept'), 'SÍ, ACUDO');
  assert.equal(t('eu', 'emergency.accept'), 'BAI, BANOA');
  assert.equal(t('eu', 'emergency.activate'), 'ACTIVAR EMERGENCIA'); // sin traducir: castellano
  assert.equal(t('es', 'emergency.recipients_count', { count: 4 }), '4 destinatarios');
  assert.equal(errorMessage('es', { message: 'overlapping_shift' }), 'Ya tienes otra guardia a esa hora.');
  assert.equal(errorMessage('es', new TypeError('fetch failed')), t('es', 'error.network'));
  assert.equal(errorMessage('es', { message: 'algo raro' }), t('es', 'error.unknown'));
  assert.ok(missingTranslations('eu').length > 0);
  assert.equal(missingTranslations('es').length, 0);
});
