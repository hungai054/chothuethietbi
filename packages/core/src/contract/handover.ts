export const CONDITIONS = ['GOOD', 'FAIR', 'DAMAGED', 'MISSING'] as const;
export type ItemCondition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<ItemCondition, string> = { GOOD: 'Tốt', FAIR: 'Khá', DAMAGED: 'Hư hỏng', MISSING: 'Mất / không trả' };
const RANK: Record<ItemCondition, number> = { GOOD: 0, FAIR: 1, DAMAGED: 2, MISSING: 3 };

export interface AccessoryCheck { name: string; expected: number; actual: number }
export interface HandoverItemData { key: string; label: string; condition: ItemCondition; accessories: AccessoryCheck[]; notes?: string | null }

export interface HandoverIssue {
  key: string; label: string;
  kind: 'MISSING_ITEM' | 'WORSE_CONDITION' | 'ACCESSORY_SHORT' | 'NOT_RECORDED_AT_DELIVERY';
  detail: string;
}

/**
 * So sánh biên bản giao với biên bản nhận để phát hiện thiếu/hỏng. Chỉ báo VẤN ĐỀ MỚI phát sinh trong thời gian thuê:
 * thiết bị đã ghi nhận hư hỏng lúc giao mà khi nhận vẫn như vậy thì không bị coi là lỗi của khách.
 */
export function compareHandover(delivery: HandoverItemData[], ret: HandoverItemData[]): HandoverIssue[] {
  const issues: HandoverIssue[] = [];
  const d = new Map(delivery.map((x) => [x.key, x]));
  const r = new Map(ret.map((x) => [x.key, x]));
  for (const [key, out] of d) {
    const back = r.get(key);
    if (!back || back.condition === 'MISSING') {
      issues.push({ key, label: out.label, kind: 'MISSING_ITEM', detail: `${out.label}: không được trả lại.` });
      continue;
    }
    if (RANK[back.condition] > RANK[out.condition]) {
      issues.push({ key, label: out.label, kind: 'WORSE_CONDITION', detail: `${out.label}: lúc giao "${CONDITION_LABEL[out.condition]}", lúc nhận "${CONDITION_LABEL[back.condition]}".` });
    }
    for (const a of back.accessories) {
      const was = out.accessories.find((x) => x.name === a.name);
      const given = was ? was.actual : 0;
      if (a.actual < given) issues.push({ key, label: out.label, kind: 'ACCESSORY_SHORT', detail: `${out.label}: thiếu phụ kiện "${a.name}" (giao ${given}, nhận ${a.actual}).` });
    }
  }
  for (const [key, back] of r) if (!d.has(key)) issues.push({ key, label: back.label, kind: 'NOT_RECORDED_AT_DELIVERY', detail: `${back.label}: có khi nhận nhưng không có trong biên bản giao.` });
  return issues;
}
