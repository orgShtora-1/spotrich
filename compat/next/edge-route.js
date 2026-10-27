// OPT-IN ONLY. Next's Edge runtime is deprecated. The harness copies this file
// into app/api/edge/route.js only for the explicit next-edge target.
import { runSmoke } from '../../../smoke.mjs';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Next can inject a limited process/env shim, so this target does not claim
  // absence of Node-shaped globals (the actual Workers and EdgeVM targets do).
  return Response.json(await runSmoke(), { headers: { 'cache-control': 'private, no-store' } });
}
