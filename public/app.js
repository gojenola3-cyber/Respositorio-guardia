// Cliente de la app de guardia: voluntarios y responsables.
const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('token'),
  me: null,
  vapidKey: null,
  alert: null,
  volunteers: [],
};

// ---- Utilidades -----------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout(false);
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

const STATUS_LABEL = {
  pending: 'Sin contestar',
  going: 'Va',
  not_going: 'No puede',
  arrived: 'Ha llegado',
};

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `hace ${s} s`;
  return `hace ${Math.round(s / 60)} min`;
}

const etaText = (eta) => (eta ? `${eta.minutes} min · ${eta.km} km` : 'Sin ubicación');

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function myResponse(alert = state.alert) {
  if (!alert || !state.me) return null;
  return alert.me ?? alert.responders?.find((r) => r.userId === state.me.id) ?? null;
}

// ---- Sirena (Web Audio) ---------------------------------------------------
// iOS solo deja sonar audio después de un toque del usuario, así que el
// contexto se desbloquea en la primera interacción con la página.

let audioCtx;
let siren;

function unlockAudio() {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', unlockAudio, { passive: true });

function startSiren() {
  unlockAudio();
  if (siren) return;
  const osc = audioCtx.createOscillator();
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  const gain = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 900;
  lfo.frequency.value = 1.5; // subidas y bajadas por segundo
  lfoGain.gain.value = 350;
  gain.gain.value = 0.25;
  lfo.connect(lfoGain).connect(osc.frequency);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  lfo.start();
  const vibrate = setInterval(() => navigator.vibrate?.([600, 300, 600]), 1500);
  siren = { osc, lfo, vibrate };
}

function stopSiren() {
  if (!siren) return;
  siren.osc.stop();
  siren.lfo.stop();
  clearInterval(siren.vibrate);
  navigator.vibrate?.(0);
  siren = null;
}

// ---- Alarma a pantalla completa ------------------------------------------

function showAlarm(alert) {
  $('#alarm-title').textContent = alert.title;
  $('#alarm-address').textContent = alert.address || '';
  $('#alarm-desc').textContent = alert.description || '';
  $('#alarm').hidden = false;
  startSiren();
}

function hideAlarm() {
  $('#alarm').hidden = true;
  stopSiren();
}

$('#alarm').addEventListener('pointerdown', () => {
  // Si llegó con el audio bloqueado, el primer toque arranca la sirena.
  if (!siren && !$('#alarm').hidden) startSiren();
});
$('#alarm-mute').addEventListener('click', (e) => {
  e.stopPropagation();
  stopSiren();
});
$('#alarm-go').addEventListener('click', () => respond('going'));
$('#alarm-nogo').addEventListener('click', () => respond('not_going'));

// ---- Seguimiento GPS de quien va -----------------------------------------

let watchId = null;
let wakeLock = null;
let lastSent = { at: 0, lat: 0, lng: 0 };

async function startTracking() {
  if (watchId !== null || !navigator.geolocation || !state.alert) return;
  const alertId = state.alert.id;
  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      const moved = Math.abs(lat - lastSent.lat) + Math.abs(lng - lastSent.lng) > 0.0004;
      if (Date.now() - lastSent.at < 10_000 && !moved) return;
      lastSent = { at: Date.now(), lat, lng };
      try {
        await api('POST', `/api/alerts/${alertId}/location`, { lat, lng, accuracy });
      } catch (err) {
        console.warn(err);
      }
    },
    (err) => toast(`No se puede leer tu ubicación: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  // Mantener la pantalla encendida ayuda a que el GPS siga enviando.
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* no soportado */
  }
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  wakeLock?.release?.();
  wakeLock = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.me) return;
  // Al volver a la app: reponer el wake lock y refrescar el estado.
  if (watchId !== null && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* no soportado */
    }
  }
  loadMe().catch(() => {});
});

// ---- Respuestas ------------------------------------------------------------

async function respond(status) {
  if (!state.alert) return;
  try {
    const { alert } = await api('POST', `/api/alerts/${state.alert.id}/respond`, { status });
    hideAlarm();
    setAlert(alert);
    toast(status === 'going' ? 'Avisado: vas. Compartiendo tu ubicación.' : status === 'arrived' ? 'Marcado como llegado' : 'Avisado: no puedes ir');
  } catch (err) {
    toast(err.message);
  }
}

function setAlert(alert) {
  state.alert = alert && !alert.closedAt ? alert : null;
  if (alert?.closedAt) toast('Emergencia cerrada');
  const mine = myResponse();
  if (mine?.status === 'going') startTracking();
  else stopTracking();
  if (!mine || mine.status !== 'pending') hideAlarm();
  render();
}

// ---- Avisos push -----------------------------------------------------------

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function swRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}

async function subscribePush(ask) {
  const reg = await swRegistration();
  if (!reg || !('PushManager' in window)) {
    if (ask) toast(isIos() && !isStandalone() ? 'Primero añade la app a la pantalla de inicio' : 'Este navegador no admite avisos');
    return;
  }
  if (ask && Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return renderPushStatus();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(state.vapidKey),
  });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  renderPushStatus(true);
  if (ask) toast('Avisos activados');
}

function renderPushStatus(subscribed) {
  const status = $('#push-status');
  if (!('Notification' in window)) {
    status.textContent = isIos() && !isStandalone()
      ? 'Añade la app a la pantalla de inicio para poder recibir avisos.'
      : 'Este navegador no admite avisos.';
    $('#btn-push').hidden = true;
    return;
  }
  const perm = Notification.permission;
  $('#btn-push').hidden = perm === 'granted' && subscribed;
  status.textContent =
    perm === 'granted'
      ? subscribed ? 'Activados: te sonará aunque tengas la app cerrada.' : 'Permiso concedido.'
      : perm === 'denied'
        ? 'Bloqueados. Actívalos en los ajustes del móvil para esta app.'
        : 'Sin activar. Sin esto solo te enterarás con la app abierta.';
}

$('#btn-push').addEventListener('click', () => subscribePush(true).catch((e) => toast(e.message)));
$('#btn-test').addEventListener('click', async () => {
  startSiren();
  setTimeout(stopSiren, 2500);
  try {
    await api('POST', '/api/push/test');
  } catch (e) {
    toast(e.message);
  }
});

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'alert') loadMe().catch(() => {});
});

// ---- Tiempo real -----------------------------------------------------------

let events;
function connectEvents() {
  events?.close();
  events = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  events.addEventListener('alert', (e) => {
    const alert = JSON.parse(e.data);
    setAlert(alert);
    if (myResponse(alert)?.status === 'pending') showAlarm(alert);
  });
  events.addEventListener('alert-update', (e) => setAlert(JSON.parse(e.data)));
  events.addEventListener('volunteers', () => loadVolunteers());
}

// ---- Mapa (responsable) ---------------------------------------------------

let map;
let pickMarker;
let pickedLocation = null;
let layer;

// Leaflet se carga solo en el panel del responsable y sin bloquear la app:
// si el CDN falla, todo funciona igual salvo el mapa.
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet';
let leafletLoading;
function loadLeaflet() {
  leafletLoading ??= new Promise((resolve, reject) => {
    document.head.append(el('link', { rel: 'stylesheet', href: `${LEAFLET}.css` }));
    const script = el('script', { src: `${LEAFLET}.js`, onload: resolve, onerror: reject });
    document.head.append(script);
  }).then(
    () => render(),
    () => {
      $('#map').textContent = 'No se ha podido cargar el mapa. Las distancias y tiempos siguen funcionando.';
      $('#map').style.height = 'auto';
      $('#map').style.padding = '16px';
    },
  );
}

function initMap() {
  if (map) return;
  if (!window.L) return loadLeaflet();
  map = L.map('map').setView([43.3606, -2.5057], 13); // Lekeitio por defecto
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', (e) => {
    if (state.alert) return;
    setPicked({ lat: e.latlng.lat, lng: e.latlng.lng });
  });
}

function setPicked(loc) {
  pickedLocation = loc;
  if (!map) return;
  pickMarker ??= L.circleMarker(loc, { radius: 10, color: '#c8102e', fillOpacity: 0.8 }).addTo(map);
  pickMarker.setLatLng(loc);
}

function renderMap() {
  initMap();
  if (!map) return;
  layer.clearLayers();
  const alert = state.alert;
  if (pickMarker) {
    if (alert) pickMarker.remove();
    else pickMarker.addTo(map);
  }
  if (!alert) return;
  const points = [];
  if (alert.location) {
    L.circleMarker(alert.location, { radius: 12, color: '#c8102e', fillOpacity: 0.9 })
      .bindTooltip('Emergencia', { permanent: true, direction: 'top' })
      .addTo(layer);
    points.push(alert.location);
  }
  for (const r of alert.responders ?? []) {
    if (!r.location) continue;
    L.circleMarker(r.location, { radius: 8, color: r.status === 'arrived' ? '#1d5fbf' : '#1b8a3a', fillOpacity: 0.9 })
      .bindTooltip(`${r.name}${r.eta ? ` · ${r.eta.minutes} min` : ''}`, { permanent: true, direction: 'right' })
      .addTo(layer);
    points.push(r.location);
  }
  if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
  else if (points.length === 1) map.setView(points[0], 14);
}

// ---- Render ----------------------------------------------------------------

function render() {
  const me = state.me;
  $('#me-name').textContent = me.name;
  $('#me-role').textContent = me.role === 'responsable' ? 'Responsable' : 'Voluntario';

  $('#install-hint').hidden = !(isIos() && !isStandalone());

  const duty = $('#btn-duty');
  duty.textContent = me.onDuty ? '✅ Estoy de guardia' : 'Apuntarme a la guardia';
  duty.classList.toggle('on', me.onDuty);
  $('#duty-help').textContent = me.onDuty
    ? 'Te llegará la alarma si se activa una emergencia. Toca para desapuntarte.'
    : 'Ahora mismo no recibirás avisos.';

  renderVolunteerAlert();
  if (me.role === 'responsable') renderResponsable();
}

function renderVolunteerAlert() {
  const card = $('#volunteer-alert');
  const alert = state.alert;
  const mine = myResponse();
  card.hidden = !mine;
  if (!mine) return;
  card.replaceChildren(
    el('h2', { textContent: `🚨 ${alert.title}` }),
    alert.address ? el('p', { textContent: alert.address }) : null,
    alert.description ? el('p', { className: 'muted', textContent: alert.description }) : null,
    el('p', {}, 'Tu respuesta: ', el('span', { className: `chip ${mine.status}`, textContent: STATUS_LABEL[mine.status] })),
    el('p', { className: 'muted', textContent: `Van ${alert.counts.going + alert.counts.arrived} de ${Object.values(alert.counts).reduce((a, b) => a + b, 0)}` }),
  );
  if (mine.status === 'pending') {
    card.append(
      el('div', { className: 'row' },
        el('button', { className: 'btn go', textContent: 'VOY', onclick: () => respond('going') }),
        el('button', { className: 'btn nogo', textContent: 'NO PUEDO', onclick: () => respond('not_going') }),
      ),
    );
  } else if (mine.status === 'going') {
    card.append(el('div', { className: 'big', textContent: mine.eta ? `Te faltan ~${mine.eta.minutes} min` : 'Buscando tu ubicación…' }));
    const row = el('div', { className: 'row' },
      el('button', { className: 'btn go', textContent: 'He llegado', onclick: () => respond('arrived') }),
      el('button', { className: 'btn ghost', textContent: 'Al final no puedo', onclick: () => respond('not_going') }),
    );
    if (alert.location) {
      const { lat, lng } = alert.location;
      const href = isIos() ? `https://maps.apple.com/?daddr=${lat},${lng}` : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
      row.append(el('a', { className: 'btn ghost', href, target: '_blank', rel: 'noopener', textContent: 'Cómo llegar' }));
    }
    card.append(row);
  } else if (mine.status === 'not_going') {
    card.append(el('button', { className: 'btn go', textContent: 'Ahora sí puedo ir', onclick: () => respond('going') }));
  }
}

