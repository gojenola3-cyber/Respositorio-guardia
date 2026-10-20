import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { encryptPayload } from '../server/push.js';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Descifra como lo hace el navegador (lado "user agent" de RFC 8291).
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const uaPublic = uaEcdh.getPublicKey();
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'debe acabar con el delimitador de último registro');
  return plain.subarray(0, -1).toString();
}

test('el mensaje push se descifra con las claves del navegador', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const subscription = {
    endpoint: 'https://push.example.com/abc',
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  const payload = JSON.stringify({ type: 'alert', title: '🚨 Rescate' });
  const body = encryptPayload(subscription, payload);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(decrypt(body, ua, auth), payload);
});
