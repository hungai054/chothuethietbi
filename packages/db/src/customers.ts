import {
  CustomerInputSchema, ID_DOC_TYPES, ID_IMAGE_MAX_BYTES, PRIVACY_CONSENT_VERSION, firstZodMessage, idLast4, normalizeIdNumber, normalizePhoneVN, sniffImage,
  type CustomerInput, type IdDocType,
} from '@rentpro/core';
import { blindIndex, decryptSecret, encryptSecret } from '@rentpro/tenancy';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';
import { assertTenantPath, newPrivatePath } from './storage';

const FEATURE = 'customers' as const;

function parseCustomer(raw: unknown): CustomerInput {
  const r = CustomerInputSchema.safeParse(raw);
  if (!r.success) throw new ValidationError(firstZodMessage(r.error));
  return r.data;
}

function mapUnique(e: unknown): never {
  const err = e as { code?: string; constraint?: string };
  if (err.code === '23505' && err.constraint === 'customer_tenant_id_phone_key') throw new ValidationError('Số điện thoại này đã thuộc về một khách hàng khác.');
  throw e;
}

export interface CustomerRow {
  id: string; type: 'PERSON' | 'COMPANY'; name: string; phone: string; email: string | null; address: string | null; zalo: string | null;
  companyName: string | null; taxCode: string | null; representative: string | null; trustLevel: 'NEW' | 'TRUSTED' | 'WATCH';
  blacklisted: boolean; blacklistReason: string | null; groupId: string | null; groupName: string | null; notes: string | null; anonymizedAt: Date | null;
}

const SELECT = `c.id, c.type, c.name, c.phone, c.email, c.address, c.zalo, c.company_name, c.tax_code, c.representative, c.trust_level,
  c.blacklisted, c.blacklist_reason, c.group_id, g.name AS group_name, c.notes, c.anonymized_at
  FROM customer c LEFT JOIN customer_group g ON g.id = c.group_id`;

const toRow = (r: Record<string, any>): CustomerRow => ({
  id: r.id, type: r.type, name: r.name, phone: r.phone, email: r.email, address: r.address, zalo: r.zalo, companyName: r.company_name,
  taxCode: r.tax_code, representative: r.representative, trustLevel: r.trust_level, blacklisted: r.blacklisted, blacklistReason: r.blacklist_reason,
  groupId: r.group_id, groupName: r.group_name, notes: r.notes, anonymizedAt: r.anonymized_at,
});

const insertValues = (i: CustomerInput) => [
  i.type, i.name, i.phone, i.email ?? null, i.address ?? null, i.zalo ?? null, i.companyName ?? null, i.taxCode ?? null,
  i.representative ?? null, i.trustLevel, i.groupId ?? null, i.notes ?? null,
];

