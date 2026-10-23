// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake SensorPush: the
// devices and states, the pace (never faster than the interval: test button,
// reconnection, saved configuration, restart), the state file (written at
// most once per minute, never a secret), the sign-in and its token, the
// refused password (final), pauses, late answers, stale samples.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { SensorPushApp } from '../src/app.js';
import { TICK } from '../src/constants.js';
import { memoryStorage } from '../src/store.js';
import {
  AUTHORIZATION,
  CAVE,
  EMAIL,
  PASSWORD,
  SENSORS,
  SERRE,
  TOKEN,
  createFakeTimers,
  installFetch,
  json,
  recordingLogger,
  samples,
} from './helpers/fakes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const CONFIG = { email: EMAIL, password: PASSWORD, poll_interval: 5 };

let fake;
afterEach(() => fake?.restore());

/** A storage that records the instant of each write. */
function timedStorage(clock, initial) {
  const inner = memoryStorage(initial);
  const times = [];
  return {
    times,
    load: () => inner.load(),
    save(value) {
      times.push(clock.now);
      inner.save(value);
    },
  };
}

async function setup({ config = CONFIG, storage, clock = { now: NOW } } = {}) {
  const answers = {
    authorize: () => json({ authorization: AUTHORIZATION }),
    token: () => json({ accesstoken: TOKEN }),
    sensors: () => json(SENSORS),
    samples: () => json(samples(clock.now - 60_000)),
  };
  fake = installFetch([
    [/\/oauth\/authorize$/, (c) => answers.authorize(c)],
    [/\/oauth\/accesstoken$/, (c) => answers.token(c)],
    [/\/devices\/sensors$/, (c) => answers.sensors(c)],
    [/\/samples$/, (c) => answers.samples(c)],
  ]);
  const gladys = createFakeGladys({ selector: 'sensorpush', config });
  const timers = createFakeTimers();
  const logger = recordingLogger();
  const app = new SensorPushApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    storage: storage ?? timedStorage(clock),
  });
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  return { app, gladys, timers, clock, answers, logger };
}

const calls = (pattern) => fake.calls.filter((c) => pattern.test(c.url));
const reads = () => calls(/\/samples$/).length;
const logins = () => calls(/\/oauth\/authorize$/).length;

