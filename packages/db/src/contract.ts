import {
  DEFAULT_CONTRACT_PATTERN, buildContractContent, contractExtras, formatFieldValue, formatDocNumber, ID_DOC_LABEL, localDateKey, sniffImage,
  type ContractContent, type IdDocType,
} from '@rentpro/core';
import { renderContractTerms } from './contract-text';
import { getDocTemplates, listFieldDefs, validateFieldValues } from './customization';
import { rawFinanceSettings, storePhoto } from './finance';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';
import { assertTenantPath } from './storage';

type Row = Record<string, any>;
const SIGNATURE_MAX_BYTES = 300 * 1024;

async function nextContractNumber(ctx: ServiceCtx): Promise<string> {
  const pattern = (await rawFinanceSettings(ctx)).contractPattern ?? DEFAULT_CONTRACT_PATTERN;
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  const year = Number(localDateKey(new Date(), tz).slice(0, 4));
  const n = (await ctx.db.query(
    `INSERT INTO doc_counter(tenant_id,kind,year,last_value) VALUES ($1,'contract',$2,1)
     ON CONFLICT (tenant_id,kind,year) DO UPDATE SET last_value = doc_counter.last_value + 1 RETURNING last_value`, [ctx.tenantId, year])).rows[0].last_value;
  return formatDocNumber(pattern, year, Number(n));
}

export interface ContractRow {
  id: string; bookingId: string; number: string; status: 'DRAFT' | 'SIGNED' | 'VOID'; content: ContractContent; signMode: 'ESIGN' | 'PAPER' | null;
  hasCustomerSignature: boolean; hasStaffSignature: boolean; signedCustomerName: string | null; signedAt: Date | null; voidReason: string | null; createdAt: Date;
}

const toRow = (r: Row): ContractRow => ({
  id: r.id, bookingId: r.booking_id, number: r.number, status: r.status, content: r.content, signMode: r.sign_mode,
  hasCustomerSignature: !!r.customer_signature_path, hasStaffSignature: !!r.staff_signature_path, signedCustomerName: r.signed_customer_name,
  signedAt: r.signed_at, voidReason: r.void_reason, createdAt: r.created_at,
});