function renderResponsable() {
  $('#responsable').hidden = false;
  const alert = state.alert;
  $('#launch-card').hidden = Boolean(alert);
  $('#tracking-card').hidden = !alert;
  $('#responders-card').hidden = !alert;

  const onDuty = state.volunteers.filter((v) => v.onDuty && v.id !== state.me.id);
  $('#on-duty-count').textContent = `Se avisará a ${onDuty.length} ${onDuty.length === 1 ? 'persona' : 'personas'} de guardia.`;

  if (alert) {
    $('#tracking-title').textContent = `🚨 ${alert.title}`;
    $('#tracking-meta').textContent = `${alert.address || 'Sin dirección'} · lanzada ${ago(alert.createdAt)} por ${alert.createdBy}`;
    $('#tracking-counts').replaceChildren(
      ...['going', 'arrived', 'pending', 'not_going'].map((s) =>
        el('span', { className: `chip ${s}`, textContent: `${STATUS_LABEL[s]}: ${alert.counts[s]}` }),
      ),
    );
    const order = { arrived: 0, going: 1, pending: 2, not_going: 3 };
    const responders = [...alert.responders].sort(
      (a, b) => order[a.status] - order[b.status] || (a.eta?.minutes ?? 1e9) - (b.eta?.minutes ?? 1e9),
    );
    $('#responders').replaceChildren(
      ...responders.map((r) =>
        el('li', {},
          el('div', {},
            el('div', {}, el('a', { href: `tel:${r.phone}`, textContent: r.name }), ' ', el('span', { className: `chip ${r.status}`, textContent: STATUS_LABEL[r.status] })),
            el('div', { className: 'sub', textContent: r.location ? `GPS ${ago(r.location.at)}${r.location.accuracy ? ` · ±${r.location.accuracy} m` : ''}` : r.respondedAt ? `Contestó ${ago(r.respondedAt)}` : '' }),
          ),
          el('div', { className: 'eta', textContent: r.status === 'going' ? etaText(r.eta) : '' }),
        ),
      ),
    );
  }

  $('#volunteers').replaceChildren(
    ...state.volunteers.map((v) =>
      el('li', {},
        el('div', {},
          el('div', { textContent: v.name }),
          el('div', { className: 'sub', textContent: `${v.phone}${v.hasPush ? '' : ' · sin avisos activados'}` }),
        ),
        el('span', { className: `chip ${v.onDuty ? 'going' : 'not_going'}`, textContent: v.onDuty ? 'De guardia' : 'Fuera' }),
      ),
    ),
  );

  renderMap();
}