/** Advance the clock tick by tick for `ms`, running the periodic checks. */
async function advance(ctx, ms) {
  for (let t = 0; t < ms; t += TICK) {
    ctx.clock.now += TICK;
    await ctx.timers.runIntervals();
  }
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

test('the devices of the sensors, their values in core units, the status; no secret anywhere', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  await ctx.app.start(CONFIG);
  const { gladys } = ctx;
  const ids = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(ids, [CAVE, SERRE].sort());
  const cave = gladys.fake.discoveredDevices.find((d) => d.external_id === CAVE);
  assert.equal(cave.name, 'Cave');
  assert.deepEqual(
    cave.features.map((f) => f.external_id.split(':').pop()),
    ['temperature', 'humidity', 'pressure', 'dew_point', 'vpd', 'battery_voltage', 'signal'],
  );
  assert.ok(cave.features.every((f) => f.read_only === true));
  const serre = gladys.fake.discoveredDevices.find((d) => d.external_id === SERRE);
  assert.deepEqual(
    serre.features.map((f) => f.external_id.split(':').pop()),
    ['temperature', 'humidity', 'battery_voltage', 'signal'],
  );
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${CAVE}:temperature`), 10);
  assert.equal(gladys.fake.lastState(`${CAVE}:humidity`), 81.2);
  assert.equal(gladys.fake.lastState(`${CAVE}:pressure`), 1020);
  assert.equal(gladys.fake.lastState(`${CAVE}:dew_point`), 7);
  assert.equal(gladys.fake.lastState(`${CAVE}:vpd`), 0.23);
  assert.equal(gladys.fake.lastState(`${CAVE}:battery_voltage`), 2.95);
  assert.equal(gladys.fake.lastState(`${CAVE}:signal`), -64);
  assert.equal(gladys.fake.lastState(`${SERRE}:temperature`), 20);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /2 SensorPush sensor\(s\), read every 5 min/,
  );
  // The calls: a sign-in (two routes), the samples, the list.
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(calls(/\/oauth\/authorize$/)[0].body, { email: EMAIL, password: PASSWORD });
  assert.deepEqual(calls(/\/oauth\/accesstoken$/)[0].body, { authorization: AUTHORIZATION });
  for (const call of [...calls(/\/samples$/), ...calls(/\/devices\/sensors$/)]) {
    assert.equal(call.init.headers.Authorization, TOKEN);
    assert.equal(call.init.method, 'POST');
  }
  for (const call of fake.calls) {
    assert.ok(!call.url.includes(PASSWORD) && !call.url.includes('@'), 'nothing in the URL');
  }
  const everything = JSON.stringify([
    ctx.logger.lines,
    gladys.fake.connectionStatuses,
    gladys.fake.discoveredDevices,
    storage.load(),
  ]);
  for (const secret of [PASSWORD, EMAIL, TOKEN, AUTHORIZATION, 'C4:7C:8D']) {
    assert.ok(!everything.includes(secret), secret);
  }
});

test('the test button never reads closer than the interval to the last read', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  let answer;
  for (let i = 0; i < 5; i += 1) {
    ctx.clock.now += 10_000;
    answer = await ctx.app.testConnection();
  }
  assert.equal(reads(), 1);
  assert.match(answer.en, /Cave: temperature 10 °C, humidity 81.2 %, pressure 1020 hPa/);
  assert.match(answer.fr, /Cave : température 10 °C, humidité 81,2 %/);
  assert.match(answer.en, /next read possible at 18:05 UTC/);
  assert.match(answer.fr, /prochaine lecture possible à 18:05 UTC/);
  ctx.clock.now += 5 * 60_000;
  await ctx.app.testConnection();
  assert.equal(reads(), 2, 'once the interval has passed');
});

test('the periodic reads follow the interval; a sign-in every 50 min, the list every hour', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  await advance(ctx, 60 * 60_000);
  assert.equal(reads(), 13, 'every 5 minutes: 1 + 12 in an hour');
  assert.equal(logins(), 2, 'the token is used 50 minutes at most');
  assert.equal(calls(/\/devices\/sensors$/).length, 2);
  await advance(ctx, 2 * 60 * 60_000);
  assert.equal(calls(/\/devices\/sensors$/).length, 4);
});

test('a reconnection, a saved configuration or Discovery never reads sooner', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  for (const minutes of [5, 3, 1, 10]) {
    ctx.clock.now += 5_000;
    await ctx.app.start({ ...CONFIG, poll_interval: minutes });
    await ctx.gladys.fake.scanRequest();
  }
  assert.equal(fake.calls.length, 4);
  // The status and the Discovery list are published again at each start.
  assert.ok(ctx.gladys.fake.connectionStatuses.length >= 5);
});

test('a restart 30 s after a read: no call, the Discovery and the status kept', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const first = await setup({ storage, clock });
  await first.app.start(CONFIG);
  first.app.shutdown();
  fake.restore();
  clock.now += 30_000;
  const second = await setup({ storage, clock });
  await second.app.start(CONFIG);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(
    second.gladys.fake.discoveredDevices.map((d) => d.external_id).sort(),
    [CAVE, SERRE].sort(),
  );
  const file = JSON.stringify(storage.load());
  assert.ok(!file.includes(PASSWORD) && !file.includes(EMAIL) && !file.includes(TOKEN));
  await advance(second, 5 * 60_000);
  assert.equal(reads(), 1, 'read again once the interval has passed (a new sign-in)');
  assert.equal(logins(), 1);
});

test('the instant of a request is on disk before it leaves, written at most once per minute', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const config = { ...CONFIG, poll_interval: 1 };
  const ctx = await setup({ storage, clock, config });
  const onDisk = [];
  const inner = storage.save;
  storage.save = (value) => {
    onDisk.push({ at: clock.now, attempt: value.account.lastAttemptAt });
    inner.call(storage, value);
  };
  ctx.answers.samples = () => {
    assert.equal(storage.load().account.lastAttemptAt, clock.now);
    return json(samples(clock.now - 30_000));
  };
  await ctx.app.start(config);
  await advance(ctx, 30 * 60_000);
  ctx.answers.samples = () => json({}, 503);
  await advance(ctx, 2 * 60 * 60_000);
  const attempts = onDisk.filter((w, i) => i === 0 || w.attempt !== onDisk[i - 1].attempt);
  assert.ok(attempts.length > 20);
  for (let i = 1; i < onDisk.length; i += 1) {
    if (onDisk[i].attempt !== onDisk[i - 1].attempt) {
      assert.ok(onDisk[i].at - onDisk[i - 1].at >= 60_000, `write ${i}`);
    }
  }
  const quiet = onDisk.filter((w) => w.at > NOW && w.at <= NOW + 30 * 60_000);
  assert.ok(quiet.length <= 31, `${quiet.length} writes in 30 minutes`);
});

test('a refused password is final: never tried again on its own, even after a restart', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const ctx = await setup({ storage, clock });
  ctx.answers.authorize = () => json({ message: 'invalid user' }, 403);
  await ctx.app.start(CONFIG);
  assert.equal(logins(), 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /refused the e-mail or the password/);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /a refusé l'e-mail ou le mot de passe/);
  await advance(ctx, 24 * 60 * 60_000);
  assert.equal(fake.calls.length, 1, 'no sign-in in 24 hours');
  const saved = storage.load().account;
  assert.equal(saved.refused, true);
  assert.match(saved.fp, /^[0-9a-f]{32}$/);
  // A restart with the same password: no call.
  ctx.app.shutdown();
  fake.restore();
  const again = await setup({ storage, clock });
  again.answers.authorize = () => json({ message: 'invalid user' }, 403);
  await again.app.start(CONFIG);
  await advance(again, 60 * 60_000);
  assert.equal(fake.calls.length, 0);
  assert.equal(again.gladys.fake.connectionStatus.connected, false);
  // The test button tries once (the interval has passed); refused again, it stays.
  const answer = await again.app.testConnection();
  assert.equal(logins(), 1);
  assert.match(answer.en, /e-mail or password refused/);
  await advance(again, 60 * 60_000);
  assert.equal(logins(), 1);
  // The right password: tried at once (once a write is allowed), the fingerprint erased.
  again.answers.authorize = () => json({ authorization: AUTHORIZATION });
  await again.app.start({ ...CONFIG, password: 'the right one' });
  await advance(again, 60_000);
  assert.equal(reads(), 1);
  assert.equal(storage.load().account.refused, false);
  assert.equal(storage.load().account.fp, '');
  assert.ok(!JSON.stringify(storage.load()).includes('the right one'));
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
});

test('a refused password is not tried again after the e-mail is cleared then typed again', async () => {
  const ctx = await setup();
  ctx.answers.authorize = () => json({}, 400);
  await ctx.app.start(CONFIG);
  ctx.clock.now += 120_000;
  await ctx.app.start({ ...CONFIG, email: '' });
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Both are needed/);
  ctx.clock.now += 60_000;
  await ctx.app.start(CONFIG);
  await advance(ctx, 60 * 60_000);
  assert.equal(logins(), 1);
});

test('a 429 pauses the reads, also across a restart; Retry-After is kept', async () => {
  const clock = { now: NOW };
  const storage = timedStorage(clock);
  const first = await setup({ storage, clock });
  first.answers.samples = () => json({}, 429, { 'retry-after': '1800' });
  await first.app.start(CONFIG);
  assert.equal(reads(), 1);
  await advance(first, 2 * 60_000);
  first.app.shutdown();
  fake.restore();
  const second = await setup({ storage, clock });
  await second.app.start(CONFIG);
  await advance(second, 26 * 60_000);
  assert.equal(fake.calls.length, 0, 'the 30 minute pause holds after the restart');
  await advance(second, 3 * 60_000);
  assert.equal(reads(), 1);
});

test('a 429 on the sign-in pauses too, and is never taken as a refused password', async () => {
  const ctx = await setup();
  ctx.answers.authorize = () => json({}, 429);
  await ctx.app.start(CONFIG);
  assert.equal(ctx.app.store.get().refused, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /too many requests/);
  await advance(ctx, 4 * 60_000);
  assert.equal(logins(), 1, 'paused for 5 minutes');
  await advance(ctx, 2 * 60_000);
  assert.equal(logins(), 2);
});

test('a token refused by a data route: one new sign-in, then the error is kept (no loop)', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  assert.equal(logins(), 1);
  // The token expires early: one new sign-in, the samples asked again.
  let refuse = 1;
  ctx.answers.samples = () =>
    refuse-- > 0 ? json({ message: 'expired' }, 401) : json(samples(ctx.clock.now));
  await advance(ctx, 5 * 60_000);
  assert.equal(logins(), 2);
  assert.equal(reads(), 3);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  // Refused every time: one new sign-in per read, never more.
  ctx.answers.samples = () => json({ message: 'denied' }, 403);
  await advance(ctx, 5 * 60_000);
  assert.equal(logins(), 3);
  assert.equal(reads(), 5);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /data refused even with a new sign-in/);
  assert.equal(ctx.app.store.get().refused, false, 'the password is not taken as refused');
});

test('a reconnection during a read: no second read, the late answer publishes nothing', async () => {
  const ctx = await setup();
  let release;
  ctx.answers.samples = () =>
    new Promise((resolve) => {
      release = () => resolve(json(samples(NOW, { temperature: 99 })));
    });
  const starting = ctx.app.start(CONFIG);
  await new Promise((r) => setTimeout(r, 20));
  ctx.app.stop();
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  release();
  await starting;
  assert.equal(ctx.gladys.fake.connectionStatuses.length, statuses, 'no status from the old read');
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 0, 'nothing published');
  ctx.answers.samples = () => json(samples(NOW));
  await ctx.app.start(CONFIG);
  assert.equal(reads(), 1, 'the next read waits for the interval');
});

test('the sensor list failing at its refresh never stops the samples', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  ctx.answers.sensors = () => json({}, 502);
  await advance(ctx, 60 * 60_000);
  const lists = calls(/\/devices\/sensors$/).length;
  const before = reads();
  await advance(ctx, 25 * 60_000);
  assert.equal(calls(/\/devices\/sensors$/).length, lists, 'tried again in 30 minutes');
  assert.equal(reads(), before + 5);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('5xx on the samples: a pause of 5 minutes, then 10, then 20', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  ctx.answers.samples = () => json({}, 500);
  const before = reads();
  await advance(ctx, 5 * 60_000);
  assert.equal(reads(), before + 1);
  await advance(ctx, 5 * 60_000);
  assert.equal(reads(), before + 2);
  await advance(ctx, 9 * 60_000);
  assert.equal(reads(), before + 2, 'paused for 10 minutes');
  await advance(ctx, 60_000);
  assert.equal(reads(), before + 3);
});

test('a sample too old is never published; the same sample is never sent again as new', async () => {
  const ctx = await setup();
  ctx.answers.samples = () => json(samples(NOW - 2 * 3600_000));
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${CAVE}:temperature`), undefined);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /Cave \(no recent reading\)/);
  // A sensor that stops reporting: its last sample is handed to Gladys once.
  ctx.answers.samples = () => json(samples(NOW + 4 * 60_000));
  const sent = [];
  const publish = ctx.gladys.publishChangedStates.bind(ctx.gladys);
  ctx.gladys.publishChangedStates = async (batch, options) => {
    sent.push(...batch.filter((s) => s.device_feature_external_id === `${CAVE}:temperature`));
    return publish(batch, options);
  };
  await advance(ctx, 50 * 60_000);
  assert.equal(sent.length, 1);
});

