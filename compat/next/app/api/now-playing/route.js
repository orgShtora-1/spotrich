import { runSmoke } from '../../../smoke.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await runSmoke(), { headers: { 'cache-control': 'private, no-store' } });
}
