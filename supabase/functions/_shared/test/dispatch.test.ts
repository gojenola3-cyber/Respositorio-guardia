import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkReceipts,
  dueForReminder,
  sendToRecipients,
  sweep,
  type DeliveryStatus,
  type EmergencyInfo,
  type NewDelivery,
  type RecipientStatus,
  type Store,
  type Target,
} from '../dispatch.ts';
import { buildMessage, expoClient, type ExpoReceipt, type ExpoTicket, type PushClient } from '../expo.ts';

// ---- Almacén en memoria con la misma semántica que la base de datos ----
function memoryStore(emergency: Partial<EmergencyInfo> = {}) {
  const e: EmergencyInfo = {
    id: 'e1', orgId: 'org', title: 'Rescate en Isuntza', address: 'Playa de Isuntza',
    priority: 'high', status: 'active', criticalAlertsEnabled: false, ...emergency,
  };
  const targets = new Map<string, Target>();
  const deliveries: (NewDelivery & { id: string; touched?: boolean })[] = [];
  const revoked: string[] = [];
  const store: Store = {
    async getEmergency(id) { return id === e.id ? e : null; },
    async getTargets(_id, statuses: RecipientStatus[], ids) {
      return [...targets.values()]
        .filter((t) => statuses.includes(t.status) && (!ids || ids.includes(t.recipientId)))
        .map((t) => ({ ...t, tokens: t.tokens.filter((k) => !revoked.includes(k.id)) }));
    },
    async getCancellationNotified() {
      return new Set(deliveries.filter((d) => d.kind === 'cancellation').map((d) => d.recipientId));
    },
    async insertDeliveries(rows) { rows.forEach((r, i) => deliveries.push({ ...r, id: `d${deliveries.length + i}` })); },
    async markNotified(ids, ok, at) {
      for (const id of ids) {
        const t = targets.get(id)!;
        t.attempts++;
        t.lastNotifiedAt = at.toISOString();
        if (ok.has(id) && t.status === 'pending_send') t.status = 'sent';
      }
    },
    async revokeTokens(ids) { revoked.push(...ids); },
    async getPendingReceipts() {
      return deliveries.filter((d) => d.status === 'provider_accepted' && d.providerTicketId)
        .map((d) => ({ deliveryId: d.id, ticketId: d.providerTicketId!, pushTokenId: d.pushTokenId }));
    },
    async updateDelivery(id, status: DeliveryStatus, code) {
      const d = deliveries.find((x) => x.id === id)!;
      d.status = status;
      d.errorCode = code;
    },
    async touchReceipts(ids) { for (const d of deliveries) if (ids.includes(d.id)) d.touched = true; },
    async getActiveEmergencies() {
      return e.status === 'active' ? [{ id: e.id, resendIntervalSeconds: 120, maxResends: 2 }] : [];
    },
  };
  const add = (id: string, tokens: string[], status: RecipientStatus = 'pending_send') =>
    targets.set(id, { recipientId: id, status, attempts: 0, lastNotifiedAt: null, tokens: tokens.map((t) => ({ id: `tok-${t}`, token: t })) });
  return { store, targets, deliveries, revoked, add, emergency: e };
}

// ---- Proveedor push simulado ----
function fakePush(behaviour: (msgs: { to: string }[]) => ExpoTicket[] | Error, receipts: Record<string, ExpoReceipt> = {}) {
  const sent: { to: string; title: string }[][] = [];
  const push: PushClient = {
    async send(messages) {
      sent.push(messages);
      const r = behaviour(messages);
      if (r instanceof Error) throw r;
      return r;
    },
    async getReceipts() { return receipts; },
  };
  return { push, sent };
}
const allOk = (msgs: { to: string }[]): ExpoTicket[] => msgs.map((m) => ({ status: 'ok', id: `ticket-${m.to}` }));

