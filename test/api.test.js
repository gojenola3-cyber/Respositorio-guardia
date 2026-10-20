import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server/index.js';

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardia-'));
  const pushes = [];
  const { server } = createApp({
    dataDir,
    responsableCode: 'jefe',
    pushFn: async (sub, data) => (pushes.push({ endpoint: sub.endpoint, data }), 201),
    log: () => {},
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, call, pushes, base };
}

test('flujo completo: apuntarse, emergencia, respuesta y seguimiento', async (t) => {
  const { server, call, pushes } = await setup();
  t.after(() => server.close());

  const jefe = await call('POST', '/api/register', { name: 'Jefa', phone: '600000001', pin: '1234', responsableCode: 'jefe' });
  assert.equal(jefe.status, 200);
  assert.equal(jefe.body.user.role, 'responsable');

  const bad = await call('POST', '/api/register', { name: 'Xabi', phone: '600000009', pin: '1234', responsableCode: 'mal' });
  assert.equal(bad.status, 403);

  const ane = await call('POST', '/api/register', { name: 'Ane', phone: '600 000 002', pin: '1111' });
  const jon = await call('POST', '/api/register', { name: 'Jon', phone: '600000003', pin: '2222' });
  const mikel = await call('POST', '/api/register', { name: 'Mikel', phone: '600000004', pin: '3333' });
  assert.equal(ane.body.user.role, 'voluntario');

  // Sin nadie de guardia no se puede lanzar.
  const empty = await call('POST', '/api/alerts', { title: 'Prueba' }, jefe.body.token);
  assert.equal(empty.status, 400);

  await call('POST', '/api/duty', { onDuty: true }, ane.body.token);
  await call('POST', '/api/duty', { onDuty: true }, jon.body.token);
  // Mikel no se apunta.

  const sub = { endpoint: 'https://push.example.com/ane', keys: { p256dh: 'x', auth: 'y' } };
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: sub }, ane.body.token)).status, 200);

  // Un voluntario no puede lanzar emergencias.
  assert.equal((await call('POST', '/api/alerts', { title: 'x' }, ane.body.token)).status, 403);

  const created = await call(
    'POST',
    '/api/alerts',
    { title: 'Rescate playa', address: 'Isuntza', location: { lat: 43.3606, lng: -2.5057 } },
    jefe.body.token,
  );
  assert.equal(created.status, 200);
  const alert = created.body.alert;
  assert.equal(alert.responders.length, 2);
  assert.deepEqual(alert.counts, { pending: 2, going: 0, not_going: 0, arrived: 0 });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].endpoint, sub.endpoint);
  assert.equal(pushes[0].data.alertId, alert.id);

  // Solo una emergencia activa a la vez.
  assert.equal((await call('POST', '/api/alerts', { title: 'Otra' }, jefe.body.token)).status, 409);

  // Mikel no estaba de guardia: no ve la emergencia.
  assert.equal((await call('GET', '/api/me', null, mikel.body.token)).body.activeAlert, null);
  assert.equal((await call('POST', `/api/alerts/${alert.id}/respond`, { status: 'going' }, mikel.body.token)).status, 403);

  // Ane va, Jon no.
  await call('POST', `/api/alerts/${alert.id}/respond`, { status: 'going' }, ane.body.token);
  await call('POST', `/api/alerts/${alert.id}/respond`, { status: 'not_going' }, jon.body.token);

  // Jon no puede mandar ubicación si no va.
  const ignored = await call('POST', `/api/alerts/${alert.id}/location`, { lat: 43.3, lng: -2.6 }, jon.body.token);
  assert.equal(ignored.body.ignored, true);

  // Ane manda su posición desde Gernika.
  const loc = await call('POST', `/api/alerts/${alert.id}/location`, { lat: 43.3167, lng: -2.6786, accuracy: 12 }, ane.body.token);
  assert.ok(loc.body.eta.minutes > 15);
  assert.equal((await call('POST', `/api/alerts/${alert.id}/location`, { lat: 200, lng: 0 }, ane.body.token)).status, 400);

  // El responsable ve a todos con su ETA; el voluntario solo a sí mismo.
  const view = (await call('GET', '/api/me', null, jefe.body.token)).body.activeAlert;
  assert.deepEqual(view.counts, { pending: 0, going: 1, not_going: 1, arrived: 0 });
  const aneRow = view.responders.find((r) => r.name === 'Ane');
  assert.equal(aneRow.location.accuracy, 12);
  assert.ok(aneRow.eta.minutes > 15);
  const aneView = (await call('GET', '/api/me', null, ane.body.token)).body.activeAlert;
  assert.equal(aneView.responders, undefined);
  assert.equal(aneView.me.status, 'going');

  await call('POST', `/api/alerts/${alert.id}/respond`, { status: 'arrived' }, ane.body.token);

  // Cerrar borra las posiciones.
  const closed = await call('POST', `/api/alerts/${alert.id}/close`, null, jefe.body.token);
  assert.ok(closed.body.alert.closedAt);
  assert.ok(closed.body.alert.responders.every((r) => r.location === null));
  assert.equal((await call('GET', '/api/me', null, ane.body.token)).body.activeAlert, null);
});

test('login, PIN incorrecto y bloqueo por intentos', async (t) => {
  const { server, call } = await setup();
  t.after(() => server.close());
  await call('POST', '/api/register', { name: 'Ane', phone: '600000002', pin: '1111' });
  assert.equal((await call('POST', '/api/register', { name: 'Ane', phone: '600000002', pin: '1111' })).status, 409);
  assert.equal((await call('POST', '/api/login', { phone: '600000002', pin: '1111' })).status, 200);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/login', { phone: '600000002', pin: '0000' })).status, 401);
  }
  assert.equal((await call('POST', '/api/login', { phone: '600000002', pin: '1111' })).status, 429);
  assert.equal((await call('GET', '/api/me', null, 'token-falso')).status, 401);
});

test('sirve la app y no deja salir de public/', async (t) => {
  const { server, base } = await setup();
  t.after(() => server.close());
  const html = await fetch(`${base}/`);
  assert.match(await html.text(), /<title>Guardia<\/title>/);
  const sw = await fetch(`${base}/sw.js`);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const escape = await fetch(`${base}/..%2F..%2Fpackage.json`);
  assert.doesNotMatch(await escape.text(), /"scripts"/);
});

test('eventos en tiempo real: el voluntario recibe la alarma', async (t) => {
  const { server, call, base } = await setup();
  t.after(() => server.close());
  const jefe = await call('POST', '/api/register', { name: 'Jefa', phone: '600000001', pin: '1234', responsableCode: 'jefe' });
  const ane = await call('POST', '/api/register', { name: 'Ane', phone: '600000002', pin: '1111' });
  await call('POST', '/api/duty', { onDuty: true }, ane.body.token);

  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(`${base}/api/events?token=${ane.body.token}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // "retry:"

  await call('POST', '/api/alerts', { title: 'Incendio monte' }, jefe.body.token);
  let text = '';
  while (!text.includes('\n\n', text.indexOf('event: alert'))) {
    text += new TextDecoder().decode((await reader.read()).value);
  }
  assert.match(text, /event: alert\ndata: .*Incendio monte/);
  assert.doesNotMatch(text, /responders/);
});
