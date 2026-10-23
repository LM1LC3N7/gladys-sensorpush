# SensorPush

**Unofficial connector, not affiliated with SensorPush.** It brings into
Gladys the **SensorPush** sensors of your account (HT1, HT.w, HTP.xw...),
read through the **official SensorPush Gateway Cloud API**.

> **This integration has never been tested with a real sensor.** It follows
> the official API description and the libraries of the SensorPush Cloud
> integration of Home Assistant. Please report what you see on the Gladys
> forum.

## What you need

- A **SensorPush G1 Wi-Fi gateway**: it relays the sensors to the SensorPush
  cloud. The sensors themselves speak Bluetooth, which this integration does
  not use (a Gladys integration runs in a container without Bluetooth).
- The **API access** of your account activated: sign in once on
  [dashboard.sensorpush.com](https://dashboard.sensorpush.com) with the
  e-mail and the password of the SensorPush app, and accept the terms of the
  API if asked.

## What you get

One Gladys device per sensor, named as in the SensorPush app:

| Feature                 | Unit | Notes                                                   |
| ----------------------- | ---- | ------------------------------------------------------- |
| Temperature             | °C   | the room temperature of Gladys                          |
| Humidity                | %    |                                                         |
| Pressure                | hPa  | HTP.xw only                                             |
| Dew point               | °C   | a probe: kept out of the room temperature average       |
| Vapour pressure deficit | kPa  | useful for a greenhouse or a grow room                  |
| Battery voltage (V)     | V    | about 3 V new; replace the battery below about 2.6 V    |
| Signal (dB)             | dB   | the Bluetooth signal between the sensor and its gateway |

- Only what your sensor measures is created (an HT1 has no pressure).
- SensorPush sends °F and inHg: converted to °C and hPa by the integration,
  the units Gladys lists for each kind of sensor. Gladys has no unit for a
  voltage nor a signal in dB: these two are plain values, the unit in their
  name.
- The names of the features are in English; rename them when you create
  them if you wish.

## Installation

1. Install the integration from the Gladys catalog (Gladys 5.1 or newer).
2. In the **Configuration** screen, enter the **e-mail address** and the
   **password** of your SensorPush account.
3. Click **Test SensorPush**: the message shows the main values of each
   sensor.
4. Open the **Discovery** tab and add the devices. Their values arrive as
   soon as they are created.

## Configuration

- **E-mail address** and **password**: the password is kept by Gladys in its
  database (in clear, like every secret field of Gladys) and never shown
  again in the configuration screen. It is sent only to SensorPush
  (`api.sensorpush.com`), in the body of the sign-in request, never in a
  URL, a log, a status nor under `/data`. Neither is the e-mail address, nor
  the access token SensorPush gives back (kept in memory only).
- **Read interval**: 5 minutes by default, 1 to 60. SensorPush asks not to
  read more than once a minute; the gateway uploads about once a minute.

## How often SensorPush is read

- At each interval, **one request** asks for the last sample of every sensor
  (`POST /samples`, one sample each).
- The **sensor list** (`POST /devices/sensors`: names, battery, signal) is
  read at the start, then every hour, and when a sample comes from a sensor
  not known yet (at most every 30 minutes).
- A **sign-in** (`POST /oauth/authorize`, then `POST /oauth/accesstoken`)
  gives an access token valid one hour; it is used 50 minutes at most. There
  is no refresh token in this API: a new token means the e-mail and the
  password again. If a request refuses the token, the integration signs in
  **once** more and asks again; refused again, it waits for the next
  interval (never a loop).
- **Never faster than the interval**, counted from the last request sent:
  not by the test button, a reconnection to Gladys, a saved configuration,
  the Discovery tab nor a restart of the container. Only other credentials
  are tried at once. Before the interval has passed, the test button shows
  the last values and the time of the next possible read.
- **Read only**: the integration never writes anything to a sensor, a
  gateway nor the account.
- When SensorPush answers **429 or a 5xx**, it is left alone for the
  `Retry-After` delay given, else 5 minutes, then 10, 20...; always between
  1 minute and 6 hours. A 429 on the sign-in is a pause too, never a refused
  password.
- When SensorPush **refuses the e-mail or the password**, the sign-ins stop
  **for good** and the status says so: no new try on its own, even after a
  restart, so that the account is never locked by repeated attempts. Change
  the e-mail or the password (it is then tried at once), or press the test
  button once the interval has passed (one try). Clearing a field then typing
  it again, or saving the configuration, never lifts the refusal.
- An e-mail address without "@", or an e-mail or a password holding a line
  break or a control character (a bad copy), is refused at once ("not
  valid") and never sent.
- A sample older than one hour (or two intervals) is not published; its age
  is measured with the clock of SensorPush (the `Date` of its answer), so a
  Gladys clock that is off never makes it look older or newer. A sample is
  handed to Gladys once: a sensor that stops reporting never looks alive.
- If the sensor list fails while sensors are known, their samples are still
  read; the list is tried again 30 minutes later.
- The instant of the last request, the pause, the refusal and the sensors
  met (id, name, model, measures: nothing secret, never the e-mail address
  nor the MAC address of a sensor) survive a reconnection and a restart of
  the container: they are kept in a file under `/data`. The instant of a
  request is written before the request leaves, at most once per minute; a
  pause, a refusal or a new sensor is written at once. Only while the
  password is refused, the file keeps a salted fingerprint (scrypt) of the
  refused e-mail and password, so that after a restart other credentials are
  tried at once; it is erased by the first sign-in that works, so nothing in
  the file can confirm a password that works.
- At most 50 sensors are read; at most 250 values are sent to Gladys per
  minute; an answer larger than 1 MB, or slower than 15 seconds, is
  abandoned.

## External ids

`ext:sensorpush:sensor:<sensor id>`, the sensor id being the one of the
SensorPush API in lowercase, each character other than a letter or a digit
replaced by `-` (`16825929.17287013094063749210` gives
`16825929-17287013094063749210`), then `:<feature>` (`temperature`,
`humidity`, `pressure`, `dew_point`, `vpd`, `battery_voltage`, `signal`).
These ids never change.

## Troubleshooting

- **"e-mail or password refused"**: check them in the SensorPush app, and
  that the API access is activated on dashboard.sensorpush.com. Then change
  them in the configuration, or press the test button.
- **"data refused even with a new sign-in"**: the API access may not be
  activated for the account; sign in on dashboard.sensorpush.com.
- **"no recent reading"**: the sensor has not been heard by a gateway for
  more than an hour (out of range, empty battery, gateway offline).
- Logs: the level is set with the `LOG_LEVEL` variable.

## Privacy

The integration talks only to `api.sensorpush.com`, over HTTPS, with your
e-mail address and password (sign-in) and then the access token. Of the
answers, it keeps only the id, name and model of each sensor and its
measures.

## Credits

Built after [sstallion/sensorpush-api](https://github.com/sstallion/sensorpush-api)
(BSD 2-Clause, Steven Stallion), the client of the SensorPush API generated
from its official description, and
[sstallion/sensorpush-ha](https://github.com/sstallion/sensorpush-ha) (BSD
2-Clause, Steven Stallion), the library of the SensorPush Cloud integration
of Home Assistant: the routes, the sign-in, the fields and their units are
ported to JavaScript. Their notices are in `THIRD_PARTY_NOTICES.md`.
SensorPush is a trademark of its owner; this connector is free and
unofficial.