test('[6] solo se envía a los destinatarios y se registra cada resultado', async () => {
  const m = memoryStore();
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]', 'ExponentPushToken[vera-ipad-00002]']);
  m.add('victor', []);
  const { push, sent } = fakePush(allOk);
  const r = await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert' });

  assert.equal(sent.flat().length, 2, 'un mensaje por dispositivo, nadie más');
  assert.deepEqual({ accepted: r.accepted, noDevice: r.noDevice }, { accepted: 2, noDevice: 1 });
  assert.deepEqual(r.unreachableRecipientIds, ['victor'], 'el panel sabe a quién llamar por teléfono');
  assert.equal(m.targets.get('vera')!.status, 'sent');
  assert.equal(m.targets.get('victor')!.status, 'pending_send', 'sin dispositivo NO se marca como enviada');
  assert.deepEqual(m.deliveries.map((d) => d.status).sort(), ['no_token', 'provider_accepted', 'provider_accepted']);
});

test('[14] repetir la activación no reenvía la alerta inicial', async () => {
  const m = memoryStore();
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]']);
  const { push, sent } = fakePush(allOk);
  await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert' });
  const second = await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert' });
  assert.equal(second.targets, 0);
  assert.equal(sent.length, 1);
});

test('fallo del proveedor: queda pendiente de envío, con error registrado', async () => {
  const m = memoryStore();
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]']);
  const { push } = fakePush(() => new Error('fetch failed'));
  const r = await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert' });
  assert.equal(r.failed, 1);
  assert.equal(m.targets.get('vera')!.status, 'pending_send', 'un envío fallido nunca cuenta como enviado');
  assert.equal(m.targets.get('vera')!.attempts, 1);
  assert.equal(m.deliveries[0]!.status, 'provider_error');
  assert.equal(m.deliveries[0]!.errorCode, 'fetch failed');
});

test('token caducado (DeviceNotRegistered) se revoca', async () => {
  const m = memoryStore();
  m.add('vera', ['ExponentPushToken[vera-old-00000001]']);
  const { push } = fakePush((msgs) => msgs.map(() => ({ status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } })));
  await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert' });
  assert.deepEqual(m.revoked, ['tok-ExponentPushToken[vera-old-00000001]']);
  assert.equal(m.deliveries[0]!.errorCode, 'DeviceNotRegistered');
});

test('emergencia cerrada: no se envía nada', async () => {
  const m = memoryStore({ status: 'closed' });
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]']);
  const { push, sent } = fakePush(allOk);
  const r = await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert' });
  assert.equal(r.targets, 0);
  assert.equal(sent.length, 0);
});

test('respuestas tardías: recordatorios solo a quien no contesta, con intervalo y límite', async () => {
  const m = memoryStore();
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]']);
  m.add('valen', ['ExponentPushToken[valen-phone-0001]']);
  const { push, sent } = fakePush(allOk);
  const t0 = new Date('2026-10-20T10:00:00Z');
  await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'alert', now: t0 });
  m.targets.get('valen')!.status = 'accepted';

  await sweep({ store: m.store, push, now: new Date(t0.getTime() + 60_000) });
  assert.equal(sent.length, 1, 'antes del intervalo no se recuerda');

  const s = await sweep({ store: m.store, push, now: new Date(t0.getTime() + 121_000) });
  assert.equal(s.reminders, 1);
  assert.deepEqual(sent[1]!.map((x) => x.to), ['ExponentPushToken[vera-iphone-0001]'], 'solo a quien no ha contestado');
  assert.match(sent[1]![0]!.title, /^RECORDATORIO/);

  await sweep({ store: m.store, push, now: new Date(t0.getTime() + 250_000) });
  await sweep({ store: m.store, push, now: new Date(t0.getTime() + 400_000) });
  assert.equal(m.targets.get('vera')!.attempts, 3, 'alerta + 2 recordatorios (maxResends = 2)');
  assert.equal(sent.length, 3, 'después del límite no se insiste más');
});

test('dueForReminder', () => {
  const now = new Date('2026-10-20T10:10:00Z');
  const t = (o: Partial<Target>): Target => ({ recipientId: 'x', status: 'sent', attempts: 1, lastNotifiedAt: '2026-10-20T10:00:00Z', tokens: [], ...o });
  assert.equal(dueForReminder(t({}), 120, 3, now), true);
  assert.equal(dueForReminder(t({ status: 'accepted' }), 120, 3, now), false);
  assert.equal(dueForReminder(t({ attempts: 4 }), 120, 3, now), false);
  assert.equal(dueForReminder(t({ lastNotifiedAt: '2026-10-20T10:09:30Z' }), 120, 3, now), false);
  assert.equal(dueForReminder(t({ attempts: 0, status: 'pending_send' }), 120, 3, now), true);
});

