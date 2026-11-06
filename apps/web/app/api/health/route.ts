import { sql } from '@cloud-work/database';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { await sql`SELECT 1`; return Response.json({ status: 'ok' }); }
  catch { return Response.json({ status: 'unavailable' }, { status: 503 }); }
}