// ---- Carga de datos --------------------------------------------------------

async function loadMe() {
  const data = await api('GET', '/api/me');
  state.me = data.user;
  state.vapidKey = data.vapidPublicKey;
  if (state.me.role === 'responsable') await loadVolunteers(false);
  setAlert(data.activeAlert);
  if (myResponse()?.status === 'pending') showAlarm(state.alert);
}

async function loadVolunteers(rerender = true) {
  if (state.me?.role !== 'responsable') return;
  state.volunteers = (await api('GET', '/api/volunteers')).volunteers;
  if (rerender) render();
}

async function enterApp() {
  $('#view-auth').hidden = true;
  $('#view-app').hidden = false;
  await loadMe();
  connectEvents();
  subscribePush(false).catch(() => renderPushStatus());
  renderPushStatus();

  // Venimos de tocar una notificación con acción "Voy"/"No puedo".
  const params = new URLSearchParams(location.search);
  const respondParam = params.get('respond');
  if (respondParam && state.alert?.id === params.get('alert')) await respond(respondParam);
  if (params.size) history.replaceState(null, '', '/');
}

function logout(callApi = true) {
  if (callApi) api('POST', '/api/logout').catch(() => {});
  localStorage.removeItem('token');
  state.token = null;
  state.me = null;
  events?.close();
  stopTracking();
  hideAlarm();
  $('#view-app').hidden = true;
  $('#view-auth').hidden = false;
}

