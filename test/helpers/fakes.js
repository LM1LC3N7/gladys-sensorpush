// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL), SensorPush answers (after the official
// swagger, as sensorpush-api models them) and timers (nothing fires by
// itself). No test touches the network nor the disk.
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const EMAIL = 'owner@example.com';
export const PASSWORD = 'Very-Private-Password-42';
export const AUTHORIZATION = 'auth-code-0123456789abcdef';
export const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.token-0123456789';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** POST /devices/sensors. */
export const SENSORS = {
  '16825929.17287013094063749210': {
    active: true,
    address: 'C4:7C:8D:6A:1B:2C',
    alerts: { temperature: { enabled: false } },
    battery_voltage: 2.95,
    calibration: { humidity: 0, temperature: 0 },
    deviceId: '16825929',
    id: '16825929.17287013094063749210',
    name: 'Cave',
    rssi: -64,
    type: 'HTP.xw',
  },
  '16825930.11111111111111111111': {
    active: true,
    battery_voltage: 3.01,
    id: '16825930.11111111111111111111',
    name: 'Serre',
    rssi: -71,
    type: 'HT1',
  },
};

export const CAVE = 'ext:sensorpush:sensor:16825929-17287013094063749210';
export const SERRE = 'ext:sensorpush:sensor:16825930-11111111111111111111';

/** POST /samples, observed at `ms`. */
export const samples = (ms, { temperature = 50, extra = {} } = {}) => {
  const observed = new Date(ms).toISOString();
  return {
    last_time: observed,
    sensors: {
      '16825929.17287013094063749210': [
        {
          observed,
          temperature,
          humidity: 81.2,
          barometric_pressure: 30.12,
          dewpoint: 44.6,
          vpd: 0.23,
          altitude: 120,
        },
      ],
      '16825930.11111111111111111111': [{ observed, temperature: 68, humidity: 55 }],
      ...extra,
    },
    status: 'OK',
    total_samples: 2,
    total_sensors: 2,
    truncated: false,
  };
};

/** Install a fake fetch; `routes` is a list of [RegExp, handler(call)]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
  };
}

/** A logger that keeps every line, to check that no secret reaches it. */
export function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => String(a?.message ?? a)).join(' ')}`);
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}
