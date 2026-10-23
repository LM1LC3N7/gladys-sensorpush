// -----------------------------------------------------------------------------
// The SensorPush client and the HTTP layer: routes, error kinds, identity of
// the sensors, bounded answers, no prototype pollution, conversions.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { postJson, retryAfterMs, setFetch } from '../src/http.js';
import { authorize, lastSamples, listSensors, sensorKeyOf } from '../src/sensorpush.js';
import { fahrenheitToCelsius, inHgToHpa, valuesOf } from '../src/fields.js';
import {
  AUTHORIZATION,
  EMAIL,
  PASSWORD,
  SENSORS,
  TOKEN,
  installFetch,
  json,
  samples,
} from './helpers/fakes.js';

let fake;
afterEach(() => fake?.restore());

test('the sign-in: two routes, then the token', async () => {
  fake = installFetch([
    [/\/oauth\/authorize$/, () => json({ authorization: AUTHORIZATION })],
    [/\/oauth\/accesstoken$/, () => json({ accesstoken: TOKEN })],
  ]);
  assert.equal(await authorize({ email: EMAIL, password: PASSWORD }), TOKEN);
  assert.equal(fake.calls[0].url, 'https://api.sensorpush.com/api/v1/oauth/authorize');
  assert.equal(fake.calls[0].init.redirect, 'error');
  assert.match(fake.calls[0].init.headers['User-Agent'], /^gladys-sensorpush/);
});

test('the error kinds of the sign-in', async () => {
  const kind = async (status, route = 'authorize') => {
    fake?.restore();
    fake = installFetch([
      [
        /\/oauth\/authorize$/,
        () => (route === 'authorize' ? json({}, status) : json({ authorization: AUTHORIZATION })),
      ],
      [/\/oauth\/accesstoken$/, () => json({}, status)],
    ]);
    try {
      await authorize({ email: EMAIL, password: PASSWORD });
      return 'ok';
    } catch (err) {
      assert.ok(!err.message.includes(PASSWORD));
      return err.kind;
    }
  };
  assert.equal(await kind(400), 'refused');
  assert.equal(await kind(401), 'refused');
  assert.equal(await kind(403), 'refused');
  assert.equal(await kind(429), 'limited');
  assert.equal(await kind(503), 'busy');
  assert.equal(await kind(404), 'failed');
  // The access token route never says "password refused".
  assert.equal(await kind(403, 'token'), 'failed');
  assert.equal(await kind(500, 'token'), 'busy');
});

test('the sensors: ids checked, sorted, nothing personal kept; no prototype pollution', async () => {
  const body = {
    ...SENSORS,
    'bad id!': { name: 'X' },
    77.1: { active: false, name: 'Off' },
    88.1: 'not an object',
  };
  const text = JSON.stringify(body).replace('{', '{"__proto__":{"polluted":1},');
  fake = installFetch([[/\/devices\/sensors$/, () => new Response(text, { status: 200 })]]);
  const { sensors } = await listSensors(TOKEN);
  assert.deepEqual(
    sensors.map((s) => s.key),
    ['16825929-17287013094063749210', '16825930-11111111111111111111'],
  );
  assert.equal(sensors[0].name, 'Cave');
  assert.equal(sensors[0].model, 'HTP.xw');
  assert.ok(!JSON.stringify(sensors).includes('C4:7C'));
  assert.equal({}.polluted, undefined);
  assert.equal(sensorKeyOf('16825929.17287013094063749210'), '16825929-17287013094063749210');
  for (const bad of ['', '.x', 'a b', 'x'.repeat(70), 42, null]) {
    assert.equal(sensorKeyOf(bad), null, String(bad));
  }
});

test('the samples: the last one per sensor, its date read', async () => {
  const at = Date.parse('2026-10-20T17:59:00Z');
  fake = installFetch([
    [/\/samples$/, () => json(samples(at), 200, { date: 'Tue, 20 Oct 2026 18:00:00 GMT' })],
  ]);
  const answer = await lastSamples(TOKEN);
  assert.deepEqual(fake.calls[0].body, {
    limit: 1,
    measures: ['temperature', 'humidity', 'barometric_pressure', 'dewpoint', 'vpd'],
  });
  assert.equal(answer.date, Date.parse('2026-10-20T18:00:00Z'));
  const cave = answer.samples.get('16825929.17287013094063749210');
  assert.equal(cave.observed, at);
  assert.equal(fake.calls[0].init.headers.Authorization, TOKEN);
});

test('a data route refusing the token says "expired", never "refused"', async () => {
  for (const status of [400, 401, 403]) {
    fake?.restore();
    fake = installFetch([[/\/samples$/, () => json({ message: 'x' }, status)]]);
    await assert.rejects(lastSamples(TOKEN), (err) => err.kind === 'expired');
  }
  fake.restore();
  fake = installFetch([[/\/samples$/, () => json({ status: 'OK' })]]);
  await assert.rejects(lastSamples(TOKEN), (err) => err.kind === 'invalid');
});

test('an answer too large, a redirection, a timeout: a network failure naming the host only', async () => {
  const huge = 'x'.repeat(1024 * 1024 + 10);
  const previous = setFetch(async () => new Response(huge, { status: 200 }));
  try {
    await assert.rejects(
      postJson('https://api.sensorpush.com/api/v1/samples', { password: PASSWORD }),
      (err) => /answer too large on api\.sensorpush\.com$/.test(err.message),
    );
    setFetch(async () => {
      const err = new Error('redirect');
      err.cause = { code: 'ERR_REDIRECT' };
      throw err;
    });
    await assert.rejects(
      postJson('https://api.sensorpush.com/api/v1/samples', {}),
      (err) => !err.message.includes(PASSWORD) && /api\.sensorpush\.com/.test(err.message),
    );
  } finally {
    setFetch(previous);
  }
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(retryAfterMs(''), undefined);
});

test('conversions and bounds: °F to °C, inHg to hPa, out of bounds left out', () => {
  assert.equal(Math.round(fahrenheitToCelsius(212) * 10) / 10, 100);
  assert.equal(Math.round(inHgToHpa(29.92)), 1013);
  assert.deepEqual(
    valuesOf('sample', { temperature: 50, humidity: 140, barometric_pressure: 'x', vpd: null }),
    { temperature: 10 },
  );
  assert.deepEqual(valuesOf('sensor', { battery: 9, rssi: -64.4 }), { signal: -64 });
  assert.deepEqual(valuesOf('sample', Object.create({ temperature: 50 })), {});
});
