import { createSingleOwnerClient, displayText, reportError } from './shared/single-owner.mjs';

// Run with Node or Bun, on an explicitly authorized account. No HTTP listener.
try {
  const client = createSingleOwnerClient(process.env);
  try {
    const snapshot = await client.getNowPlaying();
    console.log(displayText(snapshot));
  } finally {
    client.destroy();
  }
} catch (error) {
  reportError(error);
}