export async function createCustomer(ctx: ServiceCtx, raw: unknown): Promise<string> {
  guard(ctx, 'customer.manage', FEATURE, { write: true });
  const i = parseCustomer(raw);
  try {
    const r = await ctx.db.query(
      `INSERT INTO customer(tenant_id,type,name,phone,email,address,zalo,company_name,tax_code,representative,trust_level,group_id,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [ctx.tenantId, ...insertValues(i)]);
    await audit(ctx, 'customer.create', 'customer', r.rows[0].id, { name: i.name });
    return r.rows[0].id;
  } catch (e) { return mapUnique(e); }
}

export async function updateCustomer(ctx: ServiceCtx, id: string, raw: unknown): Promise<void> {
  guard(ctx, 'customer.manage', FEATURE, { write: true });
  const i = parseCustomer(raw);
  try {
    const r = await ctx.db.query(
      `UPDATE customer SET type=$2, name=$3, phone=$4, email=$5, address=$6, zalo=$7, company_name=$8, tax_code=$9, representative=$10,
         trust_level=$11, group_id=$12, notes=$13 WHERE id=$1 AND deleted_at IS NULL AND anonymized_at IS NULL RETURNING id`, [id, ...insertValues(i)]);
    if (!r.rowCount) throw new NotFoundError('khách hàng');
    await audit(ctx, 'customer.update', 'customer', id, { name: i.name });
  } catch (e) { if (e instanceof NotFoundError) throw e; mapUnique(e); }
}

export async function setBlacklist(ctx: ServiceCtx, id: string, blacklisted: boolean, reason?: string): Promise<void> {
  guard(ctx, 'customer.manage', FEATURE, { write: true });
  if (blacklisted && !reason?.trim()) throw new ValidationError('Vui lòng nhập lý do đưa vào danh sách đen.');
  const r = await ctx.db.query('UPDATE customer SET blacklisted=$2, blacklist_reason=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id',
    [id, blacklisted, blacklisted ? reason!.trim() : null]);
  if (!r.rowCount) throw new NotFoundError('khách hàng');
  await audit(ctx, blacklisted ? 'customer.blacklist' : 'customer.unblacklist', 'customer', id, { reason });
}

export interface CustomerFilter { q?: string; blacklisted?: boolean; groupId?: string; page?: number; pageSize?: number }

export async function listCustomers(ctx: ServiceCtx, f: CustomerFilter = {}): Promise<{ rows: CustomerRow[]; total: number }> {
  guard(ctx, 'customer.view', FEATURE);
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * pageSize;
  const q = f.q?.trim() || null;
  // Tìm theo SĐT: so khớp phần số (bỏ khoảng trắng/dấu), nên "0901 234" tìm ra 0901234567
  const digits = q ? q.replace(/\D/g, '') : '';
  const where = `c.deleted_at IS NULL AND c.anonymized_at IS NULL
    AND ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.company_name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%'
         OR ($2 <> '' AND c.phone LIKE '%' || $2 || '%'))
    AND ($3::boolean IS NULL OR c.blacklisted = $3) AND ($4::uuid IS NULL OR c.group_id = $4)`;
  const args = [q, digits, f.blacklisted ?? null, f.groupId ?? null];
  const total = (await ctx.db.query(`SELECT count(*)::int AS n FROM customer c WHERE ${where}`, args)).rows[0].n;
  const { rows } = await ctx.db.query(`SELECT ${SELECT} WHERE ${where} ORDER BY c.name LIMIT ${pageSize} OFFSET ${offset}`, args);
  return { total, rows: rows.map(toRow) };
}

export interface IdDocSummary {
  id: string; type: IdDocType; last4: string; issuedDate: string | null; issuedPlace: string | null;
  hasFront: boolean; hasBack: boolean; consentAt: Date; consentVersion: string;
}

export async function getCustomer(ctx: ServiceCtx, id: string): Promise<{ customer: CustomerRow; documents: IdDocSummary[] }> {
  guard(ctx, 'customer.view', FEATURE);
  const c = (await ctx.db.query(`SELECT ${SELECT} WHERE c.id=$1 AND c.deleted_at IS NULL`, [id])).rows[0];
  if (!c) throw new NotFoundError('khách hàng');
  const docs = (await ctx.db.query(
    `SELECT id, type, number_last4, issued_date::text AS issued_date, issued_place, front_path, back_path, consent_at, consent_version
     FROM id_document WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id])).rows;
  return {
    customer: toRow(c),
    documents: docs.map((d) => ({ id: d.id, type: d.type, last4: d.number_last4, issuedDate: d.issued_date, issuedPlace: d.issued_place,
      hasFront: !!d.front_path, hasBack: !!d.back_path, consentAt: d.consent_at, consentVersion: d.consent_version })),
  };
}

