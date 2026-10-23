# Third-party notices

This integration is licensed under Apache-2.0 (see `LICENSE`). It ports to
JavaScript parts of the following projects, both under the BSD 2-Clause
license. No code of them is shipped as is: their logic was rewritten.

## sstallion/sensorpush-api

- Project: https://github.com/sstallion/sensorpush-api (Python client of the
  SensorPush Gateway Cloud API, generated from the official swagger;
  version 2.1.3, commit 837307a of 2025-06-10)
- Author: Steven Stallion
- Ported: the routes and the models of the API (`sensorpush_api/api/api_api.py`,
  `sensorpush_api/models/`): `POST /oauth/authorize`, `POST /oauth/accesstoken`,
  `POST /devices/sensors`, `POST /samples`, the `Authorization` header that
  carries the access token as is, the fields of `Sensor` and `Sample` and
  their units (°F, inHg, kPa).
- Changes: rewritten in JavaScript; only these four routes; answers bounded
  in size; the sensor ids checked; no prototype pollution.
- License: BSD 2-Clause, reproduced below.

```
Copyright (c) 2024 Steven Stallion <sstallion@gmail.com>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

## sstallion/sensorpush-ha

- Project: https://github.com/sstallion/sensorpush-ha (the helper library of
  the SensorPush Cloud integration of Home Assistant; version 1.3.3, commit
  2028ec0 of 2026-10-19)
- Author: Steven Stallion
- Ported: the sign-in flow and its one-hour access token without refresh
  token (`sensorpush_ha/api.py`), the reading of the sensors and of their
  last sample (`sensorpush_ha/helper.py`: `limit=1`, the battery voltage and
  the signal from the sensor list, the measures from the sample).
- Changes: rewritten in JavaScript; no blind retry loop: a refused token
  gives one new sign-in, a refused password stops the sign-ins, a 429 or a
  5xx pauses the reads; values converted to the units of Gladys.
- License: BSD 2-Clause, reproduced below.

```
Copyright (c) 2025 Steven Stallion <sstallion@gmail.com>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```
