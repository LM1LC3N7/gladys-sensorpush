// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake, a BOM and control bytes (a manifest once
// shipped broken), and the texts against the word "encrypted" for a secret
// field (Gladys keeps a secret in clear in its database).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS } from '../src/constants.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';
import { TABLE, deviceOf } from '../src/fields.js';

const readBuffer = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readBuffer(path).toString('utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const USER_DOCS = ['docs/en.md', 'docs/fr.md', 'README.md', 'CHANGELOG.md'];

// Built from code points, so that this file passes its own check.
const REPLACEMENT = String.fromCharCode(0xfffd);
const MOJIBAKE = [[0xc3], [0xc2], [0xe2, 0x20ac]].map((codes) => String.fromCharCode(...codes));
const isCombining = (c) => c.charCodeAt(0) >= 0x300 && c.charCodeAt(0) <= 0x36f;
const dir = (path) =>
  readdirSync(new URL(`../${path}/`, import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `${path}/${name}`);

test('no mojibake, no BOM and no control byte in the manifest, the docs and the code', () => {
  const files = [
    'gladys-assistant-integration.json',
    ...USER_DOCS,
    'TODO.md',
    'CLAUDE.md',
    'THIRD_PARTY_NOTICES.md',
    'Dockerfile',
    'package.json',
    'index.js',
    '.github/scripts/cover.mjs',
    ...dir('src'),
    ...dir('test'),
    ...dir('test/helpers'),
  ];
  assert.ok(files.length > 20, 'every source file is checked');
  for (const file of files) {
    const buffer = readBuffer(file);
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    for (const byte of buffer) {
      assert.ok(byte >= 0x20 || byte === 0x0a || byte === 0x0d, `${file} holds a control byte`);
    }
    const text = buffer.toString('utf8');
    assert.ok(!text.includes(REPLACEMENT), `${file} holds an invalid UTF-8 sequence`);
    for (const bad of MOJIBAKE) {
      assert.ok(!text.includes(bad), `${file} holds mojibake (${bad})`);
    }
    assert.ok(![...text].some(isCombining), `${file} holds a bare combining mark`);
  }
  assert.match(read('docs/fr.md'), /é/);
  assert.match(manifest.config_schema[0].description.fr, /température/);
});

test('a secret is never said "encrypted" ("chiffré") to the user', () => {
  for (const [path, text] of texts(manifest)) {
    assert.doesNotMatch(`${text.en} ${text.fr}`, /encrypt|chiffr/i, path);
  }
  for (const file of USER_DOCS) {
    assert.doesNotMatch(read(file), /encrypt|chiffr/i, file);
  }
});

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /sstallion\/sensorpush-api/, `docs/${lang}.md credits sensorpush-api`);
    assert.match(docs, /sstallion\/sensorpush-ha/, `docs/${lang}.md credits sensorpush-ha`);
  }
  assert.match(read('docs/en.md'), /never been tested with a real sensor/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai capteur/i);
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  assert.match(manifest.config_schema[0].description.en, /not affiliated with SensorPush/);
});

test('one version everywhere (semver), and the image is tagged with it', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-sensorpush:${manifest.version}`);
});

test('the license and the notices ship with the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'no personal name');
  assert.equal(pkg.license, 'Apache-2.0');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /sstallion\/sensorpush-api/);
  assert.match(notices, /sstallion\/sensorpush-ha/);
  assert.equal(
    notices.match(/Redistribution and use in source and binary forms/g)?.length,
    2,
    'both BSD-2-Clause notices in full',
  );
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('sections are purely presentational, with https links', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} is too long`);
    }
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key]?.default, value, key);
  }
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, field.key);
    }
  }
  assert.equal(fields.email.type, 'string');
  assert.equal(fields.password.type, 'secret', 'the password is masked, never shown again');
  assert.match(fields.password.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.password.description.fr, /Gardé par Gladys dans sa base, jamais réaffiché/);
  assert.equal(fields.poll_interval.min, 1);
  assert.equal(fields.poll_interval.max, 60);
  const config = normalizeConfig({ email: ' a@b.c ', password: ' p ', poll_interval: '0' });
  assert.equal(config.email, 'a@b.c');
  assert.equal(config.password, ' p ', 'the password is kept as typed');
  assert.equal(config.pollMinutes, 1);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollMinutes, 5);
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollMinutes, 60);
});

test('the keys of the manifest are the keys of the code; read only', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(manifest.actions[0].timeout_seconds <= 120);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.ok(!index.includes('onSetValue'), 'no command: read only');
  // Only the four read routes of the API.
  const routes = read('src/sensorpush.js').match(/'\/[a-z/]+'/g);
  assert.deepEqual([...new Set(routes)].sort(), [
    "'/devices/sensors'",
    "'/oauth/accesstoken'",
    "'/oauth/authorize'",
    "'/samples'",
  ]);
});

// DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
// for the categories this integration uses. The core lists no unit for
// `unknown` (the battery voltage and the signal: none).
const CORE_UNITS = {
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  'humidity-sensor': ['percent'],
  'pressure-sensor': ['pascal', 'hPa', 'kPa', 'bar', 'psi', 'milli-bar'],
  unknown: [undefined],
};

test('every feature uses a unit the core lists for its category', async () => {
  const gladys = createFakeGladys({ selector: 'sensorpush' });
  const device = deviceOf(gladys, {
    sensorKey: '1-2',
    name: 'All',
    fields: new Set(TABLE.map(([key]) => key)),
  });
  assert.equal(device.features.length, TABLE.length);
  for (const feature of device.features) {
    assert.ok(feature.category in CORE_UNITS, `${feature.category} is not checked`);
    assert.ok(
      CORE_UNITS[feature.category].includes(feature.unit),
      `${feature.external_id}: ${feature.unit}`,
    );
    assert.equal(feature.read_only, true);
  }
  // The fake Gladys refuses what the host API refuses.
  await gladys.connect();
  await gladys.publishDiscoveredDevices([device]);
});

test('a created feature is never dropped from the Discovery list', async () => {
  const gladys = createFakeGladys({ selector: 'sensorpush' });
  await gladys.connect();
  const full = deviceOf(gladys, {
    sensorKey: '1-2',
    name: 'Cave',
    fields: new Set(['temperature', 'pressure']),
  });
  await gladys.fake.deviceCreated({
    ...full,
    features: [
      ...full.features,
      { ...full.features[0], external_id: `${full.external_id}:old_field`, name: 'Old' },
    ],
  });
  const later = deviceOf(gladys, { sensorKey: '1-2', name: 'Cave', fields: new Set() });
  assert.deepEqual(
    later.features.map((f) => f.external_id.split(':').pop()),
    ['temperature', 'pressure', 'old_field'],
  );
});
