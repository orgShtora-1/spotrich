import { createSingleOwnerClient, displayText, reportError } from './shared/single-owner.mjs';

// Long-lived local process only, bounded to 60 seconds. Never call from an
// edge/serverless request expecting a background daemon to survive its response.
try {
  const client = createSingleOwnerClient(process.env);
  const stop = new AbortController();
  const done = new Promise((resolve) => stop.signal.addEventListener('abort', resolve, { once: true }));
  const onStop = () => stop.abort();
  const timer = setTimeout(onStop, 60_000);
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  let unsubscribe = () => {};
  try {
    unsubscribe = client.subscribe((event) => {
      if (event.type === 'update') {
        console.log(displayText(event.snapshot));
        // This is a local estimate, not a new Spotify observation.
        const estimate = client.getProgress(event.snapshot, { staleAfterMs: 15_000 });
        console.log({ estimated: estimate.estimated, stale: estimate.stale, progressMs: estimate.progressMs });
      } else {
        console.error({ error: event.error.code, willRetry: event.willRetry });
        if (!event.willRetry) {
          process.exitCode = 1;
          stop.abort(); // Reauthorize/investigate outside this demo.
        }
      }
    }, { signal: stop.signal });
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    client.destroy();
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
  }
} catch (error) {
  reportError(error);
}
