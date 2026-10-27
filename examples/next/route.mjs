import { createPrivateNowPlayingHandler } from '../web/handler.mjs';
import { denyHost } from '../web/host.mjs';

// Copy to app/api/now-playing/route.js, adjust server-only imports, and replace
// denyHost with your session/store/lock adapter. Do not opt this route into cache.
export const runtime = 'nodejs';

export async function GET(request) {
  return createPrivateNowPlayingHandler({ env: process.env, host: denyHost })(request);
}
