# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real SensorPush account (G1 gateway,
      API access activated): the devices of the Discovery tab, their values,
      the status, the test button, a wrong password, a sensor added or
      removed. Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published (at milestone 1 its only
      expected error is `docker_image` not yet pullable from GHCR). The
      validator was not run by the development agent (no access to it) and
      the Docker image was never built locally (no Docker on the
      development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm on a real account

- [ ] What `/oauth/authorize` answers for a wrong password (the swagger
      says 403 "invalid user"; 400 and 401 are taken as refused too) and for
      an account without API access.
- [ ] What a data route answers for an expired token (400, 401 or 403: all
      give one new sign-in).
- [ ] Whether the API sends `Retry-After` with a 429, and the rate limit
      (the docs ask for no more than one read a minute: the minimum
      interval).
- [ ] The `Date` header of the answers (used to date the samples; without
      it, the clock of Gladys is used).
- [ ] The exact sensor ids (`<device id>.<long id>`) and the `type` values
      (HT1, HT.w, HTP.xw).
- [ ] The units: °F, inHg and kPa per the swagger; a sample of an HT1 has
      no pressure.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-sensorpush:0.1.0`); the first patch release
  gives 0.1.1.
- **References**: sstallion/sensorpush-api (BSD 2-Clause, version 2.1.3,
  commit 837307a of 2025-06-10) for the routes and the models, and
  sstallion/sensorpush-ha (BSD 2-Clause, version 1.3.3, commit 2028ec0 of
  2026-10-19) for the sign-in and the reading of the sensors; licenses read
  in their LICENSE files (not GPL), cloned read only in `_ref`. Ported to
  JavaScript, credited in the docs and in `THIRD_PARTY_NOTICES.md` with
  both BSD notices in full (copied into the image with `LICENSE`). No
  application key nor client id is hard-coded: the API takes the e-mail and
  the password of the account only; no User-Agent nor fingerprint of an
  app is imitated (the User-Agent names this integration).
- **Neighbour module**: gladys-weatherlink (a cloud weather API read only:
  pace and state file under `/data`, pauses, test button, state budget,
  devices that never lose a feature). gladys-yolink was not needed (MQTT,
  commands).
- **Read only, cloud only**: the four routes above; no tags, no reports, no
  gateway route in this milestone. The local mode of SensorPush is
  Bluetooth only: left out (no Bluetooth in the containers).
- **Sign-in (no refresh token in this API)**: e-mail + password →
  authorization → access token, kept in memory only, used 50 minutes (it
  is valid one hour, sensorpush-ha); renewed in the read that needs it,
  never by a timer. A data route refusing the token (400/401/403) drops it
  and gives ONE new sign-in in the same read, then the route once more;
  refused again, the error "data refused even with a new sign-in" is kept
  until the next interval (one sign-in per read at most, never a loop).
- **Refused password = final (lot 12 lesson)**: 400/401/403 on
  `/oauth/authorize` stops every periodic sign-in, persisted in `/data`,
  also after a restart (salted scrypt fingerprint of the refused pair, only
  while refused; a refusal without its fingerprint is kept, never lifted by
  guess); only other credentials (tried at once) or the test button (once
  the interval has passed, one try; the refusal is lifted only by a
  success) sign in again. A 429/5xx on the sign-in is a pause, never a
  refusal; a 4xx on `/oauth/accesstoken` is a passing failure.
- **Pace (lot 11 lessons)**: the instant of every read is recorded and
  written to `/data` before the request leaves (a read waits until 60 s
  have passed since the previous write); nothing reads before that instant
  - the interval: not the test button, a reconnection, a saved
    configuration, the Discovery tab (it publishes what is known, with no
    call) nor a restart. A reconnection during a read starts no other read
    (the reads are chained). Default interval 5 minutes (1 to 60).
- **Late answers**: a generation and the credentials are checked after
  every await; an answer of an old configuration publishes nothing and sets
  no status (only a 429/5xx pause is kept when the same credentials are
  still configured).
- **Errors**: 429 → pause (Retry-After, else 5 minutes doubling, 1 minute to
  6 hours, read back capped); 5xx → the same; network → retried at the
  interval. The sensor list is secondary once sensors are known: its
  passing failure never stops the samples (tried again in 30 minutes).
- **Identity**: one device per sensor id of the API (the key of
  `/devices/sensors` and of `/samples`); external id
  `sensor:<id in lowercase, other characters as ->`; a sample is applied
  only to the sensor listed under the same id; an id that does not look
  like one is skipped, never taken as another sensor. A sample of an
  unlisted sensor reads the list again (at most every 30 minutes).
  Inactive sensors (`active: false`) are left out.
- **Categories and units of the core only** (checked by
  `test/manifest.test.js` and the SDK's fake Gladys): temperature °C
  (decimal), humidity %, pressure hPa (inHg × 33.8639), dew point °C as
  `probe` (out of the room average), vapour pressure deficit kPa
  (pressure-sensor), battery voltage and signal as `unknown` sensors
  without unit (the core has no volt unit for a battery nor a dB unit), the
  unit in their name, as gladys-robonect for its Wi-Fi signal. Metric only.
- **Left out**: the altitude (a setting, not a measure), the alerts, the
  calibration, the MAC address, the tags, the gateways.
- **Values**: a value out of the feature bounds is left out, never clamped;
  never NaN, null or undefined published; only own fields are read
  (`Object.hasOwn`): no prototype pollution.
- **Dated samples (lot 12 lesson)**: a sample is dated by its `observed`,
  converted to the clock of Gladys with the `Date` header of the answer
  (lot 13 lesson: the service time, never the Gladys clock, when readable);
  older than 1 hour (or 2 intervals) it is not published. A reading is
  handed to Gladys once per feature: the same sample is never republished
  as new (so the SDK heartbeat never refreshes a dead sensor). The
  battery and the signal are dated by the answer of the sensor list.
- **Bounded answers**: 1 MB, 15 s per request (body included), the chunks
  joined once; at most 1,000 entries of an answer looked at, 50 sensors
  published.
- **Privacy**: of the sensor list, only the id, name and model are kept
  (not the MAC address); the e-mail address is never written under
  `/data` nor shown in a status.
- **Features never lost**: the Discovery device holds every field ever read
  plus every feature of the created device (`gladys.devices`); the sensors
  met are kept under `/data`, so the Discovery list is filled after a
  restart.
- **Status and Discovery republished at each `connected`** (the core keeps
  them in memory only); the pace, the pause and the refusal are kept.
- **States**: only the created features, at most 250 per minute (the core
  accepts 300), the budget reserved before each await.
- **No sensitive command, no energy index, no scene event**: none of the
  rules about commands, energy indexes or `publishSceneEvent` applies.

## Ideas

- The gateways (`POST /devices/gateways`): online state, last seen.
- The history of the samples after an outage (`start_time`), published
  dated: needs a catch-up rule that never fires scenes.
- An imperial option for the temperatures (°F is a core unit).
