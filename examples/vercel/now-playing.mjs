import { createPrivateNowPlayingHandler } from '../web/handler.mjs';
import { denyHost } from '../web/host.mjs';

// Standard Web Handler recipe, e.g. api/now-playing.js in an ESM application.
// Replace denyHost and adjust imports; no deployment is implied by this file.
export async function GET(request) {
  return createPrivateNowPlayingHandler({ env: process.env, host: denyHost })(request);
}
