import { listBookings } from './booking-queries';
import { listCustomers } from './customers';
import { listModels, listUnits } from './inventory';
import { ValidationError, type ServiceCtx } from './service';

/**
 * Tìm nhanh cho Ctrl+K: gộp mẫu thiết bị, thiết bị, khách hàng, đơn thuê. Mỗi nhóm CHỈ chạy khi người dùng có quyền xem và gói bật tính năng
 * (nhóm không đủ điều kiện trả mảng rỗng, không báo lỗi, vì đây là tìm kiếm chung chứ không phải một trang cần quyền). Dữ liệu từng nhóm
 * vẫn đi qua service gốc nên RLS, trường tùy chỉnh "tìm kiếm được" và quyền vẫn do các service đó kiểm. Không trả giấy tờ hay số điện thoại đầy đủ.
 */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 80;
export const SEARCH_LIMIT = 5;

export interface SearchHit { id: string; title: string; subtitle: string | null }
export interface GlobalSearchResult { models: SearchHit[]; units: SearchHit[]; customers: SearchHit[]; bookings: SearchHit[] }

const can = (c: ServiceCtx, perm: Parameters<ServiceCtx['permissions']['has']>[0], feature: keyof ServiceCtx['features']) => c.permissions.has(perm) && c.features[feature];
const maskPhone = (p: string) => (p.length > 4 ? `•••${p.slice(-4)}` : p);

export async function globalSearch(ctx: ServiceCtx, raw: string, limit = SEARCH_LIMIT): Promise<GlobalSearchResult> {
  const q = raw.trim();
  if (q.length > SEARCH_MAX) throw new ValidationError(`Từ khóa tối đa ${SEARCH_MAX} ký tự.`);
  const out: GlobalSearchResult = { models: [], units: [], customers: [], bookings: [] };
  if (q.length < SEARCH_MIN) return out;
  const n = Math.min(Math.max(Math.trunc(limit) || SEARCH_LIMIT, 1), 10);

  if (can(ctx, 'inventory.view', 'inventory')) {
    out.models = (await listModels(ctx, { q })).slice(0, n)
      .map((m) => ({ id: m.id, title: m.name, subtitle: [m.brand, m.categoryName].filter(Boolean).join(' · ') || null }));
    out.units = (await listUnits(ctx, { q, pageSize: n })).rows
      .map((u) => ({ id: u.id, title: u.barcode, subtitle: [u.modelName, u.serial].filter(Boolean).join(' · ') || null }));
  }
  if (can(ctx, 'customer.view', 'customers')) {
    out.customers = (await listCustomers(ctx, { q, pageSize: n })).rows
      .map((c) => ({ id: c.id, title: c.name, subtitle: maskPhone(c.phone) }));
  }
  if (can(ctx, 'booking.view', 'booking')) {
    out.bookings = (await listBookings(ctx, { q, pageSize: n })).rows
      .map((b) => ({ id: b.id, title: b.code, subtitle: `${b.customerName} · ${b.status}` }));
  }
  return out;
}
