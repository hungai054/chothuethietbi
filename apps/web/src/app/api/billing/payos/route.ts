import { BillingProviderError } from '@rentpro/billing';
import { PlatformError, SYSTEM_ACTOR, markInvoicePaid } from '@rentpro/db';
import { billingProviders, platformPool } from '@/lib/platform';

export const dynamic = 'force-dynamic';

/**
 * Webhook PayOS: xác thực chữ ký HMAC, rồi ghi nhận hóa đơn (idempotent theo mã giao dịch).
 * Chữ ký sai → 400. Hóa đơn không khớp/đã hủy/sai số tiền → vẫn trả 200 (đã ghi audit để quản trị viên xem), tránh PayOS gọi lại vô hạn.
 */
export async function POST(req: Request) {
  const { payos } = billingProviders();
  if (!payos) return Response.json({ ok: false, error: 'PayOS chưa được cấu hình.' }, { status: 404 });
  const raw = await req.text();
  let notice;
  try {
    notice = payos.parseWebhook(raw);
  } catch (e) {
    if (e instanceof BillingProviderError) return Response.json({ ok: false, error: e.message }, { status: 400 });
    throw e;
  }
  if (!notice) return Response.json({ ok: true, ignored: true });
  try {
    const r = await markInvoicePaid(platformPool(), SYSTEM_ACTOR, {
      orderCode: notice.orderCode, by: 'payos', provider: 'PAYOS', eventId: notice.eventId, amount: notice.amount, paidAt: notice.paidAt,
    });
    return Response.json({ ok: true, already: r.already });
  } catch (e) {
    if (e instanceof PlatformError) return Response.json({ ok: false, error: e.message });
    throw e;
  }
}
