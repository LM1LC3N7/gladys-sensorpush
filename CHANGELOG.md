# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Your SensorPush sensors in Gladys (HT1, HT.w, HTP.xw...), read only,
  through the official SensorPush Gateway Cloud API (a G1 Wi-Fi gateway is
  needed): the e-mail address and the password of your SensorPush account,
  every sensor of the account (fifty at most).
- One device per sensor: temperature, humidity, pressure, dew point (a
  probe, kept out of the room average), vapour pressure deficit, battery
  voltage and signal, in the units Gladys lists (°C, %, hPa, kPa).
- Read every 5 minutes by default, never faster: not by the test button, a
  reconnection, a saved configuration, the Discovery tab nor a restart (the
  instant of the last request is kept under `/data`, written at most once
  per minute). One request per read; the sensor list every hour; a sign-in
  every 50 minutes.
- A refused e-mail or password stops the sign-ins for good, also after a
  restart, until you change them or press the test button: the account is
  never locked by repeated attempts. A token refused by SensorPush gives one
  new sign-in, never a loop. A 429 or 5xx pauses the reads (Retry-After, else
  5 minutes doubling, between 1 minute and 6 hours), also across a restart.
  The e-mail, the password and the token are never written under `/data`
  nor in the logs.
- A sample older than one hour is never published, its age measured with
  the clock of SensorPush; a sample is handed to Gladys once, so a sensor
  that stops reporting never looks alive.
- A connection status that names the sensors without value and why, and a
  "Test SensorPush" button that reads what is due and shows the last values
  and the time of the next possible read.
