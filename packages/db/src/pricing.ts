import {
  PRICING_SETTINGS_VERSION, PricingError, PricingSettingsSchema, applyPricingHook, firstZodMessage, quoteRental, resolvePricingConfig, upgradePricingSettings,
  validateRule, type Discount, type PriceRule, type PricingSettings, type Quote, type QuoteInput,
} from '@rentpro/core';
import { NotFoundError, ValidationError, audit, guard, type ServiceCtx } from './service';
import { assertCustomerCanRent } from './customers';

const FEATURE = 'pricing' as const;
const DEFAULT_TZ = 'Asia/Ho_Chi_Minh';

// ===== Cấu hình giá của cửa hàng =====
export async function getPricingSettings(ctx: ServiceCtx): Promise<PricingSettings> {
  guard(ctx, 'pricing.view', FEATURE);
  const r = (await ctx.db.query('SELECT settings FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0];
  return upgradePricingSettings(r?.settings?.pricing);
}

export async function updatePricingSettings(ctx: ServiceCtx, patch: unknown): Promise<PricingSettings> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const parsed = PricingSettingsSchema.safeParse({ v: PRICING_SETTINGS_VERSION, ...(patch as object) });
  if (!parsed.success) throw new ValidationError(firstZodMessage(parsed.error));
  // Lưu phần khác mặc định; trường undefined bị bỏ khi chuyển JSON
  const clean = JSON.parse(JSON.stringify(parsed.data)) as PricingSettings;
  const r = await ctx.db.query(
    `UPDATE tenant SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{pricing}', $2::jsonb, true) WHERE id=$1 RETURNING id`,
    [ctx.tenantId, JSON.stringify(clean)]);
  if (!r.rowCount) throw new NotFoundError('cửa hàng');
  await audit(ctx, 'settings.pricing', 'tenant', ctx.tenantId, clean);
  return clean;
}

export async function loadPricingConfig(ctx: ServiceCtx) {
  const r = (await ctx.db.query('SELECT settings, timezone FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0];
  return resolvePricingConfig(r?.settings?.pricing, r?.timezone ?? ctx.timezone ?? DEFAULT_TZ);
}

// ===== Bảng giá =====
export interface PriceListRow { id: string; name: string; isDefault: boolean; rules: number }

export async function listPriceLists(ctx: ServiceCtx): Promise<PriceListRow[]> {
  guard(ctx, 'pricing.view', FEATURE);
  return (await ctx.db.query(
    `SELECT l.id, l.name, l.is_default AS "isDefault", (SELECT count(*)::int FROM price_rule r WHERE r.price_list_id = l.id) AS rules
     FROM price_list l WHERE l.deleted_at IS NULL ORDER BY l.is_default DESC, l.name`)).rows;
}

/** Bảng giá mặc định được tạo khi cần lần đầu để cửa hàng mới dùng ngay được. */
export async function ensureDefaultPriceList(ctx: ServiceCtx): Promise<string> {
  const ex = (await ctx.db.query('SELECT id FROM price_list WHERE is_default AND deleted_at IS NULL')).rows[0];
  if (ex) return ex.id;
  return (await ctx.db.query("INSERT INTO price_list(tenant_id,name,is_default) VALUES ($1,'Giá niêm yết',true) RETURNING id", [ctx.tenantId])).rows[0].id;
}

export async function createPriceList(ctx: ServiceCtx, name: string): Promise<string> {
  guard(ctx, 'pricing.manage', FEATURE, { write: true });
  if (!name.trim()) throw new ValidationError('Tên bảng giá không được để trống.');
  await ensureDefaultPriceList(ctx);
  const r = await ctx.db.query('INSERT INTO price_list(tenant_id,name) VALUES ($1,$2) RETURNING id', [ctx.tenantId, name.trim()]);
  await audit(ctx, 'price_list.create', 'price_list', r.rows[0].id, { name });
  return r.rows[0].id;
}

export interface RuleRow { modelId: string; modelName: string; rule: PriceRule | null }

export async function listRules(ctx: ServiceCtx, priceListId: string): Promise<RuleRow[]> {
  guard(ctx, 'pricing.view', FEATURE);
  const { rows } = await ctx.db.query(
    `SELECT m.id, m.name, r.hour_price, r.day_price, r.week_price, r.month_price, r.min_hours
     FROM equipment_model m LEFT JOIN price_rule r ON r.model_id = m.id AND r.price_list_id = $1
     WHERE m.deleted_at IS NULL ORDER BY m.name`, [priceListId]);
  return rows.map((r) => ({
    modelId: r.id, modelName: r.name,
    rule: r.day_price === null && r.hour_price === null && r.week_price === null && r.month_price === null ? null
      : { hour: num(r.hour_price), day: num(r.day_price), week: num(r.week_price), month: num(r.month_price), minHours: r.min_hours },
  }));
}

const num = (v: string | null) => (v === null || v === undefined ? null : Number(v));

export async function setRule(ctx: ServiceCtx, priceListId: string, modelId: string, rule: PriceRule): Promise<void> {
  guard(ctx, 'pricing.manage', FEATURE, { write: true });
  const bad = validateRule(rule);
  if (bad) throw new ValidationError(bad);
  const ok = (await ctx.db.query(
    'SELECT 1 FROM price_list l, equipment_model m WHERE l.id=$1 AND l.deleted_at IS NULL AND m.id=$2 AND m.deleted_at IS NULL', [priceListId, modelId])).rowCount;
  if (!ok) throw new NotFoundError('bảng giá hoặc mẫu thiết bị');
  // Sửa giá có hiệu lực cho báo giá mới; đơn đã chốt giữ giá đã lưu trong đơn.
  await ctx.db.query(
    `INSERT INTO price_rule(tenant_id,price_list_id,model_id,hour_price,day_price,week_price,month_price,min_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (price_list_id, model_id) DO UPDATE SET hour_price=EXCLUDED.hour_price, day_price=EXCLUDED.day_price,
       week_price=EXCLUDED.week_price, month_price=EXCLUDED.month_price, min_hours=EXCLUDED.min_hours, updated_at=now()`,
    [ctx.tenantId, priceListId, modelId, rule.hour, rule.day, rule.week, rule.month, rule.minHours]);
  await audit(ctx, 'price_rule.set', 'price_list', priceListId, { modelId, rule });
}

export async function clearRule(ctx: ServiceCtx, priceListId: string, modelId: string): Promise<void> {
  guard(ctx, 'pricing.manage', FEATURE, { write: true });
  await ctx.db.query('DELETE FROM price_rule WHERE price_list_id=$1 AND model_id=$2', [priceListId, modelId]);
  await audit(ctx, 'price_rule.clear', 'price_list', priceListId, { modelId });
}

// ===== Báo giá =====
export interface QuoteRequest {
  customerId?: string | null;
  lines: { modelId: string; qty: number }[];
  start: Date;
  end: Date;
  discount?: Discount | null;
  deliveryFee?: number;
}

/** Dữ liệu đầu vào đã chốt của một báo giá (không gồm thời gian), lưu cùng đơn để gia hạn/trả sớm giữ nguyên bảng giá đã báo cho khách. */
export type PricingInput = Pick<QuoteInput, 'lines' | 'config' | 'discount' | 'deliveryFee'>;
export interface QuoteResult { quote: Quote; priceListName: string; groupName: string | null; usedFallbackFor: string[]; pricingInput: PricingInput }

/**
 * Báo giá: chọn bảng giá theo nhóm khách (nếu có), mẫu nào thiếu giá thì dùng bảng mặc định.
 * Nếu không truyền giảm giá, áp mức giảm của nhóm khách. Khách trong danh sách đen bị từ chối.
 */
export async function quoteForCustomer(ctx: ServiceCtx, req: QuoteRequest): Promise<QuoteResult> {
  guard(ctx, 'pricing.view', FEATURE);
  if (req.lines.length === 0) throw new ValidationError('Chưa chọn thiết bị nào.');
  const defaultList = await ensureDefaultPriceList(ctx);

  let listId = defaultList;
  let groupName: string | null = null;
  let groupDiscount = 0;
  if (req.customerId) {
    const c = await assertCustomerCanRent(ctx, req.customerId);
    if (c.groupId) {
      const g = (await ctx.db.query('SELECT name, discount_percent::float AS pct, price_list_id FROM customer_group WHERE id=$1 AND deleted_at IS NULL', [c.groupId])).rows[0];
      if (g) { groupName = g.name; groupDiscount = g.pct; if (g.price_list_id) listId = g.price_list_id; }
    }
  }
  const listName = (await ctx.db.query('SELECT name FROM price_list WHERE id=$1', [listId])).rows[0]?.name ?? 'Giá niêm yết';

  const ids = req.lines.map((l) => l.modelId);
  const { rows } = await ctx.db.query(
    `SELECT m.id, m.name, r.price_list_id, r.hour_price, r.day_price, r.week_price, r.month_price, r.min_hours
     FROM equipment_model m LEFT JOIN price_rule r ON r.model_id = m.id AND r.price_list_id = ANY($2::uuid[])
     WHERE m.id = ANY($1::uuid[]) AND m.deleted_at IS NULL`, [ids, [listId, defaultList]]);
  const byModel = new Map<string, typeof rows>();
  for (const r of rows) byModel.set(r.id, [...(byModel.get(r.id) ?? []), r]);

  const fallback: string[] = [];
  const lines = req.lines.map((l) => {
    const rs = byModel.get(l.modelId);
    if (!rs) throw new NotFoundError('mẫu thiết bị');
    const own = rs.find((r) => r.price_list_id === listId && r.price_list_id !== null);
    const def = rs.find((r) => r.price_list_id === defaultList);
    const pick = own ?? def;
    if (!pick || (pick.day_price === null && pick.hour_price === null && pick.week_price === null && pick.month_price === null))
      throw new ValidationError(`Mẫu "${rs[0]!.name}" chưa có bảng giá. Hãy nhập giá trong mục Bảng giá.`);
    if (!own && listId !== defaultList) fallback.push(rs[0]!.name);
    return {
      modelId: l.modelId, name: rs[0]!.name, qty: l.qty,
      rule: { hour: num(pick.hour_price), day: num(pick.day_price), week: num(pick.week_price), month: num(pick.month_price), minHours: pick.min_hours } as PriceRule,
    };
  });

  const config = await loadPricingConfig(ctx);
  const discount: Discount | null = req.discount ?? (groupDiscount > 0 ? { type: 'PERCENT', value: groupDiscount, label: `Nhóm ${groupName}: giảm ${groupDiscount}%` } : null);
  try {
    let quote = quoteRental({ lines, start: req.start, end: req.end, config, discount, deliveryFee: req.deliveryFee });
    quote = applyPricingHook(quote, ctx.pricingHook, config, { start: req.start, end: req.end });
    return { quote, priceListName: listName, groupName, usedFallbackFor: fallback, pricingInput: { lines, config, discount, deliveryFee: req.deliveryFee } };
  } catch (e) {
    if (e instanceof PricingError) throw new ValidationError(e.message);
    throw e;
  }
}
