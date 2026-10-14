import {
  BrandingSchema, DEFAULT_DOC_TEMPLATES, DocTemplatesSchema, FIELD_ENTITIES, LABEL_DEFAULTS, LOGO_MAX_BYTES, MAX_FIELDS_PER_ENTITY, buildContractContent, cleanLabels, coerceValue,
  firstZodMessage, formatFieldValue, resolveBranding, resolveLabels, resolveTemplates, sniffImage, validateCustomValues, validateDocText, validateFieldDef,
  type Branding, type ContractContent, type FieldDef, type FieldEntity, type FieldValue, type Labels, type Permission, type ResolvedBranding, type ResolvedTemplates,
} from '@rentpro/core';
import { can, type FeatureKey } from '@rentpro/tenancy';
import { renderContractTerms, SAMPLE_VARS } from './contract-text';
import { storePhoto } from './finance';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';
import { assertTenantPath, newPrivatePath } from './storage';

type Row = Record<string, any>;

// ===== Trường tùy chỉnh =====
const TABLE: Record<FieldEntity, string> = { UNIT: 'equipment_unit', CUSTOMER: 'customer', BOOKING: 'booking', CONTRACT: 'contract' };
const WRITE: Record<FieldEntity, { perm: Permission; feature: FeatureKey }> = {
  UNIT: { perm: 'inventory.manage', feature: 'inventory' }, CUSTOMER: { perm: 'customer.manage', feature: 'customers' },
  BOOKING: { perm: 'booking.create', feature: 'booking' }, CONTRACT: { perm: 'contract.create', feature: 'contract' },
};
const READ: Record<FieldEntity, { perm: Permission; feature: FeatureKey }> = {
  UNIT: { perm: 'inventory.view', feature: 'inventory' }, CUSTOMER: { perm: 'customer.view', feature: 'customers' },
  BOOKING: { perm: 'booking.view', feature: 'booking' }, CONTRACT: { perm: 'contract.view', feature: 'contract' },
};

const toDef = (r: Row): FieldDef & { id: string } => ({
  id: r.id, entity: r.entity, key: r.key, label: r.label, kind: r.kind, required: r.required, options: r.options, showInList: r.show_in_list,
  searchable: r.searchable, inContract: r.in_contract, sort: r.sort, active: r.active,
});

/** Định nghĩa trường. Gói không có tính năng trường tùy chỉnh thì trả rỗng (giao diện tự ẩn mà không cần kiểm tra riêng). */
export async function listFieldDefs(ctx: ServiceCtx, entity?: FieldEntity, opts: { includeInactive?: boolean } = {}): Promise<(FieldDef & { id: string })[]> {
  if (!can(ctx.features, 'custom_fields')) return [];
  const rows = (await ctx.db.query(
    `SELECT * FROM custom_field_def WHERE ($1::text IS NULL OR entity=$1) AND ($2::boolean OR active) ORDER BY entity, sort, created_at`, [entity ?? null, !!opts.includeInactive])).rows;
  return rows.map(toDef);
}

export interface FieldDefInput {
  entity: FieldEntity; key: string; label: string; kind: FieldDef['kind']; required?: boolean; options?: string[]; showInList?: boolean; searchable?: boolean; inContract?: boolean;
}

