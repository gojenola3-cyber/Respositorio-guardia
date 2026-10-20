import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.js';
import { estimate } from './geo.js';
import { loadOrCreateVapidKeys, sendPush } from './push.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// Avisos repetidos a quien no ha contestado todavía.
const REMINDER_INTERVAL_MS = 60_000;
const MAX_REMINDERS = 3;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') };
}

function checkPin(pin, user) {
  const { hash } = hashPin(pin, user.pinSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.pinHash, 'hex'));
}

const normalizePhone = (phone) => String(phone ?? '').replace(/[^\d+]/g, '');

function validLocation(loc) {
  if (!loc) return null;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'Ubicación no válida');
  }
  const out = { lat, lng };
  if (Number.isFinite(Number(loc.accuracy))) out.accuracy = Math.round(Number(loc.accuracy));
  return out;
}

export function createApp({
  dataDir = path.join(ROOT, 'data'),
  responsableCode,
  vapidSubject = 'mailto:admin@example.com',
  pushFn = sendPush,
  log = console.log,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'db.json'));
  const vapidKeys = loadOrCreateVapidKeys(path.join(dataDir, 'vapid.json'));

  const configFile = path.join(dataDir, 'config.json');
  if (!responsableCode) {
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(
        configFile,
        JSON.stringify({ responsableCode: crypto.randomBytes(4).toString('hex') }, null, 2),
        { mode: 0o600 },
      );
    }
    responsableCode = JSON.parse(fs.readFileSync(configFile, 'utf8')).responsableCode;
  }

  const streams = new Map(); // userId -> Set<ServerResponse>
  const loginFailures = new Map(); // phone -> { count, until }
  const reminderTimers = new Map(); // alertId -> interval

  const findUser = (id) => db.data.users.find((u) => u.id === id);
  const activeAlert = () => db.data.alerts.find((a) => !a.closedAt) ?? null;
  const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, onDuty: u.onDuty });

  // ---- Vistas de una emergencia ------------------------------------------

  function responderView(alert, userId) {
    const u = findUser(userId);
    const r = alert.responses[userId];
    return {
      userId,
      name: u?.name ?? '¿?',
      phone: u?.phone ?? '',
      status: r.status,
      respondedAt: r.respondedAt ?? null,
      location: r.location ?? null,
      eta: r.status === 'going' ? estimate(r.location, alert.location) : null,
    };
  }

  function alertView(alert, viewer) {
    const all = alert.recipients.map((id) => responderView(alert, id));
    const counts = { pending: 0, going: 0, not_going: 0, arrived: 0 };
    for (const r of all) counts[r.status]++;
    const base = {
      id: alert.id,
      title: alert.title,
      description: alert.description,
      address: alert.address,
      location: alert.location,
      createdAt: alert.createdAt,
      closedAt: alert.closedAt ?? null,
      createdBy: findUser(alert.createdBy)?.name ?? '',
      counts,
    };
    if (viewer.role === 'responsable') return { ...base, responders: all };
    // Un voluntario ve su propio estado y el recuento, no la posición del resto.
    return { ...base, me: alert.responses[viewer.id] ? responderView(alert, viewer.id) : null };
  }

  // ---- Tiempo real (Server-Sent Events) ----------------------------------

  function sendEvent(userId, event, payload) {
    for (const res of streams.get(userId) ?? []) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  function broadcastAlert(alert, event = 'alert-update') {
    const audience = new Set(alert.recipients);
    for (const u of db.data.users) if (u.role === 'responsable') audience.add(u.id);
    for (const id of audience) {
      const viewer = findUser(id);
      if (viewer) sendEvent(id, event, alertView(alert, viewer));
    }
  }

  async function pushTo(userIds, data) {
    const subs = db.data.subscriptions.filter((s) => userIds.includes(s.userId));
    const expired = [];
    await Promise.all(
      subs.map(async (s) => {
        try {
          const status = await pushFn(s.subscription, data, { keys: vapidKeys, subject: vapidSubject });
          if (status === 404 || status === 410) expired.push(s.subscription.endpoint);
        } catch (err) {
          log(`Push fallido para ${s.userId}: ${err.message}`);
        }
      }),
    );
    if (expired.length) {
      db.data.subscriptions = db.data.subscriptions.filter((s) => !expired.includes(s.subscription.endpoint));
      db.save();
    }
  }

  function alarmPayload(alert, reminder = false) {
    return {
      type: 'alert',
      alertId: alert.id,
      title: `${reminder ? '⏰ RECORDATORIO · ' : ''}🚨 ${alert.title}`,
      body: [alert.address, alert.description].filter(Boolean).join(' · ') || '¿Vas? Contesta en la app.',
    };
  }

  function startReminders(alert) {
    let sent = 0;
    const timer = setInterval(() => {
      const current = db.data.alerts.find((a) => a.id === alert.id);
      sent++;
      if (!current || current.closedAt || sent > MAX_REMINDERS) {
        clearInterval(timer);
        reminderTimers.delete(alert.id);
        return;
      }
      const pending = current.recipients.filter((id) => current.responses[id].status === 'pending');
      if (pending.length) pushTo(pending, alarmPayload(current, true));
    }, REMINDER_INTERVAL_MS);
    timer.unref();
    reminderTimers.set(alert.id, timer);
  }

  // ---- Rutas -------------------------------------------------------------

  function createSession(user) {
    const token = crypto.randomBytes(24).toString('base64url');
    db.data.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
    db.save();
    return token;
  }

  function auth(req, url) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    const session = token && db.data.sessions.find((s) => s.token === token);
    const user = session && findUser(session.userId);
    if (!user) throw new HttpError(401, 'Sesión no válida. Vuelve a entrar.');
    return user;
  }

  function requireResponsable(user) {
    if (user.role !== 'responsable') throw new HttpError(403, 'Solo para responsables');
  }

  function getAlertFor(user, id) {
    const alert = db.data.alerts.find((a) => a.id === id);
    if (!alert) throw new HttpError(404, 'Emergencia no encontrada');
    if (user.role !== 'responsable' && !alert.responses[user.id]) {
      throw new HttpError(403, 'No estabas en esta emergencia');
    }
    return alert;
  }

  const routes = {
    'POST /api/register': ({ body }) => {
      const name = String(body.name ?? '').trim();
      const phone = normalizePhone(body.phone);
      const pin = String(body.pin ?? '');
      if (name.length < 2) throw new HttpError(400, 'Pon tu nombre');
      if (phone.length < 9) throw new HttpError(400, 'Teléfono no válido');
      if (!/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'El PIN debe tener entre 4 y 8 cifras');
      if (db.data.users.some((u) => u.phone === phone)) {
        throw new HttpError(409, 'Ese teléfono ya está registrado. Entra con tu PIN.');
      }
      let role = 'voluntario';
      if (body.responsableCode) {
        if (body.responsableCode !== responsableCode) throw new HttpError(403, 'Código de responsable incorrecto');
        role = 'responsable';
      }
      const { salt, hash } = hashPin(pin);
      const user = {
        id: crypto.randomUUID(),
        name,
        phone,
        role,
        onDuty: false,
        pinSalt: salt,
        pinHash: hash,
        createdAt: new Date().toISOString(),
      };
      db.data.users.push(user);
      db.save();
      return { token: createSession(user), user: publicUser(user) };
    },

    'POST /api/login': ({ body }) => {
      const phone = normalizePhone(body.phone);
      const fail = loginFailures.get(phone);
      if (fail && fail.until > Date.now()) throw new HttpError(429, 'Demasiados intentos. Espera un minuto.');
      const user = db.data.users.find((u) => u.phone === phone);
      if (!user || !checkPin(String(body.pin ?? ''), user)) {
        const count = (fail?.count ?? 0) + 1;
        loginFailures.set(phone, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
        throw new HttpError(401, 'Teléfono o PIN incorrectos');
      }
      loginFailures.delete(phone);
      return { token: createSession(user), user: publicUser(user) };
    },

    'POST /api/logout': ({ req, url }) => {
      const user = auth(req, url);
      const token = (req.headers.authorization ?? '').slice(7);
      db.data.sessions = db.data.sessions.filter((s) => !(s.userId === user.id && s.token === token));
      db.save();
      return { ok: true };
    },

    'GET /api/me': ({ user }) => {
      const alert = activeAlert();
      const visible = alert && (user.role === 'responsable' || alert.responses[user.id]);
      return {
        user: publicUser(user),
        vapidPublicKey: vapidKeys.publicKey,
        activeAlert: visible ? alertView(alert, user) : null,
      };
    },

    'POST /api/duty': ({ user, body }) => {
      user.onDuty = Boolean(body.onDuty);
      db.save();
      for (const u of db.data.users) if (u.role === 'responsable') sendEvent(u.id, 'volunteers', null);
      return { user: publicUser(user) };
    },

    'POST /api/push/subscribe': ({ user, body }) => {
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        throw new HttpError(400, 'Suscripción no válida');
      }
      if (!/^https:\/\//.test(sub.endpoint)) throw new HttpError(400, 'Suscripción no válida');
      db.data.subscriptions = db.data.subscriptions.filter((s) => s.subscription.endpoint !== sub.endpoint);
      db.data.subscriptions.push({ userId: user.id, subscription: sub });
      db.save();
      return { ok: true };
    },

    'POST /api/push/test': async ({ user }) => {
      await pushTo([user.id], { type: 'test', title: 'Prueba de aviso', body: 'Si ves esto, te llegarán las emergencias.' });
      return { ok: true };
    },

    'GET /api/volunteers': ({ user }) => {
      requireResponsable(user);
      return {
        volunteers: db.data.users
          .map((u) => ({
            ...publicUser(u),
            hasPush: db.data.subscriptions.some((s) => s.userId === u.id),
          }))
          .sort((a, b) => Number(b.onDuty) - Number(a.onDuty) || a.name.localeCompare(b.name)),
      };
    },

    'POST /api/alerts': async ({ user, body }) => {
      requireResponsable(user);
      if (activeAlert()) throw new HttpError(409, 'Ya hay una emergencia activa. Ciérrala antes de lanzar otra.');
      const title = String(body.title ?? '').trim() || 'Emergencia';
      const recipients = db.data.users.filter((u) => u.onDuty && u.id !== user.id).map((u) => u.id);
      if (!recipients.length) throw new HttpError(400, 'No hay nadie de guardia ahora mismo');
      const alert = {
        id: crypto.randomUUID(),
        title: title.slice(0, 120),
        description: String(body.description ?? '').trim().slice(0, 1000),
        address: String(body.address ?? '').trim().slice(0, 200),
        location: validLocation(body.location),
        createdBy: user.id,
        createdAt: new Date().toISOString(),
        recipients,
        responses: Object.fromEntries(recipients.map((id) => [id, { status: 'pending' }])),
      };
      db.data.alerts.push(alert);
      db.save();
      broadcastAlert(alert, 'alert');
      await pushTo(recipients, alarmPayload(alert));
      startReminders(alert);
      log(`Emergencia "${alert.title}" enviada a ${recipients.length} voluntarios`);
      return { alert: alertView(alert, user) };
    },

    'POST /api/alerts/:id/respond': ({ user, body, params }) => {
      const alert = getAlertFor(user, params.id);
      if (alert.closedAt) throw new HttpError(409, 'La emergencia ya está cerrada');
      const r = alert.responses[user.id];
      if (!r) throw new HttpError(403, 'No estabas en esta emergencia');
      const status = body.status;
      if (!['going', 'not_going', 'arrived'].includes(status)) throw new HttpError(400, 'Respuesta no válida');
      r.status = status;
      r.respondedAt = new Date().toISOString();
      if (status === 'not_going') delete r.location;
      db.save();
      broadcastAlert(alert);
      return { alert: alertView(alert, user) };
    },

    'POST /api/alerts/:id/location': ({ user, body, params }) => {
      const alert = getAlertFor(user, params.id);
      const r = alert.responses[user.id];
      if (alert.closedAt || !r || r.status !== 'going') return { ignored: true };
      r.location = { ...validLocation(body), at: new Date().toISOString() };
      db.save();
      broadcastAlert(alert);
      return { eta: estimate(r.location, alert.location) };
    },

    'POST /api/alerts/:id/close': ({ user, params }) => {
      requireResponsable(user);
      const alert = getAlertFor(user, params.id);
      if (!alert.closedAt) {
        alert.closedAt = new Date().toISOString();
        // No guardamos el rastro de posiciones más allá de la emergencia.
        for (const r of Object.values(alert.responses)) delete r.location;
        db.save();
        clearInterval(reminderTimers.get(alert.id));
        reminderTimers.delete(alert.id);
        broadcastAlert(alert);
      }
      return { alert: alertView(alert, user) };
    },

    'GET /api/alerts': ({ user }) => {
      requireResponsable(user);
      return {
        alerts: db.data.alerts
          .slice(-20)
          .reverse()
          .map((a) => alertView(a, user)),
      };
    },
  };

  const PUBLIC_ROUTES = new Set(['POST /api/register', 'POST /api/login']);

  function matchRoute(method, pathname) {
    for (const [key, handler] of Object.entries(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      const names = [];
      const re = new RegExp(
        `^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`,
      );
      const match = pathname.match(re);
      if (match) {
        return { key, handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])])) };
      }
    }
    return null;
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100_000) throw new HttpError(413, 'Petición demasiado grande');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON no válido');
    }
  }

  function serveEvents(req, res, url) {
    const user = auth(req, url);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    if (!streams.has(user.id)) streams.set(user.id, new Set());
    streams.get(user.id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      streams.get(user.id)?.delete(res);
    });
  }

  function serveStatic(res, pathname) {
    let file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'No encontrado');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' };
    // El service worker y el HTML no se cachean para que las actualizaciones lleguen.
    if (/(sw\.js|\.html)$/.test(file)) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/events') return serveEvents(req, res, url);
      if (url.pathname.startsWith('/api/')) {
        const route = matchRoute(req.method, url.pathname);
        if (!route) throw new HttpError(404, 'No encontrado');
        const body = req.method === 'POST' ? await readBody(req) : {};
        const user = PUBLIC_ROUTES.has(route.key) ? null : auth(req, url);
        const result = await route.handler({ req, url, body, user, params: route.params });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
      return serveStatic(res, url.pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) log(err);
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Error interno' : err.message }));
    }
  });

  server.on('close', () => {
    for (const t of reminderTimers.values()) clearInterval(t);
  });

  return { server, responsableCode, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const { server, responsableCode } = createApp({
    dataDir: process.env.DATA_DIR,
    responsableCode: process.env.RESPONSABLE_CODE,
    vapidSubject: process.env.VAPID_SUBJECT,
  });
  server.listen(port, () => {
    console.log(`Guardia escuchando en http://localhost:${port}`);
    console.log(`Código para registrarse como responsable: ${responsableCode}`);
  });
}
