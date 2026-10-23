// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): the
// instant of the last request to SensorPush, the end of a pause (429/5xx),
// whether the e-mail and password were refused, and the sensors met (id,
// name, model, the fields they gave: nothing secret), so a container
// restarting in a loop never reads faster than the interval, never signs in
// again with a refused password, and the Discovery list is not empty after a
// restart.
//
// The instant of a request is written at most once per minute (WRITE_GAP
// after the previous write, whatever it was; the instant of the write is
// kept in the file): a read waits until such a write is allowed, so the
// instant of its request is always on disk before the request leaves. A
// pause, a refusal, their end or a new sensor is written at once (one such
// write per request at most), so a restart never forgets it.
//
// The e-mail, the password and the token are never written. Only while
// they are refused, the file keeps a salted scrypt fingerprint (16 bytes, a
// random salt per file) of that refused pair, to know after a restart
// whether the refusal still concerns the configured account; it is erased
// by the first successful sign-in. Nothing in the file can confirm a
// password that works.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_SENSORS, WRITE_GAP } from './constants.js';
import { featureKeys } from './fields.js';
import { cleanText, sensorKeyOf } from './sensorpush.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    writes: 0,
    load: () => value,
    save(next) {
      this.writes += 1;
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 256 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** A sensor read back from the file, or undefined when it does not look right. */
function sensorOf(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.key !== 'string' ||
    sensorKeyOf(value.id) !== value.key
  ) {
    return undefined;
  }
  const allowed = featureKeys();
  const fields = Array.isArray(value.fields)
    ? value.fields.filter((f) => typeof f === 'string' && allowed.has(f)).slice(0, 20)
    : [];
  return {
    key: value.key,
    id: value.id,
    name: cleanText(value.name, 60) || value.key,
    model: cleanText(value.model, 30),
    fields: [...new Set(fields)],
    // The raw `observed` (service time, ms) of the last sample handed to
    // Gladys: a sample not newer is never sent again, also after a restart.
    observed: Math.max(0, finite(value.observed)),
  };
}

export class AccountStore {
  constructor({
    storage = memoryStorage(),
    now = Date.now,
    timers = { setTimeout, clearTimeout },
    maxPause,
  }) {
    this.storage = storage;
    this.now = now;
    this.timers = timers;
    this.flushTimer = undefined;
    this.dirty = false;
    /** In memory only: the secret last configured, to tell a change. */
    this.secret = undefined;
    const saved = storage.load();
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved);
    const at = now();
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    // The instant of the last write, never in the future: a restart loop
    // writes no more often than a running process.
    this.writtenAt = valid ? Math.min(finite(saved.writtenAt), at) : 0;
    const entry = valid && saved.account && typeof saved.account === 'object' ? saved.account : {};
    // A time read back is capped (a request never "in the future", a pause
    // never longer than a fresh one): a clock that jumped, or a hand-edited
    // file, never stops the reads for longer.
    this.entry = {
      lastAttemptAt: Math.min(finite(entry.lastAttemptAt), at),
      pausedUntil: Math.min(finite(entry.pausedUntil), at + maxPause),
      streak: Math.min(Math.max(0, Math.floor(finite(entry.streak))), 20),
      refused: entry.refused === true,
      // What was refused: `login` (the password) or `data` (a token right
      // after a sign-in). Both are final until other credentials.
      refusal: entry.refused === true ? (entry.refusal === 'data' ? 'data' : 'login') : '',
      fp: typeof entry.fp === 'string' && /^[0-9a-f]{32}$/.test(entry.fp) ? entry.fp : '',
      sensorsReadAt: Math.min(finite(entry.sensorsReadAt), at),
      sensors: Array.isArray(entry.sensors)
        ? entry.sensors.slice(0, MAX_SENSORS).map(sensorOf).filter(Boolean)
        : [],
    };
    if (!this.entry.refused) {
      this.entry.fp = '';
    }
  }

  /** The salted fingerprint of the account secret (never the secret). */
  fingerprint(secret) {
    return scryptSync(String(secret), `${this.salt}:account`, 16).toString('hex');
  }

  get() {
    return this.entry;
  }

  /**
   * The saved state for the configured secret (`e-mail\npassword`). Other
   * credentials drop the refusal and the instant of the last request (tried
   * at once): told apart in memory while the process runs; after a restart,
   * only a refused pair is known (its fingerprint), so credentials changed
   * while the container was stopped wait at most one interval. A refusal
   * whose fingerprint is missing is kept (never lifted by guess). Returns
   * `{ entry, changed }`.
   */
  restore(secret) {
    const entry = { ...this.entry };
    let changed = false;
    if (this.secret !== undefined) {
      changed = this.secret !== secret;
    } else if (entry.refused && entry.fp) {
      changed = entry.fp !== this.fingerprint(secret);
    }
    this.secret = secret;
    if (changed) {
      // Another account may own other sensors: their list is read again.
      this.update(
        { refused: false, refusal: '', fp: '', lastAttemptAt: 0, sensorsReadAt: 0 },
        undefined,
        {
          defer: true,
        },
      );
    }
    return { entry: this.entry, changed };
  }

  /**
   * Update the entry. A refusal (`refused: true`, with the refused `secret`)
   * keeps the fingerprint of that secret; its end erases it. A change (a
   * pause, a refusal, its end, the sensors met: rare events, one per request
   * at most) is written at once, so a restart never forgets it; with `defer`
   * (the instant of a request, written by its own flush), at the next
   * allowed instant.
   */
  update(changes, secret, { defer = false } = {}) {
    const previous = this.entry;
    const next = { ...previous, ...changes };
    if (changes.refused === true && secret !== undefined) {
      next.fp = this.fingerprint(secret);
    } else if (!next.refused) {
      next.fp = '';
    }
    if (!next.refused) {
      next.refusal = '';
    }
    this.entry = next;
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      if (defer) {
        this.markDirty();
      } else {
        this.dirty = true;
        this.write();
      }
    }
    return next;
  }

  /** The first instant a write is allowed. */
  writableAt() {
    return this.writtenAt + WRITE_GAP;
  }

  canWrite() {
    return this.now() >= this.writableAt();
  }

  markDirty() {
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer !== undefined) {
      return;
    }
    const delay = Math.max(0, this.writableAt() - this.now());
    this.flushTimer = this.timers.setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  /** Write the file now if something changed and a write is allowed; returns whether it is on disk. */
  flush() {
    if (!this.dirty) {
      return true;
    }
    if (!this.canWrite()) {
      this.scheduleFlush();
      return false;
    }
    this.write();
    return true;
  }

  write() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.writtenAt = this.now();
    this.dirty = false;
    this.storage.save({ salt: this.salt, writtenAt: this.writtenAt, account: this.entry });
  }

  /** Stop the pending write (the next start writes what is left). */
  close() {
    this.timers.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }
}
