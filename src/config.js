// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  poll_interval: 5,
};

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/** No control character (a pasted line break never travels to SensorPush). */
const printable = (text) =>
  [...text].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);

/** The e-mail address of the account, and its password. */
export function normalizeConfig(raw = {}) {
  const email = clean(raw.email);
  // The password is kept as typed: spaces may belong to it.
  const password = typeof raw.password === 'string' ? raw.password : '';
  return {
    email,
    password,
    // A line break or a control character, or an address without "@", is
    // refused at once and never sent.
    invalid:
      Boolean(email || password) &&
      (!printable(email) ||
        !printable(password) ||
        (email !== '' && !/^[^@\s]+@[^@\s]+$/.test(email)) ||
        email.length > 254 ||
        password.length > 256),
    pollMinutes: number(raw.poll_interval, DEFAULT_CONFIG.poll_interval, 1, 60),
  };
}

/** Both the e-mail and the password are needed, and valid. */
export const hasAccount = (config) => Boolean(config.email && config.password) && !config.invalid;
