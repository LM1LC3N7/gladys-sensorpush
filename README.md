# gladys-sensorpush

[Gladys Assistant](https://gladysassistant.com) external integration for the
**SensorPush** sensors (HT1, HT.w, HTP.xw...): temperature, humidity,
pressure, dew point, vapour pressure deficit, battery voltage and signal,
read through the official
[SensorPush Gateway Cloud API](https://www.sensorpush.com/gateway-cloud-api)
(a G1 Wi-Fi gateway is needed; no Bluetooth). Read only. **Unofficial, not
affiliated with SensorPush. Never tested with a real sensor yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (SensorPushApp)  what is due, token, pauses, refusal, devices, states, status, test
                 ├─ src/sensorpush.js        POST /oauth/authorize, /oauth/accesstoken, /devices/sensors, /samples
                 ├─ src/fields.js            samples -> values in core units, devices, states (pure)
                 ├─ src/store.js             pace, pause, refusal, sensors met, persisted in /data
                 ├─ src/config.js            DEFAULT_CONFIG + normalization of the configuration
                 └─ src/http.js              fetch, timeout, no redirection, bounded body
```

- **Sign-in**: e-mail and password → authorization code → access token
  (one hour, used 50 minutes; no refresh token). A token refused by a data
  route gives ONE new sign-in, then the error is kept until the next
  interval.
- **Reads**: `POST /samples` (`limit: 1`) at each interval; the sensor list
  every hour (and when an unknown sensor shows up, at most every 30
  minutes).
- **Pace**: 5 minutes by default; never faster than the interval since the
  last request (persisted before it leaves, written at most once per
  minute), test button, reconnections and restarts included.
- **Refused password**: final (no automatic sign-in, even after a restart)
  until the credentials change or the test button is pressed; persisted
  with a salted scrypt fingerprint of the refused pair only, erased by the
  first successful sign-in. **429/5xx** → `Retry-After`, else 5 minutes
  doubling, between 1 minute and 6 hours, persisted.
- **Devices**: `sensor:<sensor id>` (the API id in lowercase, other
  characters as `-`), then a feature key of this integration
  (`temperature`, `dew_point`...). Units of the core only. A feature once
  created is never dropped from the Discovery list.

No runtime dependency besides the Gladys SDK.

## Development

```bash
npm install
npm test                                        # node --test, no network, no disk
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- [sstallion/sensorpush-api](https://github.com/sstallion/sensorpush-api)
  (BSD 2-Clause, Steven Stallion): the routes and the models of the API.
- [sstallion/sensorpush-ha](https://github.com/sstallion/sensorpush-ha)
  (BSD 2-Clause, Steven Stallion): the sign-in and the reading of the
  sensors of the Home Assistant integration.

Their notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). SensorPush is a trademark of its owner.
