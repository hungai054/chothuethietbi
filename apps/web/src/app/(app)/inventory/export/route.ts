import { exportUnits } from '@rentpro/db';
import { isUserError, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const buf = await withService((c) => exportUnits(c));
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="thiet-bi.xlsx"', 'cache-control': 'no-store',
      },
    });
  } catch (e) {
    if (isUserError(e)) return new Response(e.message, { status: 403 });
    throw e;
  }
}
