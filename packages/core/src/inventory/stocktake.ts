export interface StocktakeUnit {
  id: string;
  barcode: string;
  name: string;
  branchId: string | null;
  status: string;
}

export interface StocktakeResult {
  /** Có trong hệ thống (thuộc phạm vi kiểm kê) nhưng không quét được */
  missing: StocktakeUnit[];
  /** Quét được nhưng thuộc chi nhánh khác phạm vi kiểm kê */
  wrongBranch: StocktakeUnit[];
  /** Quét được nhưng hệ thống ghi nhận đang thuê/mất/thanh lý: dữ liệu cần xem lại */
  unexpected: StocktakeUnit[];
  /** Khớp */
  matched: StocktakeUnit[];
}

/** Thiết bị đang cho thuê hoặc đã thanh lý không bắt buộc phải có trong kho. */
const NOT_EXPECTED_IN_STOCK = new Set(['RENTED', 'RESERVED', 'RETIRED', 'LOST']);

/**
 * scope: thiết bị thuộc chi nhánh được kiểm kê (null = toàn bộ).
 * allUnits: mọi thiết bị của tenant (để nhận ra thiết bị quét nhầm chi nhánh).
 */
export function diffStocktake(allUnits: StocktakeUnit[], scannedIds: ReadonlySet<string>, branchId: string | null): StocktakeResult {
  const inScope = (u: StocktakeUnit) => branchId === null || u.branchId === branchId;
  const r: StocktakeResult = { missing: [], wrongBranch: [], unexpected: [], matched: [] };
  for (const u of allUnits) {
    const scanned = scannedIds.has(u.id);
    if (!scanned) {
      if (inScope(u) && !NOT_EXPECTED_IN_STOCK.has(u.status)) r.missing.push(u);
    } else if (!inScope(u)) r.wrongBranch.push(u);
    else if (NOT_EXPECTED_IN_STOCK.has(u.status)) r.unexpected.push(u);
    else r.matched.push(u);
  }
  return r;
}