/** Lập hợp đồng từ đơn đã xác nhận. Nội dung được chụp lại (không đổi khi dữ liệu sau này thay đổi). */
export async function createContract(ctx: ServiceCtx, bookingId: string, customFields: Record<string, unknown> = {}): Promise<string> {
  guard(ctx, 'contract.create', 'contract', { write: true });
  const b = (await ctx.db.query(
    `SELECT b.*, c.name AS cname, c.phone, c.email, c.address, c.type, c.company_name, c.tax_code, c.representative, t.name AS tenant_name
     FROM booking b JOIN customer c ON c.id=b.customer_id JOIN tenant t ON t.id=b.tenant_id WHERE b.id=$1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [bookingId])).rows[0];
  if (!b) throw new NotFoundError('đơn thuê');
  if (!['CONFIRMED', 'ACTIVE'].includes(b.status)) throw new ValidationError('Chỉ lập hợp đồng cho đơn đã xác nhận. Hãy xác nhận đơn trước.');
  if ((await ctx.db.query(`SELECT 1 FROM contract WHERE booking_id=$1 AND status <> 'VOID'`, [bookingId])).rowCount)
    throw new ValidationError('Đơn này đã có hợp đồng. Muốn lập lại, hãy hủy hợp đồng cũ (kèm lý do) trước.');

  const lines = (await ctx.db.query(
    `SELECT l.id, l.qty, l.line_total, m.name FROM booking_line l JOIN equipment_model m ON m.id=l.model_id WHERE l.booking_id=$1 ORDER BY m.name`, [bookingId])).rows;
  const units = (await ctx.db.query(
    `SELECT a.booking_line_id, u.barcode FROM unit_allocation a JOIN equipment_unit u ON u.id=a.unit_id WHERE a.booking_id=$1 AND a.status <> 'RELEASED' ORDER BY u.barcode`, [bookingId])).rows;
  const doc = (await ctx.db.query(`SELECT type, number_last4 FROM id_document WHERE customer_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`, [b.customer_id])).rows[0];
  const settings = await rawFinanceSettings(ctx);
  const store = settings.store ?? {};
  const contractValues = await validateFieldValues(ctx, 'CONTRACT', customFields, true);
  const number = await nextContractNumber(ctx);
  const tpl = (await getDocTemplates(ctx)).resolved.contract;
  const defs = await listFieldDefs(ctx);
  const custValues = ((await ctx.db.query('SELECT custom_fields FROM customer WHERE id=$1', [b.customer_id])).rows[0]?.custom_fields ?? {}) as Record<string, unknown>;
  const bookValues = (b.custom_fields ?? {}) as Record<string, unknown>;
  const byEntity = (e: string) => defs.filter((d) => d.entity === e);
  const extras = [...contractExtras(byEntity('CUSTOMER'), custValues), ...contractExtras(byEntity('BOOKING'), bookValues), ...contractExtras(byEntity('CONTRACT'), contractValues)];
  const vars: Record<string, string> = {
    ten_cua_hang: store.name || b.tenant_name, ten_khach: b.cname, ma_don: b.code, so_hop_dong: number, tong_tien: `${new Intl.NumberFormat('vi-VN').format(Number(b.total))} đ`,
    tien_coc: `${new Intl.NumberFormat('vi-VN').format(Number(b.deposit_required))} đ`,
    ngay_bat_dau: new Intl.DateTimeFormat('vi-VN', { timeZone: ctx.timezone ?? 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(b.starts_at),
    ngay_ket_thuc: new Intl.DateTimeFormat('vi-VN', { timeZone: ctx.timezone ?? 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(b.ends_at),
  };
  for (const [e, vals] of [['CUSTOMER', custValues], ['BOOKING', bookValues], ['CONTRACT', contractValues]] as const)
    for (const d of byEntity(e)) vars[`cf.${d.key}`] = formatFieldValue(d, vals[d.key]);

  const content = buildContractContent({
    number, date: new Date(), timeZone: ctx.timezone ?? 'Asia/Ho_Chi_Minh',
    store: { name: store.name || b.tenant_name, address: store.address, phone: store.phone, taxCode: store.taxCode, representative: store.representative },
    customer: {
      type: b.type, name: b.cname, phone: b.phone, email: b.email, address: b.address, companyName: b.company_name, taxCode: b.tax_code, representative: b.representative,
      idDocument: doc ? { label: ID_DOC_LABEL[doc.type as IdDocType], last4: doc.number_last4 } : null,
    },
    booking: { code: b.code, start: b.starts_at, end: b.ends_at },
    items: lines.map((l) => ({ name: l.name, qty: l.qty, units: units.filter((u) => u.booking_line_id === l.id).map((u) => u.barcode), lineTotal: Number(l.line_total) })),
    rentTotal: Number(b.total), depositRequired: Number(b.deposit_required), title: tpl.title, terms: renderContractTerms(tpl.terms, vars), extras,
  });
  const r = await ctx.db.query('INSERT INTO contract(tenant_id,booking_id,number,content,created_by,custom_fields) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [ctx.tenantId, bookingId, number, JSON.stringify(content), ctx.userId, JSON.stringify(contractValues)]);
  await audit(ctx, 'contract.create', 'booking', bookingId, { contractId: r.rows[0].id, number });
  return r.rows[0].id;
}

/** Hợp đồng còn hiệu lực của đơn (hoặc null) cùng các hợp đồng đã hủy. */
export async function getContract(ctx: ServiceCtx, bookingId: string): Promise<{ active: ContractRow | null; voided: ContractRow[] }> {
  guard(ctx, 'contract.view', 'contract');
  const rows = (await ctx.db.query('SELECT * FROM contract WHERE booking_id=$1 ORDER BY created_at DESC', [bookingId])).rows.map(toRow);
  return { active: rows.find((r) => r.status !== 'VOID') ?? null, voided: rows.filter((r) => r.status === 'VOID') };
}

export async function getContractById(ctx: ServiceCtx, id: string): Promise<ContractRow & { bookingCode: string }> {
  guard(ctx, 'contract.view', 'contract');
  const r = (await ctx.db.query('SELECT c.*, b.code AS booking_code FROM contract c JOIN booking b ON b.id=c.booking_id WHERE c.id=$1', [id])).rows[0];
  if (!r) throw new NotFoundError('hợp đồng');
  return { ...toRow(r), bookingCode: r.booking_code };
}

export interface SignInput {
  mode: 'ESIGN' | 'PAPER';
  customerName?: string;
  customerSignature?: Uint8Array | null;
  staffSignature?: Uint8Array | null;
}

async function storeSignature(ctx: ServiceCtx, data: Uint8Array | null | undefined, who: string): Promise<string> {
  if (!data || data.byteLength === 0) throw new ValidationError(`Thiếu chữ ký của ${who}.`);
  if (data.byteLength > SIGNATURE_MAX_BYTES) throw new ValidationError(`Chữ ký của ${who} quá lớn.`);
  if (sniffImage(data)?.ext !== 'png') throw new ValidationError(`Chữ ký của ${who} không hợp lệ.`);
  // Chữ ký trắng (chưa ký gì) có kích thước rất nhỏ: PNG canvas trống cỡ vài trăm byte
  if (data.byteLength < 400) throw new ValidationError(`Chữ ký của ${who} đang trống. Hãy ký lên khung.`);
  return storePhoto(ctx, data, 'sign');
}

/**
 * Ký hợp đồng. ESIGN: ký trên màn hình (cần gói có chữ ký điện tử), lưu ảnh chữ ký của khách và nhân viên.
 * PAPER: đã ký giấy ngoài đời, chỉ ghi nhận.
 */
export async function signContract(ctx: ServiceCtx, contractId: string, input: SignInput): Promise<void> {
  guard(ctx, 'contract.sign', input.mode === 'ESIGN' ? 'contract.e_signature' : 'contract', { write: true });
  const c = (await ctx.db.query('SELECT c.*, b.status AS booking_status FROM contract c JOIN booking b ON b.id=c.booking_id WHERE c.id=$1 FOR UPDATE OF c', [contractId])).rows[0];
  if (!c) throw new NotFoundError('hợp đồng');
  if (c.status !== 'DRAFT') throw new ValidationError(c.status === 'SIGNED' ? 'Hợp đồng đã được ký.' : 'Hợp đồng đã bị hủy.');
  if (!['CONFIRMED', 'ACTIVE'].includes(c.booking_status)) throw new ValidationError('Đơn không còn hiệu lực để ký hợp đồng.');
  const name = input.customerName?.trim() || (c.content as ContractContent).customer.name;
  let custPath: string | null = null;
  let staffPath: string | null = null;
  try {
    if (input.mode === 'ESIGN') {
      custPath = await storeSignature(ctx, input.customerSignature, 'khách hàng');
      staffPath = await storeSignature(ctx, input.staffSignature, 'nhân viên');
    }
    await ctx.db.query(
      `UPDATE contract SET status='SIGNED', sign_mode=$2, customer_signature_path=$3, staff_signature_path=$4, signed_customer_name=$5, signed_at=now() WHERE id=$1`,
      [contractId, input.mode, custPath, staffPath, name]);
  } catch (e) {
    await Promise.all([custPath, staffPath].filter((p): p is string => !!p).map((p) => ctx.storage!.delete(p).catch(() => undefined)));
    throw e;
  }
  await audit(ctx, 'contract.sign', 'booking', c.booking_id, { contractId, mode: input.mode });
}

export async function voidContract(ctx: ServiceCtx, contractId: string, reason: string): Promise<void> {
  guard(ctx, 'contract.create', 'contract', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do hủy hợp đồng.');
  const c = (await ctx.db.query('SELECT c.id, c.status, c.booking_id, b.status AS bs FROM contract c JOIN booking b ON b.id=c.booking_id WHERE c.id=$1 FOR UPDATE OF c', [contractId])).rows[0];
  if (!c) throw new NotFoundError('hợp đồng');
  if (c.status === 'VOID') throw new ValidationError('Hợp đồng đã bị hủy.');
  if (['ACTIVE', 'RETURNED', 'CLOSED'].includes(c.bs)) throw new ValidationError('Đơn đang thuê hoặc đã nhận lại thiết bị: không hủy được hợp đồng.');
  await ctx.db.query(`UPDATE contract SET status='VOID', void_reason=$2 WHERE id=$1`, [contractId, reason.trim()]);
  await audit(ctx, 'contract.void', 'booking', c.booking_id, { contractId, reason });
}

export async function getContractSignature(ctx: ServiceCtx, contractId: string, who: 'customer' | 'staff') {
  guard(ctx, 'contract.view', 'contract');
  const c = (await ctx.db.query('SELECT customer_signature_path, staff_signature_path FROM contract WHERE id=$1', [contractId])).rows[0];
  const path: string | null = who === 'customer' ? c?.customer_signature_path : c?.staff_signature_path;
  if (!path) throw new NotFoundError('chữ ký');
  assertTenantPath(ctx.tenantId, path);
  const f = await need(ctx.storage, 'storage').get(path);
  if (!f) throw new NotFoundError('chữ ký');
  return f;
}
