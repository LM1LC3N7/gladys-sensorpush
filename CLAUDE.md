# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads SensorPush sensors, read only, through the official SensorPush
Gateway Cloud API (after sstallion/sensorpush-api and sstallion/sensorpush-ha,
BSD 2-Clause).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `test` and
`npm audit` on Node 22 and 24, and builds the Docker image: run them before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        SensorPushApp: due time, token, pauses, refusal, devices, states, status, test
src/sensorpush.js                 the four POST routes of the API, error kinds, sensor ids
src/fields.js                     samples -> values in core units, devices, states (pure)
src/store.js                      pace, pause, refusal, sensors met, persisted in /data (never a secret)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/http.js                       fetch with timeout, no redirection, bounded body
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** Only `POST /oauth/authorize`, `/oauth/accesstoken`,
  `/devices/sensors` and `/samples`; never `/tags`, `/reports` nor anything
  that writes. No Bluetooth.
- **Secrets.** The e-mail and the password travel only in the body of
  `/oauth/authorize`, the token only in the `Authorization` header, to
  `api.sensorpush.com`. None of them in a URL, a log, an error, a status nor
  `/data` (only a salted scrypt fingerprint of a refused pair while it is
  refused). Never describe a secret field as "encrypted": Gladys keeps it in
  clear in its database (`test/manifest.test.js` checks the manifest and the
  docs).
- **A refused password is final**: no automatic sign-in until the
  credentials change or the test button is pressed. A token from memory
  refused by a data route gives ONE new sign-in; a token obtained in the
  same read and refused is final too (`denied`); never two sign-ins in a
  read; a 429 on the sign-in is a pause, never a refusal.
- **Samples are told apart by their raw `observed`** (kept under `/data`)
  and handed to Gladys once; current only when recent, dated up to 1 hour,
  never older; battery and signal only with a new sample.
- **Pace.** Never read before the last request + the interval (test button,
  reconnection, saved configuration, Discovery, restart); the instant of a
  request is written to `/data` before it leaves, at most once per minute.
  A generation is checked after every await: a late answer publishes
  nothing and sets no status.
- **External ids are forever**: `sensor:<API sensor id, <digits>.<digits>,
its dot as ->`, then the feature keys of this integration
  (`temperature`, `humidity`, `pressure`, `dew_point`, `vpd`,
  `battery_voltage`, `signal`). The same goes for every key users store:
  manifest `config_schema`, `actions`.
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), and never
  drop a feature of a created device from the Discovery list.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
