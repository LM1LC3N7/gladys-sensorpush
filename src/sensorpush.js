// -----------------------------------------------------------------------------
// The SensorPush Gateway Cloud API, read only, and its error kinds. Ported
// from sensorpush-api / sensorpush-ha (BSD-2-Clause, Steven Stallion):
//
//   POST /oauth/authorize    { email, password }  -> { authorization }
//   POST /oauth/accesstoken  { authorization }    -> { accesstoken }
//   POST /devices/sensors    {}                   -> { <sensor id>: Sensor }
//   POST /samples            { limit: 1, ... }    -> { sensors: { <id>: [Sample] } }
//
// The access token travels in the `Authorization` header, as is (no
// "Bearer"), the way the official swagger describes it. There is no refresh
// token: a new token means the e-mail and the password again.
//
// Only these routes exist here: nothing is ever written to a sensor, a
// gateway nor the account (no tags, no reports).
// -----------------------------------------------------------------------------

import { API_URL, MAX_ENTRIES } from './constants.js';
import { NetworkError, postJson } from './http.js';

/**
 * kind: refused (the e-mail or the password, on /oauth/authorize), expired
 * (a data route refused the token), limited (429), busy (5xx), invalid (not a
 * SensorPush answer), failed (network, another status).
 */
export class SourceError extends Error {
  constructor(kind, detail = '', { retryAfterMs, status } = {}) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = 'SourceError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('invalid', 'not JSON');
  }
}

/**
 * An HTTP status that is not 2xx -> its SourceError. `route`: `login`
 * (400/401/403 = the e-mail or the password refused), `token` (any other
 * 4xx: passing), `data` (400/401/403 = the token refused).
 */
function statusError({ status, retryAfterMs }, route) {
  if (status === 429) {
    return new SourceError('limited', 'HTTP 429', { retryAfterMs, status });
  }
  if (status >= 500) {
    return new SourceError('busy', `HTTP ${status}`, { retryAfterMs, status });
  }
  if (status === 400 || status === 401 || status === 403) {
    if (route === 'login') {
      return new SourceError('refused', `HTTP ${status}`, { status });
    }
    if (route === 'data') {
      return new SourceError('expired', `HTTP ${status}`, { status });
    }
  }
  return new SourceError('failed', `HTTP ${status}`, { status });
}

async function post(path, payload, route, headers = {}) {
  let response;
  try {
    response = await postJson(`${API_URL}${path}`, payload, { headers });
  } catch (err) {
    throw new SourceError('failed', err instanceof NetworkError ? err.message : 'network failed');
  }
  if (response.status < 200 || response.status > 299) {
    throw statusError(response, route);
  }
  return { body: parseJson(response.text), date: response.date };
}

/** A token or an authorization code: printable ASCII, bounded. */
const tokenOf = (value) =>
  typeof value === 'string' && value.length >= 8 && value.length <= 8192 && /^[!-~]+$/.test(value)
    ? value
    : null;

/** Sign in: the e-mail and the password -> an access token (valid one hour). */
export async function authorize({ email, password }) {
  const { body: auth } = await post('/oauth/authorize', { email, password }, 'login');
  const authorization = isObject(auth) ? tokenOf(auth.authorization) : null;
  if (!authorization) {
    throw new SourceError('invalid', 'no authorization');
  }
  const { body } = await post('/oauth/accesstoken', { authorization }, 'token');
  const token = isObject(body) ? tokenOf(body.accesstoken) : null;
  if (!token) {
    throw new SourceError('invalid', 'no access token');
  }
  return token;
}

/**
 * A sensor id of the API ("16825929.17287013094063749210") -> the platform
 * id of its Gladys device: lowercase, every character other than a letter
 * or a digit replaced by "-" ("16825929-17287013094063749210"). Null when the
 * id is missing or does not look like one (never taken as another sensor).
 */
export const sensorKeyOf = (value) => {
  if (typeof value !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(value)) {
    return null;
  }
  return value.toLowerCase().replace(/[^a-z0-9]/g, '-');
};

const finiteOrNull = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** An own field of an object (never a field of its prototype). */
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * The sensors of the account: { sensors: [{ id, key, name, model, battery,
 * rssi }], date }, sorted by key. `id` is the id of the API (to match the
 * samples), `key` the platform id. The MAC address, the alerts and the
 * calibration are not kept.
 */
export async function listSensors(token) {
  const { body, date } = await post('/devices/sensors', {}, 'data', { Authorization: token });
  if (!isObject(body)) {
    throw new SourceError('invalid', 'no sensor list');
  }
  const seen = new Set();
  const sensors = [];
  for (const id of Object.keys(body).slice(0, MAX_ENTRIES)) {
    const raw = body[id];
    const key = sensorKeyOf(id);
    if (!key || !isObject(raw) || seen.has(key) || own(raw, 'active') === false) {
      continue;
    }
    seen.add(key);
    sensors.push({
      id,
      key,
      name: cleanText(own(raw, 'name'), 60) || `SensorPush ${id}`,
      model: cleanText(own(raw, 'type'), 30),
      battery: finiteOrNull(own(raw, 'battery_voltage')),
      rssi: finiteOrNull(own(raw, 'rssi')),
    });
  }
  sensors.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { sensors, date };
}

/** The measures asked for (the API leaves out those a sensor does not have). */
export const MEASURES = ['temperature', 'humidity', 'barometric_pressure', 'dewpoint', 'vpd'];

/**
 * The last sample of every sensor: { samples: Map(api id -> { observed,
 * data }), date }. `observed` in ms (null when unreadable: such a sample is
 * never published), `data` the raw sample (read by fields.js).
 */
export async function lastSamples(token) {
  const { body, date } = await post('/samples', { limit: 1, measures: MEASURES }, 'data', {
    Authorization: token,
  });
  const sensors = own(body, 'sensors');
  if (!isObject(sensors)) {
    throw new SourceError('invalid', 'no samples');
  }
  const samples = new Map();
  for (const id of Object.keys(sensors).slice(0, MAX_ENTRIES)) {
    const list = sensors[id];
    if (!Array.isArray(list) || !isObject(list[0])) {
      continue;
    }
    const data = list[0];
    const observed = Date.parse(typeof own(data, 'observed') === 'string' ? data.observed : '');
    samples.set(id, { observed: Number.isFinite(observed) ? observed : null, data });
  }
  return { samples, date };
}