test('the server clock dates the samples: a skewed Gladys clock never makes them stale', async () => {
  const ctx = await setup();
  // The server is 3 hours ahead of Gladys; the sample is 1 minute old for it.
  const server = NOW + 3 * 3600_000;
  ctx.answers.samples = () =>
    json(samples(server - 60_000), 200, { date: new Date(server).toUTCString() });
  await ctx.app.start(CONFIG);
  await createAll(ctx.gladys);
  assert.equal(ctx.gladys.fake.lastState(`${CAVE}:temperature`), 10);
});

test('a new sensor in the samples: the list is read again, at most every 30 minutes', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  const lists = () => calls(/\/devices\/sensors$/).length;
  assert.equal(lists(), 1);
  const extra = { 99.1: [{ observed: new Date(NOW).toISOString(), temperature: 70 }] };
  ctx.answers.samples = () => json(samples(ctx.clock.now, { extra }));
  await advance(ctx, 25 * 60_000);
  assert.equal(lists(), 1, 'not before 30 minutes');
  await advance(ctx, 5 * 60_000);
  assert.equal(lists(), 2);
  await advance(ctx, 25 * 60_000);
  assert.equal(lists(), 2, 'still unknown: 30 minutes again');
  ctx.answers.sensors = () =>
    json({ ...SENSORS, 99.1: { id: '99.1', name: 'Frigo', battery_voltage: 3, rssi: -50 } });
  await advance(ctx, 5 * 60_000);
  assert.equal(lists(), 3);
  assert.ok(ctx.gladys.fake.discoveredDevices.some((d) => d.name === 'Frigo'));
});