// ===== Nhóm khách =====
export async function createGroup(ctx: ServiceCtx, input: { name: string; discountPercent?: number; priceListId?: string | null }): Promise<string> {
  guard(ctx, 'customer.manage', FEATURE, { write: true });
  const name = input.name.trim();
  const pct = input.discountPercent ?? 0;
  if (!name) throw new ValidationError('Tên nhóm không được để trống.');
  if (!(pct >= 0 && pct <= 100)) throw new ValidationError('Giảm giá của nhóm phải từ 0 đến 100%.');
  try {
    const r = await ctx.db.query('INSERT INTO customer_group(tenant_id,name,discount_percent,price_list_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [ctx.tenantId, name, pct, input.priceListId ?? null]);
    await audit(ctx, 'customer_group.create', 'customer_group', r.rows[0].id, { name, pct });
    return r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ValidationError('Đã có nhóm khách trùng tên.');
    throw e;
  }
}

export async function listGroups(ctx: ServiceCtx) {
  guard(ctx, 'customer.view', FEATURE);
  return (await ctx.db.query('SELECT id, name, discount_percent::float AS "discountPercent", price_list_id AS "priceListId" FROM customer_group WHERE deleted_at IS NULL ORDER BY name')).rows as
    { id: string; name: string; discountPercent: number; priceListId: string | null }[];
}

// ===== Giấy tờ tùy thân =====
export interface IdImageInput { data: Uint8Array }
export interface AddIdDocInput {
  type: IdDocType; number: string; issuedDate?: string | null; issuedPlace?: string | null;
  consent: boolean; front?: IdImageInput | null; back?: IdImageInput | null;
}

async function storeImage(ctx: ServiceCtx, img: IdImageInput | null | undefined, side: string): Promise<string | null> {
  if (!img || img.data.byteLength === 0) return null;
  if (img.data.byteLength > ID_IMAGE_MAX_BYTES) throw new ValidationError(`Ảnh mặt ${side} quá lớn (tối đa 5 MB).`);
  const kind = sniffImage(img.data);
  if (!kind) throw new ValidationError(`Ảnh mặt ${side} phải là JPG, PNG hoặc WebP.`);
  const path = newPrivatePath(ctx.tenantId, 'id', kind.ext);
  await need(ctx.storage, 'storage').put(path, img.data, kind.mime);
  return path;
}

export async function addIdDocument(ctx: ServiceCtx, customerId: string, input: AddIdDocInput): Promise<string> {
  guard(ctx, 'customer.manage', FEATURE, { write: true });
  const ring = need(ctx.keyRing, 'keyRing');
  if (!input.consent) throw new ValidationError('Cần xác nhận khách đồng ý cho cửa hàng xử lý dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP).');
  if (!ID_DOC_TYPES.includes(input.type)) throw new ValidationError('Loại giấy tờ không hợp lệ.');
  const number = normalizeIdNumber(input.type, input.number);
  if (!number) throw new ValidationError('Số giấy tờ không hợp lệ cho loại đã chọn.');
  if (input.issuedDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.issuedDate)) throw new ValidationError('Ngày cấp phải có dạng yyyy-mm-dd.');
  const cust = (await ctx.db.query('SELECT id FROM customer WHERE id=$1 AND deleted_at IS NULL AND anonymized_at IS NULL', [customerId])).rows[0];
  if (!cust) throw new NotFoundError('khách hàng');

  const hash = blindIndex(number, `${ctx.tenantId}:${input.type}`, ring);
  const dup = (await ctx.db.query(
    `SELECT c.name FROM id_document d JOIN customer c ON c.id = d.customer_id
     WHERE d.number_hash=$1 AND d.deleted_at IS NULL AND d.customer_id <> $2 LIMIT 1`, [hash, customerId])).rows[0];
  if (dup) throw new ValidationError(`Giấy tờ này đã được đăng ký cho khách "${dup.name}".`);

  const stored: string[] = [];
  try {
    const front = await storeImage(ctx, input.front, 'trước');
    if (front) stored.push(front);
    const back = await storeImage(ctx, input.back, 'sau');
    if (back) stored.push(back);
    const r = await ctx.db.query(
      `INSERT INTO id_document(tenant_id,customer_id,type,number_enc,number_last4,number_hash,issued_date,issued_place,front_path,back_path,
         consent_at,consent_version,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12) RETURNING id`,
      [ctx.tenantId, customerId, input.type, encryptSecret(number, ring), idLast4(number), hash, input.issuedDate || null, input.issuedPlace?.trim() || null,
        front, back, PRIVACY_CONSENT_VERSION, ctx.userId]);
    await audit(ctx, 'id_document.add', 'customer', customerId, { type: input.type, documentId: r.rows[0].id });
    return r.rows[0].id;
  } catch (e) {
    // Không để lại ảnh mồ côi khi ghi DB thất bại
    await Promise.all(stored.map((p) => ctx.storage!.delete(p).catch(() => undefined)));
    throw e;
  }
}

async function loadDoc(ctx: ServiceCtx, documentId: string) {
  const d = (await ctx.db.query('SELECT * FROM id_document WHERE id=$1 AND deleted_at IS NULL', [documentId])).rows[0];
  if (!d) throw new NotFoundError('giấy tờ');
  return d;
}

const logAccess = (ctx: ServiceCtx, documentId: string, action: 'VIEW_NUMBER' | 'VIEW_FRONT' | 'VIEW_BACK') =>
  ctx.db.query('INSERT INTO id_document_access_log(tenant_id,document_id,user_id,action) VALUES ($1,$2,$3,$4)', [ctx.tenantId, documentId, ctx.userId, action]);

/** Hiện số giấy tờ đầy đủ: cần quyền riêng và luôn ghi nhật ký. */
export async function revealIdNumber(ctx: ServiceCtx, documentId: string): Promise<string> {
  guard(ctx, 'customer.id_document.view', FEATURE);
  const d = await loadDoc(ctx, documentId);
  await logAccess(ctx, documentId, 'VIEW_NUMBER');
  return decryptSecret(d.number_enc, need(ctx.keyRing, 'keyRing'));
}

