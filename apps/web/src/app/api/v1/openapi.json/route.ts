import { buildOpenApi } from '@rentpro/core';
import { hostOf } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

/** Tài liệu OpenAPI công khai (không chứa dữ liệu cửa hàng), sinh từ bảng mô tả endpoint. */
export async function GET(req: Request) {
  const host = hostOf(req.headers);
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return Response.json(buildOpenApi({ baseUrl: host ? `${proto}://${host}` : undefined }), { headers: { 'cache-control': 'public, max-age=300' } });
}
