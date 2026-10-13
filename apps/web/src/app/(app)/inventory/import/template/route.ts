import { buildTemplate } from '@rentpro/core';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requireAppSession();
  const buf = await buildTemplate();
  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="mau-nhap-thiet-bi.xlsx"',
    },
  });
}
