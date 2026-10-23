// -----------------------------------------------------------------------------
// The integration itself: the SensorPush account to read, when it is due,
// the sign-in and its token, the pauses and the refusal, the Gladys devices
// and states built from the readings, the connection status and the test
// button. index.js only wires the SDK handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasAccount, normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  FUTURE_TOLERANCE,
  HEALTH_STALE,
  HEARTBEAT,
  MAX_SENSORS,
  RECENT_MARGIN,
  RECENT_MIN,
  SENSORS_REFRESH,
  SENSORS_RETRY,
  STALE,
  STATES_PER_MINUTE,
  TEST_DEADLINE,
  TICK,
  TOKEN_LIFETIME,
} from './constants.js';
import { deviceOf, statesOf, valuesOf } from './fields.js';
import { T, reason } from './i18n.js';
import { AccountStore, memoryStorage } from './store.js';
import { SourceError, authorize, lastSamples, listSensors } from './sensorpush.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };
const defaultClient = { authorize, listSensors, lastSamples };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 12.54 -> "12.5", "12,5" in French. */
const numberText = (value, lang) => {
  const text = String(Math.round(value * 10) / 10);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const asSourceError = (err) => (err instanceof SourceError ? err : new SourceError('failed'));

const newSensor = ({ key, id, name, model = '', fields = [], observed = 0 }) => ({
  key,
  id,
  name,
  model,
  /** Every feature key ever read. */
  fields: new Set(fields),
  /** { values, observed, age, readAt } of the last sample (see applySamples). */
  sample: null,
  /** The battery and the signal, from the last sensor list (sent with a sample). */
  health: {},
  /** The raw `observed` of the last sample handed to Gladys (kept under /data). */
  publishedObserved: observed,
});

export class SensorPushApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'sensorpush' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
    client = defaultClient,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.client = client;
    this.config = normalizeConfig();
    // The pace, the pauses and the refusal live as long as the process,
    // across restarts of the app and reconnections to Gladys, and in /data
    // across restarts of the container.
    this.store = new AccountStore({ storage, now, timers, maxPause: BUSY_MAX });
    /** `e-mail\npassword` when the account is configured, else ''. */
    this.secret = '';
    /** The access token, in memory only: { value, at, secret }. */
    this.token = null;
    /** The error of the account (refused, limited, busy...), or undefined. */
    this.error = undefined;
    /** sensor key -> sensor */
    this.sensors = new Map();
    /** Sensors of the account left out (beyond MAX_SENSORS). */
    this.more = 0;
    /** The sensor list is not read again before this (in memory). */
    this.listRetryAt = 0;
    /** feature external id -> the instant of the reading last handed to Gladys. */
    this.pushed = new Map();
    this.interval = undefined;
    this.ticking = undefined;
    this.chain = Promise.resolve();
    /** States waiting for room in the per-minute budget: feature id -> state. */
    this.backlog = new Map();
    /** [instant, count] of the states sent in the last minute. */
    this.sentLog = [];
    this.flushTimer = undefined;
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.secret = hasAccount(this.config) ? `${this.config.email}\n${this.config.password}` : '';
    if (this.token && this.token.secret !== this.secret) {
      this.token = null;
    }
    if (this.secret) {
      // Other credentials drop the refusal and the instant of the last
      // request: they are tried at once. Anything else (a reconnection to
      // Gladys, a restart of the container, a new interval) keeps the pace:
      // the next read is never before the last request + the interval.
      const { entry: saved, changed } = this.store.restore(this.secret);
      if (changed) {
        this.error = undefined;
        this.listRetryAt = 0;
      }
      if (this.sensors.size === 0) {
        // After a restart: the sensors known before (ids, names, fields,
        // nothing secret) keep the Discovery list filled until the next read.
        for (const sensor of saved.sensors) {
          this.sensors.set(sensor.key, newSensor(sensor));
        }
      }
      // After a restart, the status says at once that the password is
      // refused or the reads paused, without asking SensorPush.
      if (saved.refused) {
        this.error = saved.refusal === 'data' ? 'denied' : 'refused';
      } else if (!this.error && saved.pausedUntil > this.now()) {
        this.error = 'busy';
      }
    }
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again even when nothing changed.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  /** The container stops: the state file is written if allowed, the timers dropped. */
  shutdown() {
    this.stop();
    // A clean stop happens once per restart: what waits (the last published
    // `observed`) is written even before the one-minute gap.
    this.store.flush({ force: true });
    this.store.close();
  }

  /** An error message without the e-mail, the password nor the token. */
  scrub(err) {
    let message = String(err?.message ?? err);
    for (const secret of [this.config.password, this.config.email, this.token?.value]) {
      if (secret && secret.length >= 4) {
        message = message.split(secret).join('***');
      }
    }
    return message;
  }

  /** Run `fn` after every read already queued: never two reads at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Pace ---------------------------------------------------------------------------

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  /**
   * A sample this recent is published as current (without a date): the
   * interval plus a margin, 10 minutes at least, never past STALE. Older,
   * up to STALE (1 hour), it is published dated (`created_at`), which fires
   * no scene; older than that, never.
   */
  recentMs() {
    return Math.min(STALE, Math.max(RECENT_MIN, this.intervalMs() + RECENT_MARGIN));
  }

  /**
   * The earliest read: the interval and a pause are always kept; a refusal
   * (the password, or the data refused right after a sign-in) is never tried
   * again by a periodic read (only the test button, or other credentials).
   */
  earliest({ manual = false } = {}) {
    const saved = this.store.get();
    if (saved.refused && !manual) {
      return Infinity;
    }
    return Math.max(saved.lastAttemptAt + this.intervalMs(), saved.pausedUntil);
  }

  /** When the next read can happen (shown by the test button). */
  nextRead() {
    return Math.max(this.earliest({ manual: true }), this.store.writableAt(), this.now());
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read what is due (a tick never overlaps another). */
  tick({ manual = false } = {}) {
    if (!manual && this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const generation = this.generation;
    const run = this.exclusive(() => this.readDue({ manual })).finally(() => {
      if (this.ticking === run) {
        this.ticking = undefined;
      }
    });
    if (!manual) {
      this.ticking = run;
      this.tickGeneration = generation;
    }
    return run;
  }

  /**
   * Read the account when its interval has passed. Nothing, not even the
   * test button (`manual`), reads before the last request + the interval,
   * nor during a pause; `manual` may try a refused password again once the
   * interval has passed. The instant of the request is written to /data
   * before it leaves (a read waits until a write is allowed).
   */
  async readDue({ manual = false } = {}) {
    const generation = this.generation;
    const now = this.now();
    if (!this.secret || now < this.earliest({ manual }) || !this.store.canWrite()) {
      return;
    }
    this.store.update({ lastAttemptAt: now }, undefined, { defer: true });
    this.store.flush();
    await this.readAccount();
    if (generation === this.generation) {
      await this.publish();
      await this.refreshStatus();
    }
  }

  /** A valid token: the one in memory if young enough, else a new sign-in. */
  async signIn({ force = false } = {}) {
    const now = this.now();
    if (
      !force &&
      this.token &&
      this.token.secret === this.secret &&
      now - this.token.at < TOKEN_LIFETIME &&
      now >= this.token.at
    ) {
      return { token: this.token.value, fresh: false };
    }
    this.token = null;
    const secret = this.secret;
    const value = await this.client.authorize({
      email: this.config.email,
      password: this.config.password,
    });
    if (secret === this.secret) {
      this.token = { value, at: now, secret };
    }
    // Marked for the whole read: a token obtained in this read is never
    // replaced by a second sign-in in the same read.
    this.signedInThisRead = true;
    return { token: value, fresh: true };
  }

  /**
   * Call a data route with a token. A token from memory refused by the
   * route (it may have expired early) is dropped and ONE new sign-in is
   * made, then the route asked once more. A token obtained in this very
   * read and refused means the account cannot read its data (API access
   * not activated...): `denied`, a final stop like a refused password.
   */
  async withToken(call, current) {
    const denied = (err) =>
      asSourceError(err).kind === 'expired'
        ? new SourceError('denied', 'token refused right after a sign-in')
        : err;
    let { token } = await this.signIn();
    if (!current()) {
      return undefined;
    }
    try {
      return await call(token);
    } catch (err) {
      if (asSourceError(err).kind !== 'expired' || !current()) {
        throw err;
      }
      if (this.signedInThisRead) {
        throw denied(err);
      }
      this.token = null;
      ({ token } = await this.signIn({ force: true }));
      if (!current()) {
        return undefined;
      }
      try {
        return await call(token);
      } catch (again) {
        throw denied(again);
      }
    }
  }

  /** The sign-in, the last samples, and the sensor list when due. */
  async readAccount() {
    const generation = this.generation;
    const secret = this.secret;
    const current = () => generation === this.generation && secret === this.secret;
    this.signedInThisRead = false;
    try {
      const answer = await this.withToken((token) => this.client.lastSamples(token), current);
      if (!current()) {
        return;
      }
      const ids = new Set([...this.sensors.values()].map((s) => s.id));
      const unknown = [...answer.samples.keys()].some((id) => !ids.has(id));
      const now = this.now();
      // The list: when no sensor is known, every hour, and when a sample
      // comes from a sensor not listed yet (a new one) — never more often
      // than every 30 minutes but for the first one. Once sensors are known,
      // never in a read that already signed in (at most 3 requests a read).
      // A list older than 2 hours is read even in such a read (with an
      // interval of 50 minutes or more, every read signs in).
      const listAge = now - this.store.get().sensorsReadAt;
      const due =
        this.sensors.size === 0 ||
        (now >= this.listRetryAt &&
          (unknown || listAge >= SENSORS_REFRESH) &&
          (!this.signedInThisRead || listAge >= HEALTH_STALE));
      if (due) {
        this.listRetryAt = now + SENSORS_RETRY;
        let list;
        try {
          list = await this.withToken((token) => this.client.listSensors(token), current);
        } catch (err) {
          const error = asSourceError(err);
          // The list is secondary once sensors are known: a passing failure
          // of it never stops their samples (it is tried again in 30
          // minutes). A refusal and a 429 concern the whole account.
          if (
            !current() ||
            this.sensors.size === 0 ||
            error.kind === 'refused' ||
            error.kind === 'denied' ||
            error.kind === 'limited'
          ) {
            throw error;
          }
          this.logger.warn(`SensorPush sensor list: ${this.scrub(error)}`);
        }
        if (!current()) {
          return;
        }
        if (list) {
          this.applyList(list);
        }
      }
      this.applySamples(answer);
      this.error = undefined;
      this.store.update({
        pausedUntil: 0,
        streak: 0,
        refused: false,
        refusal: '',
        sensors: this.serialize(),
      });
    } catch (err) {
      this.failed(asSourceError(err), { current: current(), secret });
    }
  }

  /** The sensor list replaces the previous one; the fields only grow. */
  applyList({ sensors }) {
    const now = this.now();
    const next = new Map();
    for (const raw of sensors.slice(0, MAX_SENSORS)) {
      const known = this.sensors.get(raw.key) ?? newSensor(raw);
      known.id = raw.id;
      known.name = raw.name;
      known.model = raw.model;
      const values = valuesOf('sensor', raw);
      for (const field of Object.keys(values)) {
        known.fields.add(field);
      }
      // The battery and the signal of the last contact: published only with
      // a new sample of the same sensor, never on their own (a silent
      // sensor never looks alive through them).
      known.health = values;
      next.set(raw.key, known);
    }
    this.sensors = next;
    this.more = Math.max(0, sensors.length - MAX_SENSORS);
    this.store.update({ sensorsReadAt: now });
  }

  /**
   * The last sample of each known sensor. It keeps its `observed` as the
   * service gave it (the key that tells a new sample from one already
   * published), and its age measured on the clock of the service (the
   * `Date` of the answer; the clock of Gladys without it). A sample more
   * than 5 minutes in the future of the service is ignored.
   */
  applySamples({ samples, date }) {
    const readAt = this.now();
    const serverNow = date ?? readAt;
    for (const sensor of this.sensors.values()) {
      const sample = samples.get(sensor.id);
      if (!sample || sample.observed === null) {
        continue;
      }
      const age = serverNow - sample.observed;
      if (age < -FUTURE_TOLERANCE) {
        continue;
      }
      if (sensor.sample && sample.observed < sensor.sample.observed) {
        continue;
      }
      const values = valuesOf('sample', sample.data);
      for (const field of Object.keys(values)) {
        sensor.fields.add(field);
      }
      sensor.sample = { values, observed: sample.observed, age: Math.max(0, age), readAt };
    }
  }

  /** The age of a sample now, on the clock of the service. */
  ageOf(sample, now = this.now()) {
    return sample.age + Math.max(0, now - sample.readAt);
  }

  /** A failed read: refusal, pause or a passing failure (retried at the interval). */
  failed(error, { current, secret }) {
    const at = this.now();
    if (!current) {
      // Disconnected (or reconfigured) meanwhile: nothing is published and no
      // status is set, but a pause asked with the same credentials is kept.
      if ((error.kind === 'limited' || error.kind === 'busy') && secret === this.secret) {
        this.recordBusy(error, at);
      }
      // A refusal of the credentials still configured is kept too: they are
      // never tried again on their own.
      if ((error.kind === 'refused' || error.kind === 'denied') && secret === this.secret) {
        this.recordRefusal(error, secret);
      }
      return;
    }
    this.error = error.kind;
    if (error.kind === 'refused' || error.kind === 'denied') {
      this.recordRefusal(error, secret);
    } else if (error.kind === 'limited' || error.kind === 'busy') {
      this.recordBusy(error, at);
    }
    this.logger.warn(`SensorPush account: ${this.scrub(error)}`);
  }

  /**
   * Final: no periodic sign-in until the credentials change (or the test
   * button, one try once the interval has passed). The fingerprint of the
   * refused pair is kept only while it is refused.
   */
  recordRefusal(error, secret) {
    this.token = null;
    this.error = error.kind;
    this.store.update(
      { refused: true, refusal: error.kind === 'denied' ? 'data' : 'login' },
      secret,
    );
  }

  /** A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours. */
  recordBusy(error, at) {
    const streak = this.store.get().streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      BUSY_MAX,
    );
    this.store.update({ streak, pausedUntil: at + pause });
  }

  /** The sensors as kept under /data (nothing secret). */
  serialize() {
    return [...this.sensors.values()].map((s) => ({
      key: s.key,
      id: s.id,
      name: s.name,
      model: s.model,
      fields: [...s.fields],
      observed: s.publishedObserved,
    }));
  }

  // --- Gladys devices and states --------------------------------------------------

  devices() {
    const devices = [];
    for (const sensor of this.sensors.values()) {
      const device = deviceOf(this.gladys, {
        sensorKey: sensor.key,
        name: sensor.name,
        fields: sensor.fields,
      });
      if (device.features.length > 0) {
        devices.push(device);
      }
    }
    return devices;
  }

  async publish() {
    await this.publishDiscovered();
    await this.publishStates();
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** A sample at most one hour old (on the clock of the service). */
  isFresh(sample, now = this.now()) {
    return Boolean(sample) && this.ageOf(sample, now) <= STALE;
  }

  /**
   * The values of the created features, from each sensor's last sample (the
   * battery and the signal go with it, never alone). A sample is told apart
   * by its raw `observed` (never by an instant converted between clocks):
   *
   * - a sample is handed to Gladys once per feature; one already published
   *   (its `observed` kept under /data, so also across a restart) is never
   *   sent again, but to a feature created since (then dated);
   * - a new sample at most `recentMs()` old is sent as current; older, up to
   *   one hour, it is sent dated (`created_at`: no scene fires); older than
   *   one hour, never.
   *
   * So a sensor that stops reporting never looks alive: nothing about it is
   * sent until it reports again. The core accepts 300 states per minute: past
   * STATES_PER_MINUTE in the last minute, the rest waits in a backlog (the
   * newest value of each feature) sent as the minute frees room.
   */
  async publishStates() {
    const created = new Set();
    for (const device of this.gladys.devices ?? []) {
      for (const feature of device.features ?? []) {
        created.add(feature.external_id);
      }
    }
    // The features created when the process first published: a feature
    // outside of it was created since (a value already in Gladys for the
    // others is never sent again).
    if (this.baseline === undefined) {
      this.baseline = new Set(created);
    }
    if (created.size === 0) {
      return;
    }
    const now = this.now();
    let advanced = false;
    for (const sensor of this.sensors.values()) {
      const sample = sensor.sample;
      if (!sample || !this.isFresh(sample, now)) {
        continue;
      }
      const isNew = sample.observed > sensor.publishedObserved;
      const age = this.ageOf(sample, now);
      const dated = !isNew || age > this.recentMs();
      const createdAt = new Date(now - age).toISOString();
      // The battery and the signal only while the list is at most 2 hours
      // old: never a frozen value republished as new.
      const healthFresh = now - this.store.get().sensorsReadAt <= HEALTH_STALE;
      const values = { ...(healthFresh ? sensor.health : {}), ...sample.values };
      let sent = false;
      for (const state of statesOf(this.gladys, { sensorKey: sensor.key, values })) {
        const id = state.device_feature_external_id;
        if (!created.has(id) || this.pushed.get(id) === sample.observed) {
          continue;
        }
        if (!isNew && this.baseline.has(id)) {
          // Already published (before a restart, or before this feature was
          // seen): never again.
          continue;
        }
        this.pushed.set(id, sample.observed);
        this.backlog.set(id, dated ? { ...state, created_at: createdAt } : state);
        sent = true;
      }
      if (sent && isNew) {
        sensor.publishedObserved = sample.observed;
        advanced = true;
      }
    }
    if (advanced) {
      // Written with the next allowed write (at most once per minute).
      this.store.update({ sensors: this.serialize() }, undefined, { defer: true });
    }
    await this.flushStates();
  }

  /** Room left in the per-minute budget. */
  stateBudget() {
    const now = this.now();
    this.sentLog = this.sentLog.filter(([t]) => now - t < 60_000);
    return STATES_PER_MINUTE - this.sentLog.reduce((sum, [, n]) => sum + n, 0);
  }

  async flushStates() {
    if (this.backlog.size === 0) {
      return;
    }
    const budget = this.stateBudget();
    if (budget <= 0) {
      this.scheduleFlush();
      return;
    }
    const batch = [...this.backlog.values()].slice(0, budget);
    for (const state of batch) {
      this.backlog.delete(state.device_feature_external_id);
    }
    // The batch is reserved in the budget BEFORE the await: a flush running
    // meanwhile (a test button, a created device) sees the room already taken.
    const entry = [this.now(), batch.length];
    this.sentLog.push(entry);
    try {
      const result = await this.gladys.publishChangedStates(batch, { heartbeat: HEARTBEAT });
      // Only what was really sent counts (unchanged values are skipped).
      entry[1] = Number.isFinite(result?.count) ? result.count : batch.length;
    } catch (err) {
      entry[1] = 0;
      this.logger.warn(`Publishing the states failed: ${err.message}`);
      // Sent again later, unless a newer value came in meanwhile.
      for (const state of batch) {
        if (!this.backlog.has(state.device_feature_external_id)) {
          this.backlog.set(state.device_feature_external_id, state);
        }
      }
      this.scheduleFlush(60_000);
      return;
    }
    if (this.backlog.size > 0) {
      this.scheduleFlush();
    }
  }

  /** Flush again when the oldest send of the minute expires. */
  scheduleFlush(wait) {
    if (this.flushTimer !== undefined) {
      return;
    }
    const oldest = this.sentLog[0]?.[0];
    const delay =
      wait ??
      (oldest !== undefined ? Math.max(1_000, 60_000 - (this.now() - oldest) + 100) : 1_000);
    const generation = this.generation;
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      if (generation === this.generation) {
        this.flushStates().catch((err) => this.logger.warn(`Flush failed: ${err.message}`));
      }
    }, delay);
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  withNotes(text) {
    const notes = [];
    if (this.error === 'refused') {
      notes.push(T.refusedHelp);
    } else if (this.error === 'denied') {
      notes.push(T.deniedHelp);
    }
    if (this.more > 0) {
      notes.push(T.moreSensors(this.more, MAX_SENSORS));
    }
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en.replace(/\.$/, '')}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr.replace(/\.$/, '')}.`).join(' ')}`,
    };
  }

  /** What has no value, and why: [{ name, kind }]. */
  failing() {
    const list = [];
    if (this.error) {
      list.push({ name: 'SensorPush', kind: this.error });
    }
    const now = this.now();
    for (const sensor of this.sensors.values()) {
      if (!this.isFresh(sensor.sample, now) && !this.error) {
        list.push({ name: sensor.name, kind: 'stale' });
      }
    }
    return list;
  }

  configMessage() {
    const { config } = this;
    if (this.secret) {
      return null;
    }
    if (config.invalid) {
      return T.invalid;
    }
    return config.email || config.password ? T.oneMissing : T.notConfigured;
  }

  async refreshStatus() {
    const missing = this.configMessage();
    if (missing) {
      return this.setStatus(false, missing);
    }
    const now = this.now();
    const failing = this.failing();
    const anyValue = [...this.sensors.values()].some((s) => this.isFresh(s.sample, now));
    const text = T.ok({
      sensors: this.sensors.size,
      interval: this.config.pollMinutes,
      failing,
    });
    return this.setStatus(
      this.error !== 'refused' && this.error !== 'denied' && (anyValue || failing.length === 0),
      this.withNotes(text),
    );
  }

  // --- Configuration screen button -------------------------------------------------

  sensorLine(sensor, lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    const now = this.now();
    const parts = [];
    const add = (values, field, label, unit) => {
      if (typeof values?.[field] === 'number') {
        parts.push(`${label} ${numberText(values[field], lang)}${unit}`);
      }
    };
    if (this.isFresh(sensor.sample, now)) {
      const v = sensor.sample.values;
      add(v, 'temperature', lang === 'fr' ? 'température' : 'temperature', ' °C');
      add(v, 'humidity', lang === 'fr' ? 'humidité' : 'humidity', ' %');
      add(v, 'pressure', lang === 'fr' ? 'pression' : 'pressure', ' hPa');
    }
    if (this.isFresh(sensor.sample, now)) {
      add(sensor.health, 'battery_voltage', lang === 'fr' ? 'pile' : 'battery', ' V');
    }
    if (parts.length === 0 || !this.isFresh(sensor.sample, now)) {
      const why = sensor.sample
        ? reason('stale')[lang]
        : lang === 'fr'
          ? 'pas encore lu depuis le démarrage'
          : 'not read since the start';
      return `- ${sensor.name}${colon} ${why}`;
    }
    const minutes = Math.round(this.ageOf(sensor.sample, now) / 60_000);
    parts.push(lang === 'fr' ? `mesure d'il y a ${minutes} min` : `measured ${minutes} min ago`);
    return `- ${sensor.name}${colon} ${parts.join(', ')}`;
  }

  accountLines(lang) {
    const colon = lang === 'fr' ? ' :' : ':';
    const name = lang === 'fr' ? 'Compte SensorPush' : 'SensorPush account';
    const saved = this.store.get();
    const head = [];
    if (this.error) {
      head.push(reason(this.error)[lang]);
      if (saved.pausedUntil > this.now()) {
        head.push(T.pausedUntil(saved.pausedUntil)[lang]);
      }
    } else {
      head.push(
        lang === 'fr' ? `${this.sensors.size} capteur(s)` : `${this.sensors.size} sensor(s)`,
      );
    }
    head.push(T.nextRead(this.nextRead())[lang]);
    const lines = [`${name}${colon} ${head.join(', ')}`];
    for (const sensor of this.sensors.values()) {
      lines.push(this.sensorLine(sensor, lang));
    }
    return lines;
  }

  async testConnection() {
    const missing = this.configMessage();
    if (missing) {
      return missing;
    }
    // Gladys waits 120 s for the answer: past ~100 s, the last values are
    // shown (a read still running finishes in the background).
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([this.tick({ manual: true }), timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    const answer = {
      en: this.accountLines('en').join('\n'),
      fr: this.accountLines('fr').join('\n'),
    };
    await this.publish();
    await this.refreshStatus();
    return this.withNotes(answer);
  }
}
