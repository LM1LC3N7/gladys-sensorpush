// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the SensorPushApp (src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { SensorPushApp } from './src/app.js';
import { ACTIONS, STATE_FILE } from './src/constants.js';
import { fileStorage } from './src/store.js';

const gladys = new GladysIntegration();
// The pace, the pauses and the refusal are kept in /data, the one writable
// volume, so that a restart loop never reads faster than the interval nor
// signs in again with a refused password (the e-mail, the password and the
// token are never written).
const app = new SensorPushApp({ gladys, storage: fileStorage(STATE_FILE, { logger }) });

// --- Discovery: the sensors already read (no extra call) -------------------------
gladys.onScanRequest(() => app.publishDiscovered({ force: true }));

// --- A device was created: send its values now, not at the next reading ------
gladys.onDeviceCreated(() => app.publishStates());

// --- Configuration screen button -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());

// --- Configuration changed by the user -----------------------------------------
gladys.onConfigUpdated(async (config) => {
  logger.info('Configuration updated: restarting');
  await app.start(config);
});

// --- Connection lifecycle -------------------------------------------------------
// A reconnection keeps the pace, the pauses and the refusal: start() only
// resets them when the credentials changed.
gladys.on('connected', async () => {
  try {
    await app.start(await gladys.getConfig());
  } catch (err) {
    logger.error('Start failed', app.scrub(err));
  }
});
gladys.on('disconnected', () => app.stop());
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the SensorPush integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err?.message ?? err);
  process.exit(1);
});