test('recibos: aceptado por la plataforma, rechazado o aún no disponible', async () => {
  const m = memoryStore();
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]']);
  m.add('victor', ['ExponentPushToken[victor-phone-001]']);
  m.add('valen', ['ExponentPushToken[valen-phone-0001]']);
  const { push: p1 } = fakePush(allOk);
  await sendToRecipients({ store: m.store, push: p1, emergencyId: 'e1', kind: 'alert' });
  const { push: p2 } = fakePush(allOk, {
    'ticket-ExponentPushToken[vera-iphone-0001]': { status: 'ok' },
    'ticket-ExponentPushToken[victor-phone-001]': { status: 'error', details: { error: 'DeviceNotRegistered' } },
  });
  const stats = await checkReceipts({ store: m.store, push: p2 });
  assert.deepEqual(stats, { checked: 3, ok: 1, error: 1, missing: 1 });
  const byRecipient = Object.fromEntries(m.deliveries.map((d) => [d.recipientId, d]));
  assert.equal(byRecipient.vera!.status, 'platform_accepted');
  assert.equal(byRecipient.victor!.status, 'platform_error');
  assert.equal(byRecipient.valen!.touched, true);
  assert.deepEqual(m.revoked, ['tok-ExponentPushToken[victor-phone-001]']);
  assert.equal(m.targets.get('vera')!.status, 'sent', 'un recibo OK no se confunde con "abierta"');
});

test('cancelación: avisa a los afectados una sola vez', async () => {
  const m = memoryStore({ status: 'cancelled' });
  m.add('vera', ['ExponentPushToken[vera-iphone-0001]'], 'cancelled');
  m.add('valen', ['ExponentPushToken[valen-phone-0001]'], 'declined');
  const { push, sent } = fakePush(allOk);
  await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'cancellation' });
  await sendToRecipients({ store: m.store, push, emergencyId: 'e1', kind: 'cancellation' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.map((x) => x.to), ['ExponentPushToken[vera-iphone-0001]'], 'quien ya rechazó no recibe el aviso');
  assert.equal(sent[0]![0]!.title, 'Emergencia cancelada');
});

test('mensaje: crítico solo con permiso de Apple; si no, time-sensitive', () => {
  const c = { emergencyId: 'e', recipientId: 'r', title: 'Rescate', address: 'Puerto', priorityLabel: 'crítica' };
  const normal = buildMessage('alert', 'tok', { ...c, critical: false });
  assert.equal(normal.interruptionLevel, 'time-sensitive');
  assert.equal(normal.sound, 'emergency.wav');
  assert.equal(normal.channelId, 'emergency-alerts');
  assert.equal(normal.categoryId, 'emergency_response');
  assert.deepEqual(normal.data, { type: 'emergency_alert', emergencyId: 'e', recipientId: 'r' });
  const critical = buildMessage('alert', 'tok', { ...c, critical: true });
  assert.equal(critical.interruptionLevel, 'critical');
  assert.deepEqual(critical.sound, { critical: true, name: 'emergency.wav', volume: 1 });
});

test('cliente Expo: reintenta 5xx y errores de red, no reintenta 4xx', async () => {
  let calls = 0;
  const flaky: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return new Response('busy', { status: 503 });
    return Response.json({ data: [{ status: 'ok', id: 'abc' }] });
  };
  const client = expoClient({ fetch: flaky, backoffMs: 1 });
  assert.deepEqual(await client.send([{ to: 't', title: 'x', body: 'y', data: {} }]), [{ status: 'ok', id: 'abc' }]);
  assert.equal(calls, 3);

  calls = 0;
  const unauthorized: typeof fetch = async () => {
    calls++;
    return Response.json({ errors: [{ code: 'UNAUTHORIZED', message: 'bad token' }] }, { status: 401 });
  };
  await assert.rejects(expoClient({ fetch: unauthorized, backoffMs: 1 }).send([]), /UNAUTHORIZED/);
  assert.equal(calls, 1);

  const down: typeof fetch = async () => new Response('down', { status: 502 });
  await assert.rejects(expoClient({ fetch: down, retries: 1, backoffMs: 1 }).send([]), /HTTP 502/);
});
