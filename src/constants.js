// -----------------------------------------------------------------------------
// Endpoints, limits, pacing and the keys users store (manifest keys, device
// types): the keys are forever, never rename them.
// -----------------------------------------------------------------------------

/** The official SensorPush Gateway Cloud API (api.sensorpush.com/api/v1). */
export const API_URL = 'https://api.sensorpush.com/api/v1';

export const USER_AGENT = 'gladys-sensorpush (+https://github.com/LM1LC3N7/gladys-sensorpush)';

/** One HTTP call. */
export const HTTP_TIMEOUT = 15_000;

/** The most an answer may weigh (a few KB per sensor). */
export const MAX_BODY = 1024 * 1024;

/** At most this many sensors of the account are published. */
export const MAX_SENSORS = 50;

/** At most this many entries of an answer are looked at. */
export const MAX_ENTRIES = 1000;

/** The list of the sensors (names, battery, signal) is read again this often. */
export const SENSORS_REFRESH = 60 * 60_000;

/** A refresh of the list that failed (sensors known): tried again after this. */
export const SENSORS_RETRY = 30 * 60_000;

/**
 * An access token is valid one hour (sensorpush-ha): it is used for 50
 * minutes at most, then a new one is asked for, in the read that needs it.
 * There is no refresh token: a new token means the e-mail and password again.
 */
export const TOKEN_LIFETIME = 50 * 60_000;

/** How often the integration checks what is due. */
export const TICK = 15_000;

/**
 * The state file under /data is written at most once per minute (flash
 * memory, restart loops): a read waits for that too.
 */
export const WRITE_GAP = 60_000;

/**
 * 429 / 5xx: a pause, from Retry-After when given, else 5 minutes doubling;
 * always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;

/** A reading older than this (or than 2 intervals) is not published as current. */
export const STALE = 60 * 60_000;

/** An unchanged value is re-sent this often, so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;

/** The core accepts 300 states per minute: the integration keeps a margin. */
export const STATES_PER_MINUTE = 250;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 100_000;

/** Where the pace, the pauses and the refusal survive a restart. */
export const STATE_FILE = '/data/sensorpush-state.json';

/** Device type of the external ids (`ext:sensorpush:sensor:<sensor id>`). */
export const DEVICE_TYPE = 'sensor';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};
