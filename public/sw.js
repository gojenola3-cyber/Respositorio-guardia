// Service worker: recibe los avisos push y muestra la notificación de alarma.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Guardia', body: '' };
  const isAlert = data.type === 'alert';
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.alertId || 'test',
        renotify: true,
        requireInteraction: isAlert,
        vibrate: isAlert ? [800, 300, 800, 300, 800, 300, 800] : [200],
        data,
        actions: isAlert
          ? [
              { action: 'going', title: '✅ Voy' },
              { action: 'not_going', title: '❌ No puedo' },
            ]
          : [],
      });
      // Si la app está abierta, que suene la sirena dentro de ella.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) c.postMessage(data);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const params = new URLSearchParams();
  if (data.alertId) params.set('alert', data.alertId);
  if (event.action) params.set('respond', event.action);
  const url = `/${params.size ? `?${params}` : ''}`;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        await existing.navigate(url);
        return existing.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
