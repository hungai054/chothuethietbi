import '@/extensions.generated';
import { AvailabilityError, ForbiddenError, InvalidBookingTransitionError, InvalidTransitionError, API_ENDPOINTS, parseBearer, permissionsForScopes, rateLimit, type ApiEndpoint } from '@rentpro/core';
import {
  NotFoundError, ReadOnlyError, ValidationError, authenticateApiKey, availability, createBooking, createCustomer, getBooking, listBookings, listCustomers,
  listModels, listUnits, withExtensions, withTenantId, type ApiPrincipal, type ServiceCtx,
} from '@rentpro/db';
import { FeatureDisabledError, LimitExceededError, keyRingFromEnv } from '@rentpro/tenancy';
import { appStorage } from './service';
import { pool } from './db';

/** API công khai /api/v1: xác thực khóa → kiểm phạm vi + gói → chạy dịch vụ với quyền hẹp của khóa (không bao giờ có quyền giấy tờ/tiền/cài đặt). */

const MAX_PER_MINUTE = 120;
const g = globalThis as unknown as { __apiHits?: Map<string, number[]>; __apiRing?: ReturnType<typeof keyRingFromEnv> };
const hits = () => (g.__apiHits ??= new Map());

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) => json({ error: { code, message } }, status, headers);

class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

function mapError(e: unknown): Response {
  if (e instanceof ApiError) return fail(e.status, e.code, e.message);
  if (e instanceof ValidationError) return fail(400, 'invalid_request', e.message);
  if (e instanceof NotFoundError) return fail(404, 'not_found', e.message);
  if (e instanceof AvailabilityError || e instanceof InvalidBookingTransitionError || e instanceof InvalidTransitionError) return fail(409, 'conflict', e.message);
  if (e instanceof ReadOnlyError) return fail(403, 'read_only', e.message);
  if (e instanceof ForbiddenError || e instanceof FeatureDisabledError || e instanceof LimitExceededError) return fail(403, 'forbidden', e.message);
  console.error('[api/v1]', e);
  return fail(500, 'internal_error', 'Lỗi hệ thống. Vui lòng thử lại sau.');
}

