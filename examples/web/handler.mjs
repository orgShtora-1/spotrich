import { createSpotifyClient } from '@shtora/spotrich';
import { createTokenProvider } from '@shtora/spotrich/oauth';
import { createNowPlayingHandler } from '@shtora/spotrich/http';
import { requiredEnv } from '../shared/env.mjs';
import { denyHost } from './host.mjs';

// A fresh request-scoped client per authorized grant: no user credentials or
// cached snapshots survive in module globals. Stores and locks remain durable.
export function createPrivateNowPlayingHandler({ env, host = denyHost }) {
  return async (request) => {
    let client;
    const handle = createNowPlayingHandler({
      authorize: async (incoming) => {
        const grantKey = await host.authorizeRequest(incoming);
        if (grantKey === null) return null;
        if (typeof grantKey !== 'string' || grantKey.length === 0) {
          throw new Error('The host must supply an authenticated grant binding.');
        }
        const store = await host.tokenStoreFor(grantKey);
        const auth = createTokenProvider({
          mode: 'confidential',
          clientId: requiredEnv(env, 'SPOTIFY_CLIENT_ID'),
          clientSecret: requiredEnv(env, 'SPOTIFY_CLIENT_SECRET'),
          store,
          withRefreshLock: (operation) => host.withGrantLock(grantKey, operation),
        });
        client = createSpotifyClient({ auth, timeoutMs: 8_000 });
        return client;
      },
    });
    try {
      return await handle(request);
    } finally {
      client?.destroy(); // No persistent polling or cache in this serverless recipe.
    }
  };
}
