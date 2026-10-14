import { ValidationError, audit, guard, type ServiceCtx } from './service';
import { can } from '@rentpro/tenancy';
import { INDUSTRY_TEMPLATES, templateByKey, type IndustryTemplate } from '@rentpro/core';
import { ensureDefaultPriceList, setRule } from './pricing';
import { createCategory, createModel } from './inventory';

/** Trình hướng dẫn khởi tạo cho cửa hàng mới: nạp danh mục mẫu theo ngành và danh sách việc cần làm tự nhận biết theo dữ liệu thật. */

export const listIndustryTemplates = (): { key: string; name: string; description: string; models: number }[] =>
  INDUSTRY_TEMPLATES.map((t: IndustryTemplate) => ({ key: t.key, name: t.name, description: t.description, models: t.models.length }));

export interface TemplateResult { created: number; skipped: number; priced: number }

/**
 * Nạp mẫu thiết bị + danh mục + giá gợi ý của một ngành. Chạy lại được: mẫu trùng tên (không phân biệt hoa thường) bị bỏ qua,
 * danh mục dùng lại theo tên. Không tạo thiết bị cụ thể (cửa hàng nhập từ Excel hoặc thêm tay) nên không đụng hạn mức thiết bị.
 */
export async function applyIndustryTemplate(ctx: ServiceCtx, key: string): Promise<TemplateResult> {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  const t = templateByKey(key);
  if (!t) throw new ValidationError('Không có mẫu ngành này.');
  const pricing = can(ctx.features, 'pricing') && ctx.permissions.has('pricing.manage');
  const listId = pricing ? await ensureDefaultPriceList(ctx) : null;

  const cats = new Map<string, string>((await ctx.db.query('SELECT id, lower(name) AS n FROM category WHERE deleted_at IS NULL')).rows.map((r: { id: string; n: string }) => [r.n, r.id]));
  const existing = new Set<string>((await ctx.db.query('SELECT lower(name) AS n FROM equipment_model WHERE deleted_at IS NULL')).rows.map((r: { n: string }) => r.n));
  const out: TemplateResult = { created: 0, skipped: 0, priced: 0 };
  for (const m of t.models) {
    if (existing.has(m.name.toLowerCase())) { out.skipped++; continue; }
    let categoryId = cats.get(m.category.toLowerCase());
    if (!categoryId) {
      categoryId = await createCategory(ctx, { name: m.category });
      cats.set(m.category.toLowerCase(), categoryId);
    }
    const modelId = await createModel(ctx, {
      name: m.name, brand: m.brand ?? null, categoryId, barcodePrefix: m.prefix, compensationValue: m.compensation,
      bufferMinutes: m.bufferMinutes ?? 0, tracked: m.tracked ?? true, stockQty: m.tracked === false ? 1 : 0,
    });
    out.created++;
    if (listId) { await setRule(ctx, listId, modelId, m.price); out.priced++; }
  }
  await audit(ctx, 'onboarding.template', 'tenant', ctx.tenantId, { key, ...out });
  return out;
}

export interface OnboardingStep { key: 'shop' | 'bank' | 'catalog' | 'units' | 'pricing' | 'team'; done: boolean }

/** Việc cần làm khi mới dùng, nhận biết từ dữ liệu thật (không lưu cờ riêng nên không bao giờ lệch). */
export async function onboardingStatus(ctx: ServiceCtx): Promise<{ steps: OnboardingStep[]; done: number; total: number; complete: boolean }> {
  guard(ctx, 'settings.manage', 'inventory');
  const n = async (sql: string) => (await ctx.db.query(sql)).rows[0].n as number;
  const s = (await ctx.db.query('SELECT settings FROM tenant')).rows[0]?.settings?.finance ?? {};
  const steps: OnboardingStep[] = [
    { key: 'shop', done: Boolean(s.store?.name && s.store?.phone && s.store?.address) },
    { key: 'bank', done: Boolean(s.bank?.account) },
    { key: 'catalog', done: (await n('SELECT count(*)::int AS n FROM equipment_model WHERE deleted_at IS NULL')) > 0 },
    { key: 'units', done: (await n('SELECT count(*)::int AS n FROM equipment_unit WHERE deleted_at IS NULL')) > 0 },
    { key: 'pricing', done: (await n('SELECT count(*)::int AS n FROM price_rule')) > 0 },
    { key: 'team', done: (await n('SELECT count(*)::int AS n FROM app_user WHERE active')) > 1 },
  ];
  const done = steps.filter((x) => x.done).length;
  return { steps, done, total: steps.length, complete: done === steps.length };
}
