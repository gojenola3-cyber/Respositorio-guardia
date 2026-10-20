// Notificaciones Web Push (RFC 8030) con cifrado aes128gcm (RFC 8291) y
// autenticación VAPID (RFC 8292), implementadas con node:crypto para no
// depender de paquetes externos.
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (str) => Buffer.from(str, 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function loadOrCreateVapidKeys(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const keys = {
    privateJwk: jwk,
    // Clave pública "raw" sin comprimir (0x04 || X || Y) que pide el navegador.
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])),
  };
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(
    JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }),
  );
  const unsigned = `${header}.${claims}`;
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

// Cifra el mensaje para una suscripción concreta (un único registro).
export function encryptPayload(subscription, payload) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);

  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(hmac(authSecret, sharedSecret), Buffer.concat([keyInfo, Buffer.from([1])]));

  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marca el último (y único) registro.
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// Devuelve el código HTTP del servicio push. 404/410 = suscripción caducada.
export async function sendPush(subscription, data, { keys, subject, ttl = 600 }) {
  const body = encryptPayload(subscription, JSON.stringify(data));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
      Authorization: vapidHeader(subscription.endpoint, keys, subject),
    },
    body,
  });
  return res.status;
}
