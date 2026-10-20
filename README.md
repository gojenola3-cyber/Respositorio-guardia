# Guardia

App web (PWA) para avisar a voluntarios de guardia cuando hay una emergencia.

1. Los voluntarios se registran y se **apuntan a la guardia** con un botón.
2. Un **responsable** rellena qué pasa, marca el punto en el mapa y pulsa **ACTIVAR EMERGENCIA**.
3. A todos los apuntados les llega un aviso al móvil y, con la app abierta, **suena una sirena** a pantalla completa. Si no contestan, se les vuelve a avisar cada minuto (3 veces).
4. Cada voluntario contesta **VOY** o **NO PUEDO**.
5. Quien va comparte su GPS y el responsable ve en el mapa **dónde está y cuánto le falta** (minutos y km). El voluntario ve su propio tiempo estimado, un botón para abrir la ruta en Apple/Google Maps y otro de **He llegado**.
6. Al cerrar la emergencia se borran las posiciones guardadas.

Sin dependencias: solo Node.js ≥ 20. Los datos se guardan en `data/` (JSON).

## Arrancar en local

```bash
npm start            # http://localhost:3000
npm test
```

Al arrancar se muestra en consola el **código de responsable** (se genera solo y se guarda en `data/config.json`). Quien se registre poniendo ese código en "Soy responsable" podrá lanzar emergencias. También se puede fijar con `RESPONSABLE_CODE`.

## Variables de entorno

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `PORT` | Puerto HTTP | `3000` |
| `DATA_DIR` | Carpeta de datos (usuarios, claves push, emergencias) | `./data` |
| `RESPONSABLE_CODE` | Código para registrarse como responsable | aleatorio |
| `VAPID_SUBJECT` | Contacto para los servicios push (`mailto:...`) | `mailto:admin@example.com` |

## Ponerla en marcha de verdad

Los avisos push y el GPS **solo funcionan con HTTPS**. Opciones:

- **Servidor propio / VPS**: `docker build -t guardia . && docker run -d -p 3000:3000 -v guardia-data:/data -e RESPONSABLE_CODE=... guardia` detrás de Caddy o Nginx con certificado.
- **Render, Railway, Fly.io**: desplegar el `Dockerfile` con un **disco persistente montado en `/data`**. Sin disco persistente se pierden los usuarios y las suscripciones en cada reinicio.

No cambies las claves de `data/vapid.json` una vez en producción: invalidan todas las suscripciones y habría que volver a activar los avisos en cada móvil.

## En el móvil

- **iPhone (iOS 16.4 o superior)**: abrir la web en Safari → Compartir → **Añadir a pantalla de inicio**, abrir la app desde el icono y pulsar **Activar avisos**. Sin instalarla, iOS no deja recibir avisos.
- **Android**: abrir en Chrome, **Activar avisos** (y opcionalmente "Instalar app"). En Android la notificación trae botones Voy / No puedo.

## Limitaciones (importante)

- Con la app cerrada suena **la notificación del sistema**, no la sirena. La sirena larga solo suena con la app abierta. Una PWA **no puede saltarse el modo silencio** ni el "No molestar" del iPhone: para eso hace falta una app nativa con permiso de Alertas Críticas de Apple.
- El GPS se envía **mientras la app está abierta** (se mantiene la pantalla encendida). Si el voluntario la cierra o bloquea el móvil, su posición deja de actualizarse.
- El tiempo de llegada es una **estimación**: línea recta × 1,4 a 50 km/h de media. No es la ruta real por carretera.
- Una sola emergencia activa a la vez.
- El mapa usa Leaflet + OpenStreetMap desde internet. Si no carga, la app sigue funcionando (distancias, tiempos y respuestas).
