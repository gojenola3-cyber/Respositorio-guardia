import assert from 'node:assert/strict';
import test from 'node:test';

import { estimate, haversineKm } from '../server/geo.js';

test('distancia Lekeitio - Gernika ~ 20 km en línea recta', () => {
  const km = haversineKm({ lat: 43.3606, lng: -2.5057 }, { lat: 43.3167, lng: -2.6786 });
  assert.ok(km > 13 && km < 16, `km=${km}`);
});

test('estimación de llegada', () => {
  const eta = estimate({ lat: 43.3606, lng: -2.5057 }, { lat: 43.3167, lng: -2.6786 });
  assert.ok(eta.minutes >= 20 && eta.minutes <= 30, JSON.stringify(eta));
  assert.equal(estimate(null, { lat: 0, lng: 0 }), null);
  assert.equal(estimate({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }).minutes, 1);
});
