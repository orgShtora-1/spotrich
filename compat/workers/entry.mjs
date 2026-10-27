import { runSmoke } from './smoke.mjs';

export default {
  async fetch() {
    return Response.json(await runSmoke({ forbidNodeGlobals: true }));
  },
};