export async function createFieldDef(ctx: ServiceCtx, i: FieldDefInput): Promise<string> {
  guard(ctx, 'settings.manage', 'custom_fields', { write: true });
  const def: FieldDef = {
    entity: i.entity, key: i.key.trim(), label: i.label.trim(), kind: i.kind, required: !!i.required, options: (i.options ?? []).map((o) => o.trim()).filter(Boolean),
    showInList: !!i.showInList, searchable: !!i.searchable, inContract: !!i.inContract, sort: 0, active: true,
  };
  const bad = validateFieldDef(def);
  if (bad) throw new ValidationError(bad);
  const n = (await ctx.db.query('SELECT count(*)::int n, coalesce(max(sort),0)::int m FROM custom_field_def WHERE entity=$1', [def.entity])).rows[0];
  if (n.n >= MAX_FIELDS_PER_ENTITY) throw new ValidationError(`Mỗi đối tượng tối đa ${MAX_FIELDS_PER_ENTITY} trường tùy chỉnh (kể cả trường đã tắt).`);
  try {
    const r = await ctx.db.query(
      `INSERT INTO custom_field_def(tenant_id,entity,key,label,kind,required,options,show_in_list,searchable,in_contract,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ctx.tenantId, def.entity, def.key, def.label, def.kind, def.required, JSON.stringify(def.options), def.showInList, def.searchable, def.inContract, n.m + 1]);
    await audit(ctx, 'customfield.create', 'custom_field_def', r.rows[0].id, { entity: def.entity, key: def.key, kind: def.kind });
    return r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ValidationError(`Mã trường "${def.key}" đã tồn tại ở ${def.entity === 'UNIT' ? 'thiết bị' : def.entity === 'CUSTOMER' ? 'khách hàng' : def.entity === 'BOOKING' ? 'đơn thuê' : 'hợp đồng'}.`);
    throw e;
  }
}

/** Sửa định nghĩa. Không đổi được mã, kiểu và đối tượng (giá trị đã lưu phụ thuộc vào đó). Trường đã có dữ liệu chỉ tắt, không xóa. */
export async function updateFieldDef(ctx: ServiceCtx, id: string, p: Partial<Pick<FieldDefInput, 'label' | 'required' | 'options' | 'showInList' | 'searchable' | 'inContract'>> & { active?: boolean; sort?: number }): Promise<void> {
  guard(ctx, 'settings.manage', 'custom_fields', { write: true });
  const cur = (await ctx.db.query('SELECT * FROM custom_field_def WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw new NotFoundError('trường tùy chỉnh');
  const next: FieldDef = {
    ...toDef(cur), label: p.label?.trim() ?? cur.label, required: p.required ?? cur.required, options: p.options ? p.options.map((o) => o.trim()).filter(Boolean) : cur.options,
    showInList: p.showInList ?? cur.show_in_list, searchable: p.searchable ?? cur.searchable, inContract: p.inContract ?? cur.in_contract, active: p.active ?? cur.active, sort: p.sort ?? cur.sort,
  };
  const bad = validateFieldDef(next);
  if (bad) throw new ValidationError(bad);
  await ctx.db.query(
    `UPDATE custom_field_def SET label=$2, required=$3, options=$4, show_in_list=$5, searchable=$6, in_contract=$7, active=$8, sort=$9 WHERE id=$1`,
    [id, next.label, next.required, JSON.stringify(next.options), next.showInList, next.searchable, next.inContract, next.active, next.sort]);
  await audit(ctx, 'customfield.update', 'custom_field_def', id, { key: cur.key, active: next.active });
}

async function requireEntityRow(ctx: ServiceCtx, entity: FieldEntity, id: string): Promise<Row> {
  const r = (await ctx.db.query(`SELECT id, custom_fields FROM ${TABLE[entity]} WHERE id=$1 ${entity === 'CONTRACT' ? '' : 'AND deleted_at IS NULL'} FOR UPDATE`, [id])).rows[0];
  if (!r) throw new NotFoundError(entity === 'UNIT' ? 'thiết bị' : entity === 'CUSTOMER' ? 'khách hàng' : entity === 'BOOKING' ? 'đơn thuê' : 'hợp đồng');
  return r;
}

/** Kiểm tra giá trị nhập theo định nghĩa, không ghi gì. Dùng để chặn trước khi tạo bản ghi chính. */
export async function validateFieldValues(ctx: ServiceCtx, entity: FieldEntity, values: Record<string, unknown>, creating: boolean): Promise<Record<string, FieldValue>> {
  const defs = await listFieldDefs(ctx, entity);
  const v = validateCustomValues(defs, values, creating);
  if (v.errors.length) throw new ValidationError(v.errors.join(' '));
  return v.clean;
}

/**
 * Ghi giá trị trường tùy chỉnh cho một bản ghi. Gọi trong CÙNG giao dịch với lệnh tạo bản ghi để trường bắt buộc không bao giờ bị bỏ sót.
 * Trường được gửi lên nhưng để trống thì bị xóa giá trị (nếu không bắt buộc). Giá trị tệp đính kèm chỉ đổi qua setCustomFile.
 */
export async function setCustomValues(ctx: ServiceCtx, entity: FieldEntity, id: string, values: Record<string, unknown>, creating = false): Promise<void> {
  if (!(FIELD_ENTITIES as readonly string[]).includes(entity)) throw new ValidationError('Đối tượng không hợp lệ.');
  if (Object.keys(values).length === 0 && !can(ctx.features, 'custom_fields')) return; // gói không có trường tùy chỉnh: không có gì để ghi hay bắt buộc
  guard(ctx, WRITE[entity].perm, 'custom_fields', { write: true });
  guard(ctx, WRITE[entity].perm, WRITE[entity].feature, { write: true });
  const defs = await listFieldDefs(ctx, entity);
  if (defs.length === 0 && Object.keys(values).length === 0) return;
  const fileKeys = new Set(defs.filter((d) => d.kind === 'FILE').map((d) => d.key));
  const sent = Object.fromEntries(Object.entries(values).filter(([k]) => !fileKeys.has(k)));
  if (creating) for (const d of defs) if (d.kind === 'FILE' && d.required) throw new ValidationError(`"${d.label}" là tệp bắt buộc: hãy tạo xong rồi đính kèm tệp ở trang chi tiết (hoặc bỏ yêu cầu bắt buộc).`);
  const v = validateCustomValues(defs.filter((d) => d.kind !== 'FILE'), sent, creating);
  if (v.errors.length) throw new ValidationError(v.errors.join(' '));
  const row = await requireEntityRow(ctx, entity, id);
  const next: Record<string, unknown> = { ...(row.custom_fields as Record<string, unknown>), ...v.clean };
  for (const k of Object.keys(sent)) if (!(k in v.clean)) delete next[k]; // gửi trống = xóa giá trị
  await ctx.db.query(`UPDATE ${TABLE[entity]} SET custom_fields=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
  await audit(ctx, 'customfield.set', TABLE[entity], id, { keys: Object.keys(v.clean) });
}

/** Đính kèm tệp (ảnh) vào trường kiểu tệp. */
export async function setCustomFile(ctx: ServiceCtx, entity: FieldEntity, id: string, key: string, file: { data: Uint8Array; name: string } | null): Promise<void> {
  guard(ctx, WRITE[entity].perm, 'custom_fields', { write: true });
  const def = (await listFieldDefs(ctx, entity)).find((d) => d.key === key && d.kind === 'FILE');
  if (!def) throw new ValidationError('Trường tệp đính kèm không tồn tại hoặc đã bị tắt.');
  const row = await requireEntityRow(ctx, entity, id);
  const cur = (row.custom_fields as Record<string, FieldValue>)[key] as { path: string } | undefined;
  const next = { ...(row.custom_fields as Record<string, unknown>) };
  if (file) {
    if (file.name.length > 200) throw new ValidationError('Tên tệp quá dài.');
    const path = await storePhoto(ctx, file.data, 'field'); // kiểm tra định dạng ảnh (JPG/PNG/WebP) và dung lượng
    next[key] = coerceValue(def, { path, name: file.name.replace(/[<>"]/g, '').slice(0, 200) || 'tep-dinh-kem' });
  } else {
    if (def.required) throw new ValidationError(`"${def.label}" là trường bắt buộc, không xóa được.`);
    delete next[key];
  }
  await ctx.db.query(`UPDATE ${TABLE[entity]} SET custom_fields=$2 WHERE id=$1`, [id, JSON.stringify(next)]);
  if (cur?.path) { assertTenantPath(ctx.tenantId, cur.path); await need(ctx.storage, 'storage').delete(cur.path); }
  await audit(ctx, 'customfield.file', TABLE[entity], id, { key, removed: !file });
}

export async function getCustomFile(ctx: ServiceCtx, entity: FieldEntity, id: string, key: string) {
  guard(ctx, READ[entity].perm, READ[entity].feature);
  const r = (await ctx.db.query(`SELECT custom_fields FROM ${TABLE[entity]} WHERE id=$1`, [id])).rows[0];
  const v = r?.custom_fields?.[key] as { path?: string } | undefined;
  if (!v?.path) throw new NotFoundError('tệp');
  assertTenantPath(ctx.tenantId, v.path);
  const f = await need(ctx.storage, 'storage').get(v.path);
  if (!f) throw new NotFoundError('tệp');
  return f;
}

/** Giá trị trường tùy chỉnh của nhiều bản ghi (để hiện cột trong danh sách và xuất Excel). */
export async function customValuesFor(ctx: ServiceCtx, entity: FieldEntity, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!can(ctx.features, 'custom_fields') || ids.length === 0) return new Map();
  guard(ctx, READ[entity].perm, READ[entity].feature);
  const rows = (await ctx.db.query(`SELECT id, custom_fields FROM ${TABLE[entity]} WHERE id = ANY($1::uuid[])`, [ids])).rows;
  return new Map(rows.map((r: Row) => [r.id, r.custom_fields]));
}

/** Mã các trường tìm kiếm được (dùng ghép vào điều kiện tìm kiếm của danh sách). */
export async function searchableKeys(ctx: ServiceCtx, entity: FieldEntity): Promise<string[]> {
  return (await listFieldDefs(ctx, entity)).filter((d) => d.searchable).map((d) => d.key);
}

export const formatCustom = (defs: FieldDef[], values: Record<string, unknown> | undefined, key: string) => {
  const d = defs.find((x) => x.key === key);
  return d ? formatFieldValue(d, values?.[key]) : '';
};

// ===== Cấu hình trong tenant.settings =====
async function rawSettings(ctx: ServiceCtx): Promise<Row> {
  return (await ctx.db.query('SELECT settings FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0]?.settings ?? {};
}
const putSetting = (ctx: ServiceCtx, key: string, value: unknown) =>
  value === null
    ? ctx.db.query(`UPDATE tenant SET settings = coalesce(settings,'{}'::jsonb) - $2 WHERE id=$1`, [ctx.tenantId, key])
    : ctx.db.query(`UPDATE tenant SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), ARRAY[$2]::text[], $3::jsonb, true) WHERE id=$1`, [ctx.tenantId, key, JSON.stringify(value)]);

// ===== Nhãn và thuật ngữ =====
export async function getLabels(ctx: ServiceCtx): Promise<{ labels: Labels; custom: Partial<Labels> }> {
  const s = await rawSettings(ctx);
  return { labels: resolveLabels(s.labels), custom: (s.labels as Partial<Labels> | undefined) ?? {} };
}

export async function updateLabels(ctx: ServiceCtx, input: Record<string, string>): Promise<void> {
  guard(ctx, 'settings.manage', 'booking', { write: true });
  let clean: Partial<Labels>;
  try { clean = cleanLabels(input); } catch (e) { throw new ValidationError((e as Error).message); }
  await putSetting(ctx, 'labels', Object.keys(clean).length ? clean : null);
  await audit(ctx, 'settings.labels', 'tenant', ctx.tenantId, clean);
}

// ===== Mẫu tài liệu =====
export async function getDocTemplates(ctx: ServiceCtx): Promise<{ resolved: ResolvedTemplates; custom: Record<string, unknown> }> {
  const s = await rawSettings(ctx);
  return { resolved: resolveTemplates(s.templates), custom: (s.templates as Record<string, unknown> | undefined) ?? {} };
}

export interface TemplatesInput {
  contract?: { title: string; terms: string[] } | null;
  receipt?: { title: string; footer: string } | null;
  handover?: { title: string; footer: string } | null;
}

/** null = quay về mẫu mặc định cho tài liệu đó. Điều khoản kiểm tra biến hợp lệ (gồm biến trường tùy chỉnh). */
export async function updateDocTemplates(ctx: ServiceCtx, i: TemplatesInput): Promise<void> {
  guard(ctx, 'settings.manage', 'contract', { write: true });
  const keys = (await listFieldDefs(ctx)).map((d) => d.key);
  const cur = { ...(((await rawSettings(ctx)).templates as Record<string, unknown> | undefined) ?? {}) };
  for (const k of ['contract', 'receipt', 'handover'] as const) {
    if (i[k] === undefined) continue;
    if (i[k] === null) { delete cur[k]; continue; }
    cur[k] = i[k];
  }
  const p = DocTemplatesSchema.safeParse({ v: 1, ...cur });
  if (!p.success) throw new ValidationError(firstZodMessage(p.error));
  for (const [n, t] of (p.data.contract?.terms ?? []).entries()) {
    const bad = validateDocText(t, keys.map((k) => k));
    if (bad) throw new ValidationError(`Điều khoản ${n + 1}: ${bad}`);
  }
  for (const k of ['receipt', 'handover'] as const) {
    const f = p.data[k]?.footer;
    if (f) { const bad = validateDocText(f, keys, 300); if (bad) throw new ValidationError(`Chân trang ${k === 'receipt' ? 'phiếu thu' : 'biên bản'}: ${bad}`); }
  }
  const docs = Object.keys(cur).filter((k) => k !== 'v');
  await putSetting(ctx, 'templates', docs.length ? p.data : null);
  await audit(ctx, 'settings.templates', 'tenant', ctx.tenantId, { documents: docs });
}

/** Xem trước hợp đồng với dữ liệu mẫu theo mẫu đang soạn (chưa lưu). */
export async function previewContract(ctx: ServiceCtx, draft?: { title: string; terms: string[] }): Promise<ContractContent> {
  guard(ctx, 'settings.manage', 'contract');
  const t = draft ?? (await getDocTemplates(ctx)).resolved.contract;
  const keys = (await listFieldDefs(ctx)).map((d) => d.key);
  for (const [n, x] of t.terms.entries()) { const bad = validateDocText(x, keys); if (bad) throw new ValidationError(`Điều khoản ${n + 1}: ${bad}`); }
  const store = (await ctx.db.query('SELECT name FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0]?.name ?? 'Cửa hàng';
  return buildContractContent({
    number: 'HD-XXXX-00001', date: new Date(), timeZone: ctx.timezone ?? 'Asia/Ho_Chi_Minh', title: t.title, store: { name: store },
    customer: { type: 'PERSON', name: 'Nguyễn Văn A', phone: '0901234567' },
    booking: { code: 'DT-XXXX-00001', start: new Date(), end: new Date(Date.now() + 86_400_000) },
    items: [{ name: 'Máy ảnh Sony A7', qty: 1, units: ['CAM-000001'], lineTotal: 500_000 }], rentTotal: 500_000, depositRequired: 1_000_000,
    terms: renderContractTerms(t.terms, { ...SAMPLE_VARS, ten_cua_hang: store }),
  });
}

// ===== Thương hiệu (white-label) =====
export async function getBranding(ctx: ServiceCtx): Promise<{ resolved: ResolvedBranding; raw: Branding }> {
  const s = await rawSettings(ctx);
  const wl = can(ctx.features, 'white_label');
  const p = s.branding && typeof s.branding === 'object' ? BrandingSchema.safeParse({ v: 1, ...s.branding }) : null;
  return { resolved: resolveBranding(s.branding, wl), raw: p?.success ? p.data : { v: 1 } };
}

export interface BrandingInput {
  displayName?: string; primaryColor?: string; emailFromName?: string; footerText?: string; hideProductBrand?: boolean;
  logo?: Uint8Array | null; favicon?: Uint8Array | null;
}

async function storeBrandImage(ctx: ServiceCtx, data: Uint8Array, label: string, max: number): Promise<string> {
  if (data.byteLength === 0) throw new ValidationError(`${label} trống.`);
  if (data.byteLength > max) throw new ValidationError(`${label} quá lớn (tối đa ${Math.round(max / 1024)} KB).`);
  const kind = sniffImage(data);
  if (!kind) throw new ValidationError(`${label} phải là ảnh JPG, PNG hoặc WebP.`); // không nhận SVG: có thể chứa script
  const path = newPrivatePath(ctx.tenantId, 'brand', kind.ext);
  await need(ctx.storage, 'storage').put(path, data, kind.mime);
  return path;
}

/** Cập nhật thương hiệu. `logo`/`favicon`: byte ảnh mới, null = xóa, bỏ trống = giữ nguyên. File cũ được xóa khi thay. */
export async function updateBranding(ctx: ServiceCtx, i: BrandingInput): Promise<void> {
  guard(ctx, 'settings.manage', 'white_label', { write: true });
  const cur = (await getBranding(ctx)).raw;
  const next: Record<string, unknown> = { ...cur, v: 1 };
  const set = (k: keyof Branding, v: string | boolean | undefined) => { if (v === undefined || v === '' || v === false) delete next[k]; else next[k] = v; };
  if (i.displayName !== undefined) set('displayName', i.displayName.trim());
  if (i.primaryColor !== undefined) set('primaryColor', i.primaryColor.trim());
  if (i.emailFromName !== undefined) set('emailFromName', i.emailFromName.trim());
  if (i.footerText !== undefined) set('footerText', i.footerText.trim());
  if (i.hideProductBrand !== undefined) set('hideProductBrand', i.hideProductBrand);
  const stale: string[] = [];
  const fresh: string[] = [];
  try {
    for (const [key, field, label, max] of [['logo', 'logoPath', 'Logo', LOGO_MAX_BYTES], ['favicon', 'faviconPath', 'Favicon', 256 * 1024]] as const) {
      const v = i[key];
      if (v === undefined) continue;
      if (cur[field]) stale.push(cur[field]!);
      if (v === null) delete next[field];
      else { const p = await storeBrandImage(ctx, v, label, max); fresh.push(p); next[field] = p; }
    }
    const p = BrandingSchema.safeParse(next);
    if (!p.success) throw new ValidationError(firstZodMessage(p.error));
    await putSetting(ctx, 'branding', p.data);
  } catch (e) {
    for (const f of fresh) await need(ctx.storage, 'storage').delete(f).catch(() => undefined); // thất bại không để lại file mồ côi
    throw e;
  }
  for (const f of stale) { assertTenantPath(ctx.tenantId, f); await need(ctx.storage, 'storage').delete(f).catch(() => undefined); }
  await audit(ctx, 'settings.branding', 'tenant', ctx.tenantId, { displayName: i.displayName, primaryColor: i.primaryColor, logo: i.logo === undefined ? 'giữ' : i.logo === null ? 'xóa' : 'mới' });
}

/** Ảnh thương hiệu cho trang công khai (đăng nhập, in). Không kiểm tra quyền: logo vốn là thông tin công khai của cửa hàng; chỉ phục vụ khi gói có white-label. */
export async function readBrandAsset(ctx: Pick<ServiceCtx, 'db' | 'tenantId' | 'features' | 'storage'>, which: 'logo' | 'favicon') {
  if (!can(ctx.features, 'white_label')) return null;
  const s = (await ctx.db.query('SELECT settings->\'branding\' AS b FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0]?.b as Branding | null | undefined;
  const path = which === 'logo' ? s?.logoPath : s?.faviconPath;
  if (!path) return null;
  assertTenantPath(ctx.tenantId, path);
  return need(ctx.storage, 'storage').get(path);
}

export { LABEL_DEFAULTS, DEFAULT_DOC_TEMPLATES };

/** Cột trường tùy chỉnh cho danh sách (chỉ trường bật "hiện trong danh sách"): dữ liệu đã định dạng sẵn, dùng thẳng trong bảng. */
export async function listColumnsData(ctx: ServiceCtx, entity: FieldEntity, ids: string[]): Promise<{ cols: { key: string; label: string }[]; cells: Record<string, Record<string, string>> }> {
  const defs = (await listFieldDefs(ctx, entity)).filter((d) => d.showInList);
  if (defs.length === 0 || ids.length === 0) return { cols: [], cells: {} };
  const vals = await customValuesFor(ctx, entity, ids);
  const cells: Record<string, Record<string, string>> = {};
  for (const id of ids) cells[id] = Object.fromEntries(defs.map((d) => [d.key, formatFieldValue(d, vals.get(id)?.[d.key])]));
  return { cols: defs.map((d) => ({ key: d.key, label: d.label })), cells };
}
