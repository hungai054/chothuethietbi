'use server';

import { UNIT_STATUS_LABEL } from '@rentpro/core';
import { findUnitByBarcode, scanStocktake, type ScanOutcome } from '@rentpro/db';
import type { ScanResult } from '@/components/scanner';
import { safe, withService } from '@/lib/service';

export async function lookupAction(code: string): Promise<ScanResult> {
  const r = await safe(() => withService((c) => findUnitByBarcode(c, code)));
  if (!r.ok) return { tone: 'error', text: r.error };
  if (!r.data) return { tone: 'error', text: 'Không tìm thấy thiết bị với mã này.' };
  return { tone: 'ok', text: `${r.data.modelName} · ${UNIT_STATUS_LABEL[r.data.status]}`, href: `/inventory/units/${r.data.id}` };
}

const OUTCOME: Record<ScanOutcome, { tone: ScanResult['tone']; text: string }> = {
  MATCHED: { tone: 'ok', text: 'Khớp' },
  DUPLICATE: { tone: 'warn', text: 'Đã quét trước đó' },
  WRONG_BRANCH: { tone: 'warn', text: 'Thuộc chi nhánh khác' },
  UNEXPECTED: { tone: 'warn', text: 'Hệ thống ghi đang thuê/giữ chỗ/mất/thanh lý — cần xem lại' },
  UNKNOWN: { tone: 'error', text: 'Mã không có trong hệ thống' },
};

export async function stocktakeScanAction(stocktakeId: string, code: string): Promise<ScanResult> {
  const r = await safe(() => withService((c) => scanStocktake(c, stocktakeId, code)));
  if (!r.ok) return { tone: 'error', text: r.error };
  const o = OUTCOME[r.data.outcome];
  return { tone: o.tone, text: `${r.data.name ? r.data.name + ' · ' : ''}${o.text}` };
}