export async function getIdImage(ctx: ServiceCtx, documentId: string, side: 'front' | 'back') {
  guard(ctx, 'customer.id_document.view', FEATURE);
  const d = await loadDoc(ctx, documentId);
  const path: string | null = side === 'front' ? d.front_path : d.back_path;
  if (!path) throw new NotFoundError('ảnh giấy tờ');
  assertTenantPath(ctx.tenantId, path);
  const file = await need(ctx.storage, 'storage').get(path);
  if (!file) throw new NotFoundError('ảnh giấy tờ');
  await logAccess(ctx, documentId, side === 'front' ? 'VIEW_FRONT' : 'VIEW_BACK');
  return file;
}

export async function listIdAccessLog(ctx: ServiceCtx, documentId: string) {
  guard(ctx, 'customer.id_document.view', FEATURE);
  return (await ctx.db.query('SELECT action, user_id, created_at FROM id_document_access_log WHERE document_id=$1 ORDER BY id DESC LIMIT 50', [documentId])).rows as
    { action: string; user_id: string | null; created_at: Date }[];
}

async function eraseDocuments(ctx: ServiceCtx, where: string, arg: string) {
  const docs = (await ctx.db.query(`SELECT id, front_path, back_path FROM id_document WHERE ${where} AND deleted_at IS NULL`, [arg])).rows;
  for (const d of docs) {
    for (const p of [d.front_path, d.back_path] as (string | null)[]) if (p) { assertTenantPath(ctx.tenantId, p); await need(ctx.storage, 'storage').delete(p); }
    // Xóa sạch dữ liệu nhạy cảm; giữ dòng và nhật ký truy cập để đối soát
    await ctx.db.query(`UPDATE id_document SET deleted_at=now(), number_enc='', number_hash='', front_path=NULL, back_path=NULL, issued_place=NULL WHERE id=$1`, [d.id]);
  }
  return docs.length;
}

export async function deleteIdDocument(ctx: ServiceCtx, documentId: string): Promise<void> {
  guard(ctx, 'customer.manage', FEATURE, { write: true });
  await loadDoc(ctx, documentId);
  await eraseDocuments(ctx, 'id = $1', documentId);
  await audit(ctx, 'id_document.delete', 'id_document', documentId);
}

/** Ẩn danh khi khách yêu cầu: xóa thông tin cá nhân và giấy tờ, giữ đơn thuê để đối soát. */
export async function anonymizeCustomer(ctx: ServiceCtx, id: string): Promise<void> {
  guard(ctx, 'customer.anonymize', FEATURE, { write: true });
  const c = (await ctx.db.query('SELECT id FROM customer WHERE id=$1 AND anonymized_at IS NULL FOR UPDATE', [id])).rows[0];
  if (!c) throw new NotFoundError('khách hàng');
  if ((await ctx.db.query("SELECT 1 FROM booking WHERE customer_id=$1 AND status IN ('QUOTE','HOLD','CONFIRMED','ACTIVE','RETURNED')", [id])).rowCount)
    throw new ValidationError('Khách còn đơn chưa hoàn tất. Hãy đóng hoặc hủy các đơn trước khi ẩn danh.');
  await eraseDocuments(ctx, 'customer_id = $1', id);
  await ctx.db.query(
    `UPDATE customer SET name='Khách đã ẩn danh', phone='anon-' || id::text, email=NULL, address=NULL, zalo=NULL, company_name=NULL, tax_code=NULL,
       representative=NULL, notes=NULL, blacklisted=false, blacklist_reason=NULL, custom_fields='{}', anonymized_at=now() WHERE id=$1`, [id]);
  await audit(ctx, 'customer.anonymize', 'customer', id);
}

/** Dùng khi tạo báo giá/đơn: khách trong danh sách đen không được thuê. */
export async function assertCustomerCanRent(ctx: ServiceCtx, customerId: string): Promise<CustomerRow> {
  const { customer } = await getCustomer(ctx, customerId);
  if (customer.anonymizedAt) throw new ValidationError('Khách hàng này đã được ẩn danh, không thể tạo đơn mới.');
  if (customer.blacklisted) throw new ValidationError(`Khách hàng nằm trong danh sách đen: ${customer.blacklistReason}`);
  return customer;
}

export { normalizePhoneVN };
