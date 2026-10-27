import { runSmoke } from './smoke.mjs';

addEventListener('fetch', (event) => {
  event.respondWith(runSmoke({ forbidNodeGlobals: true }).then((result) => Response.json(result)));
});