test('other credentials drop the token; their late answer is ignored', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  ctx.clock.now += 61_000;
  await ctx.app.start({ ...CONFIG, password: 'another one' });
  assert.equal(logins(), 2, 'new credentials: a new sign-in at once');
  assert.deepEqual(calls(/\/oauth\/authorize$/)[1].body, {
    email: EMAIL,
    password: 'another one',
  });
});

test('the configuration messages; an invalid e-mail or password is never sent', async () => {
  const ctx = await setup({ config: {} });
  await ctx.app.start({});
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /e-mail address and the password/);
  await ctx.app.start({ email: EMAIL });
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /Les deux sont nécessaires/);
  for (const bad of [
    { email: 'not-an-address', password: PASSWORD },
    { email: EMAIL, password: `${PASSWORD}\n` },
  ]) {
    await ctx.app.start(bad);
    assert.match(ctx.gladys.fake.connectionStatus.message.en, /not valid/);
  }
  await advance(ctx, 30 * 60_000);
  assert.equal(fake.calls.length, 0);
  const answer = await ctx.app.testConnection();
  assert.match(answer.fr, /non valide/);
});

test('the state budget: at most 250 states a minute', async () => {
  const ctx = await setup();
  await ctx.app.start(CONFIG);
  const sent = [];
  ctx.gladys.publishChangedStates = async (batch) => {
    sent.push(batch.length);
    return { count: batch.length };
  };
  for (let i = 0; i < 400; i += 1) {
    ctx.app.backlog.set(`f${i}`, { device_feature_external_id: `f${i}`, state: i });
  }
  await Promise.all([ctx.app.flushStates(), ctx.app.flushStates()]);
  assert.deepEqual(sent, [250]);
  ctx.clock.now += 61_000;
  await ctx.app.flushStates();
  assert.deepEqual(sent, [250, 150]);
});

test('a password refused while a reconnection happens is kept refused', async () => {
  const ctx = await setup();
  let release;
  ctx.answers.authorize = () =>
    new Promise((resolve) => {
      release = () => resolve(json({ message: 'invalid user' }, 403));
    });
  const starting = ctx.app.start(CONFIG);
  await new Promise((r) => setTimeout(r, 20));
  ctx.app.stop();
  release();
  await starting;
  assert.equal(ctx.app.store.get().refused, true);
  await ctx.app.start(CONFIG);
  await advance(ctx, 60 * 60_000);
  assert.equal(logins(), 1);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
});