function matchRoute(method: string, pathname: string): { ep: ApiEndpoint; params: Record<string, string> } | null {
  const segs = pathname.replace(/\/+$/, '').split('/');
  for (const ep of API_ENDPOINTS) {
    if (ep.method !== method.toLowerCase()) continue;
    const tpl = ep.path.split('/');
    if (tpl.length !== segs.length) continue;
    const params: Record<string, string> = {};
    if (tpl.every((t, i) => (t.startsWith('{') ? ((params[t.slice(1, -1)] = decodeURIComponent(segs[i]!)), true) : t === segs[i]))) return { ep, params };
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOpt = (v: string | null, label: string) => {
  if (v && !UUID.test(v)) throw new ValidationError(`${label} không hợp lệ.`);
  return v || undefined;
};
const intIn = (v: string | null, def: number, min: number, max: number, label: string) => {
  if (v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} phải là số nguyên từ ${min} đến ${max}.`);
  return n;
};
function dateOf(v: unknown, label: string): Date {
  const s = typeof v === 'string' ? v : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new ValidationError(`${label} phải theo ISO 8601 kèm múi giờ, ví dụ 2027-03-01T08:00:00+07:00.`);
  }
  return new Date(s);
}

type Handler = (ctx: ServiceCtx, a: { q: URLSearchParams; params: Record<string, string>; body: any }) => Promise<{ status?: number; body: unknown }>;

const HANDLERS: Record<string, Handler> = {
  async listEquipmentModels(ctx, { q }) {
    const rows = await listModels(ctx, { q: q.get('q') ?? undefined });
    return { body: { data: rows.map((m) => ({ id: m.id, name: m.name, brand: m.brand, categoryName: m.categoryName, tracked: m.tracked, stockQty: m.stockQty, total: m.total })), total: rows.length } };
  },
  async listEquipmentUnits(ctx, { q }) {
    const r = await listUnits(ctx, { status: q.get('status') || undefined, modelId: uuidOpt(q.get('modelId'), 'modelId'), page: intIn(q.get('page'), 1, 1, 100000, 'page'), pageSize: intIn(q.get('pageSize'), 25, 1, 100, 'pageSize') });
    return { body: { data: r.rows.map((u) => ({ id: u.id, barcode: u.barcode, modelId: u.modelId, modelName: u.modelName, status: u.status, serial: u.serial })), total: r.total } };
  },
  async listCustomers(ctx, { q }) {
    const r = await listCustomers(ctx, { q: q.get('q') ?? undefined, page: intIn(q.get('page'), 1, 1, 100000, 'page'), pageSize: intIn(q.get('pageSize'), 25, 1, 100, 'pageSize') });
    return { body: { data: r.rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, blacklisted: c.blacklisted })), total: r.total } };
  },
  async createCustomer(ctx, { body }) {
    if (!body || typeof body !== 'object') throw new ValidationError('Nội dung gửi lên phải là JSON đối tượng.');
    const id = await createCustomer(ctx, { type: 'PERSON', trustLevel: 'NEW', ...body });
    return { status: 201, body: { id } };
  },
  async getAvailability(ctx, { q }) {
    const rows = await availability(ctx, dateOf(q.get('start'), 'start'), dateOf(q.get('end'), 'end'), { modelId: uuidOpt(q.get('modelId'), 'modelId') });
    return { body: { data: rows.map((m) => ({ modelId: m.modelId, name: m.name, tracked: m.tracked, total: m.total, free: m.free })) } };
  },
  async listBookings(ctx, { q }) {
    const r = await listBookings(ctx, { status: q.get('status') || undefined, customerId: uuidOpt(q.get('customerId'), 'customerId'), page: intIn(q.get('page'), 1, 1, 100000, 'page'), pageSize: intIn(q.get('pageSize'), 25, 1, 100, 'pageSize') });
    return { body: { data: r.rows.map((b) => ({ id: b.id, code: b.code, status: b.status, customerId: b.customerId, customerName: b.customerName, startsAt: b.startsAt, endsAt: b.endsAt, total: b.total })), total: r.total } };
  },
  async getBooking(ctx, { params }) {
    if (!UUID.test(params.id!)) throw new ValidationError('Mã đơn không hợp lệ.');
    const d = await getBooking(ctx, params.id!);
    const b = d.booking;
    return { body: {
      id: b.id, code: b.code, status: b.status, customerId: b.customerId, customerName: b.customerName, startsAt: b.startsAt, endsAt: b.endsAt, total: b.total, notes: b.notes,
      items: d.lines.map((l) => ({ modelId: l.modelId, modelName: l.modelName, qty: l.qty, lineTotal: l.lineTotal })),
    } };
  },
  async createBooking(ctx, { body }) {
    if (!body || typeof body !== 'object') throw new ValidationError('Nội dung gửi lên phải là JSON đối tượng.');
    if (typeof body.customerId !== 'string' || !UUID.test(body.customerId)) throw new ValidationError('customerId không hợp lệ.');
    if (!Array.isArray(body.items) || body.items.length === 0) throw new ValidationError('items phải là danh sách có ít nhất một dòng.');
    const lines = body.items.map((it: any) => {
      if (!it || typeof it.modelId !== 'string' || !UUID.test(it.modelId)) throw new ValidationError('modelId không hợp lệ.');
      return { modelId: it.modelId, qty: it.qty };
    });
    const status = body.status ?? 'QUOTE';
    if (!['QUOTE', 'HOLD', 'CONFIRMED'].includes(status)) throw new ValidationError('status chỉ nhận QUOTE, HOLD hoặc CONFIRMED.');
    const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).slice(0, 2000);
    const r = await createBooking(ctx, { customerId: body.customerId, lines, start: dateOf(body.start, 'start'), end: dateOf(body.end, 'end'), status, notes });
    return { status: 201, body: r };
  },
};

function ctxOf(p: ApiPrincipal, db: ServiceCtx['db']): ServiceCtx {
  return {
    db, tenantId: p.tenantId, tenantStatus: p.status, userId: null, permissions: permissionsForScopes(p.scopes),
    features: p.features, limits: p.limits, timezone: p.timezone, keyRing: (g.__apiRing ??= keyRingFromEnv()), storage: appStorage(),
  };
}

export async function handleApi(req: Request, pathname: string): Promise<Response> {
  try {
    const route = matchRoute(req.method, pathname);
    if (!route) return fail(404, 'not_found', 'Không tìm thấy đường dẫn API.');
    const key = parseBearer(req.headers.get('authorization'));
    const principal = key ? await authenticateApiKey(pool(), key) : null;
    if (!principal) return fail(401, 'unauthorized', 'Thiếu hoặc sai khóa API. Gửi header "Authorization: Bearer rp_live_…".', { 'www-authenticate': 'Bearer' });
    const wait = rateLimit(hits(), principal.keyId, MAX_PER_MINUTE, 60_000);
    if (wait) return fail(429, 'rate_limited', `Vượt ${MAX_PER_MINUTE} lời gọi mỗi phút. Thử lại sau ${wait} giây.`, { 'retry-after': String(wait) });
    if (!principal.features.api) return fail(403, 'feature_disabled', 'Gói hiện tại chưa bao gồm API.');
    if (!principal.scopes.includes(route.ep.scope)) return fail(403, 'insufficient_scope', `Khóa chưa có phạm vi "${route.ep.scope}".`);
    let body: unknown;
    if (route.ep.method === 'post') {
      const raw = await req.text();
      if (raw.length > 100_000) return fail(413, 'payload_too_large', 'Nội dung gửi lên quá lớn.');
      try { body = JSON.parse(raw); } catch { return fail(400, 'invalid_json', 'Nội dung gửi lên không phải JSON hợp lệ.'); }
    }
    const handler = HANDLERS[route.ep.id];
    if (!handler) return fail(404, 'not_found', 'Không tìm thấy đường dẫn API.');
    const q = new URL(req.url).searchParams;
    const out = await withTenantId(pool(), principal.tenantId, (db) =>
      withExtensions(ctxOf(principal, db), (ctx) => handler(ctx, { q, params: route.params, body })));
    return json(out.body, out.status ?? 200);
  } catch (e) {
    return mapError(e);
  }
}
