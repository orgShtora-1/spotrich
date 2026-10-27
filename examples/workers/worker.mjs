import { createPrivateNowPlayingHandler } from '../web/handler.mjs';
import { denyHost } from '../web/host.mjs';

// Replace denyHost with your server-only adapter. env contains private bindings;
// there is deliberately no global refresh token, background poller or listener.
export default {
  async fetch(request, env) {
    return createPrivateNowPlayingHandler({ env, host: denyHost })(request);
  },
};