// ---- Eventos de la interfaz -----------------------------------------------

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#form-login').hidden = tab.dataset.tab !== 'login';
    $('#form-register').hidden = tab.dataset.tab !== 'register';
    $('#auth-error').textContent = '';
  }),
);

async function handleAuth(e, url) {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const { token } = await api('POST', url, body);
    state.token = token;
    localStorage.setItem('token', token);
    $('#auth-error').textContent = '';
    await enterApp();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
}
$('#form-login').addEventListener('submit', (e) => handleAuth(e, '/api/login'));
$('#form-register').addEventListener('submit', (e) => handleAuth(e, '/api/register'));

$('#btn-logout').addEventListener('click', () => logout());

$('#btn-duty').addEventListener('click', async () => {
  try {
    const { user } = await api('POST', '/api/duty', { onDuty: !state.me.onDuty });
    state.me = user;
    if (user.onDuty && window.Notification?.permission === 'default') subscribePush(true).catch(() => {});
    await loadVolunteers(false);
    render();
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-here').addEventListener('click', () => {
  navigator.geolocation?.getCurrentPosition(
    (pos) => {
      setPicked({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      map?.setView(pickedLocation, 15);
      toast('Punto de la emergencia: tu ubicación');
    },
    (err) => toast(err.message),
    { enableHighAccuracy: true },
  );
});

$('#form-alert').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  if (!pickedLocation && !confirm('No has marcado el punto en el mapa: no se podrá calcular cuánto les falta. ¿Lanzar igualmente?')) return;
  if (!confirm(`¿Activar la emergencia "${form.title}" y hacer sonar a los voluntarios de guardia?`)) return;
  try {
    const { alert } = await api('POST', '/api/alerts', { ...form, location: pickedLocation });
    e.target.reset();
    setAlert(alert);
    toast('Emergencia enviada');
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-close-alert').addEventListener('click', async () => {
  if (!state.alert || !confirm('¿Cerrar la emergencia? Se dejará de seguir a los voluntarios.')) return;
  try {
    const { alert } = await api('POST', `/api/alerts/${state.alert.id}/close`);
    pickedLocation = null;
    pickMarker?.remove();
    pickMarker = null;
    setAlert(alert);
  } catch (err) {
    toast(err.message);
  }
});

// Refresca los "hace X min" cada 30 s.
setInterval(() => state.me && render(), 30_000);

// ---- Arranque --------------------------------------------------------------

if (state.token) {
  enterApp().catch(() => logout(false));
} else {
  $('#view-auth').hidden = false;
}
