// -----------------------------------------------------------------------------
// What a SensorPush sensor measures, and how it lands in Gladys. Pure: no
// clock, no network.
//
// The field names are those of the SensorPush API (`Sample` and `Sensor` of
// the official swagger, as sensorpush-api and sensorpush-ha read them). The
// API sends imperial values (°F, inHg): they are converted here, once, to the
// units the Gladys core lists for each category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js).
//
// One Gladys device per sensor. The feature key is a name of this
// integration (`temperature`, `dew_point`...), never a SensorPush field name:
// it is part of the external id, so it never changes.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE } from './constants.js';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A finite number, or null (never NaN, never undefined). */
export const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** An own field of a record as a number (never a field of its prototype). */
const own = (record, key) =>
  record && typeof record === 'object' && Object.hasOwn(record, key) ? num(record[key]) : null;

const map = (value, fn) => (value === null ? null : fn(value));

export const fahrenheitToCelsius = (f) => ((f - 32) * 5) / 9;
export const inHgToHpa = (inHg) => inHg * 33.8639;

// --- Kinds: Gladys category, type, unit, bounds, rounding ---------------------------
// Only the units the core lists for the category. The core lists no unit
// for a battery voltage nor a radio signal in dB: `unknown` sensors, the unit
// in their name (as the approved Robonect module does for its Wi-Fi signal).

const KINDS = {
  temperature: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -60,
    max: 100,
    convert: (v) => round(v, 1),
  },
  // The dew point is not the temperature of a room: a `probe`, kept out of the
  // room temperature average of Gladys.
  dewPoint: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.TEMPERATURE_SENSOR.PROBE,
    unit: UNITS.CELSIUS,
    min: -80,
    max: 80,
    convert: (v) => round(v, 1),
  },
  humidity: {
    category: CAT.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (v) => round(v, 1),
  },
  pressure: {
    category: CAT.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.HECTO_PASCAL,
    min: 300,
    max: 1100,
    convert: (v) => round(v, 1),
  },
  vpd: {
    category: CAT.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.KILO_PASCAL,
    min: 0,
    max: 20,
    convert: (v) => round(v, 2),
  },
  voltage: {
    category: CAT.UNKNOWN,
    type: TYPES.SENSOR.DECIMAL,
    min: 0,
    max: 5,
    convert: (v) => round(v, 2),
  },
  signal: {
    category: CAT.UNKNOWN,
    type: TYPES.SENSOR.INTEGER,
    min: -150,
    max: 0,
    convert: (v) => Math.round(v),
  },
};

/**
 * [feature key, kind, feature name, source, read(data)]: the order of the
 * features in Gladys. `source`: `sample` (POST /samples, dated by its
 * `observed`) or `sensor` (POST /devices/sensors, the battery and the signal
 * at the last contact).
 */
export const TABLE = [
  [
    'temperature',
    'temperature',
    'Temperature',
    'sample',
    (d) => map(own(d, 'temperature'), fahrenheitToCelsius),
  ],
  ['humidity', 'humidity', 'Humidity', 'sample', (d) => own(d, 'humidity')],
  [
    'pressure',
    'pressure',
    'Pressure',
    'sample',
    (d) => map(own(d, 'barometric_pressure'), inHgToHpa),
  ],
  [
    'dew_point',
    'dewPoint',
    'Dew point',
    'sample',
    (d) => map(own(d, 'dewpoint'), fahrenheitToCelsius),
  ],
  ['vpd', 'vpd', 'Vapour pressure deficit', 'sample', (d) => own(d, 'vpd')],
  ['battery_voltage', 'voltage', 'Battery voltage (V)', 'sensor', (d) => own(d, 'battery')],
  ['signal', 'signal', 'Signal (dB)', 'sensor', (d) => own(d, 'rssi')],
];

const KEYS = new Set(TABLE.map(([key]) => key));

/** Every feature key (the fields kept under /data are checked against it). */
export const featureKeys = () => new Set(KEYS);

/**
 * The usable values of a source for a record: converted, rounded, within
 * the bounds. A value out of the bounds is left out, never clamped into a
 * false reading.
 */
export function valuesOf(source, record) {
  const values = {};
  for (const [key, kindName, , from, read] of TABLE) {
    if (from !== source) {
      continue;
    }
    const raw = read(record);
    if (raw === null || !Number.isFinite(raw)) {
      continue;
    }
    const kind = KINDS[kindName];
    const value = kind.convert(raw);
    if (Number.isFinite(value) && value >= kind.min && value <= kind.max) {
      values[key] = value;
    }
  }
  return values;
}

// --- Gladys devices and states ------------------------------------------------------

const idsOf = (gladys, sensorKey) => gladys.externalIds(DEVICE_TYPE, sensorKey);

/** The features of a device as the user created it (gladys.devices). */
export function createdFeatures(gladys, sensorKey) {
  const ids = idsOf(gladys, sensorKey);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  return device?.features ?? [];
}

const featureOf = (ids, key, kindName, name) => {
  const kind = KINDS[kindName];
  return {
    name,
    external_id: ids.feature(key),
    category: kind.category,
    type: kind.type,
    ...(kind.unit ? { unit: kind.unit } : {}),
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

/**
 * The Gladys device of a sensor: every feature it has ever given, plus every
 * feature of the device already created (so a measure missing for a while,
 * or a field this version no longer knows, never removes a feature: the core
 * would mark the device as changed and "Update" would drop its history).
 */
export function deviceOf(gladys, { sensorKey, name, fields }) {
  const ids = idsOf(gladys, sensorKey);
  const created = createdFeatures(gladys, sensorKey);
  const createdIds = new Set(created.map((f) => f.external_id));
  const features = TABLE.filter(([key]) => fields.has(key) || createdIds.has(ids.feature(key))).map(
    ([key, kindName, featureName]) => featureOf(ids, key, kindName, featureName),
  );
  const prefix = `${ids.device}:`;
  for (const feature of created) {
    const key = String(feature.external_id ?? '').startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : '';
    if (key && !KEYS.has(key)) {
      features.push({
        name: feature.name,
        external_id: feature.external_id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name,
    external_id: ids.device,
    // The integration reads SensorPush at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features,
  };
}

/** The states of the values of a sensor, for the publishStates format. */
export function statesOf(gladys, { sensorKey, values }) {
  const ids = idsOf(gladys, sensorKey);
  return TABLE.filter(([key]) => num(values?.[key]) !== null).map(([key]) => ({
    device_feature_external_id: ids.feature(key),
    state: values[key],
  }));
}
