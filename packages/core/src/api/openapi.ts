import { API_SCOPE_LABEL, type ApiScope } from './keys';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL } from './webhook';

/**
 * Mô tả API công khai ở MỘT nơi: từ đây sinh tài liệu OpenAPI (không viết tay, nên không lệch khỏi mã). Route trong apps/web
 * tra cùng bảng này để biết phạm vi quyền cần có, và test kiểm tra mỗi route đều có mô tả.
 */
type Schema = Record<string, unknown>;

export interface ApiParam { name: string; in: 'query' | 'path'; required?: boolean; description: string; schema: Schema }
export interface ApiEndpoint {
  id: string; method: 'get' | 'post'; path: string; summary: string; scope: ApiScope; params?: ApiParam[]; body?: Schema; ok: Schema; created?: boolean;
}

const uuid = { type: 'string', format: 'uuid' };
const dt = { type: 'string', format: 'date-time', description: 'Thời điểm ISO 8601 (UTC hoặc kèm múi giờ), VD 2027-03-01T08:00:00+07:00' };
const page: ApiParam[] = [
  { name: 'page', in: 'query', description: 'Trang (từ 1)', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'pageSize', in: 'query', description: 'Số dòng mỗi trang (1–100)', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
];
const list = (item: Schema): Schema => ({ type: 'object', properties: { data: { type: 'array', items: item }, total: { type: 'integer' } } });

const model = { type: 'object', properties: { id: uuid, name: { type: 'string' }, brand: { type: 'string', nullable: true }, categoryName: { type: 'string', nullable: true }, tracked: { type: 'boolean' }, stockQty: { type: 'integer' }, total: { type: 'integer' } } };
const unit = { type: 'object', properties: { id: uuid, barcode: { type: 'string' }, modelId: uuid, modelName: { type: 'string' }, status: { type: 'string', enum: ['AVAILABLE', 'RESERVED', 'RENTED', 'INSPECTING', 'MAINTENANCE', 'RETIRED', 'LOST'] }, serial: { type: 'string', nullable: true } } };
const customer = { type: 'object', properties: { id: uuid, name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string', nullable: true }, blacklisted: { type: 'boolean' } } };
const booking = { type: 'object', properties: { id: uuid, code: { type: 'string' }, status: { type: 'string', enum: ['QUOTE', 'HOLD', 'CONFIRMED', 'ACTIVE', 'RETURNED', 'CLOSED', 'CANCELLED'] }, customerId: uuid, customerName: { type: 'string' }, startsAt: dt, endsAt: dt, total: { type: 'integer', description: 'Tổng tiền (đồng)' } } };

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  { id: 'listEquipmentModels', method: 'get', path: '/api/v1/equipment-models', summary: 'Danh sách mẫu thiết bị', scope: 'inventory:read',
    params: [{ name: 'q', in: 'query', description: 'Tìm theo tên/hãng', schema: { type: 'string' } }], ok: list(model) },
  { id: 'listEquipmentUnits', method: 'get', path: '/api/v1/equipment-units', summary: 'Danh sách thiết bị (từng chiếc)', scope: 'inventory:read',
    params: [{ name: 'status', in: 'query', description: 'Lọc theo tình trạng', schema: { type: 'string' } }, { name: 'modelId', in: 'query', description: 'Lọc theo mẫu', schema: uuid }, ...page], ok: list(unit) },
  { id: 'listCustomers', method: 'get', path: '/api/v1/customers', summary: 'Danh sách khách hàng', scope: 'customers:read',
    params: [{ name: 'q', in: 'query', description: 'Tìm theo tên/điện thoại/email', schema: { type: 'string' } }, ...page], ok: list(customer) },
  { id: 'createCustomer', method: 'post', path: '/api/v1/customers', summary: 'Tạo khách hàng', scope: 'customers:write', created: true,
    body: { type: 'object', required: ['name', 'phone'], properties: { name: { type: 'string' }, phone: { type: 'string', description: 'Số điện thoại Việt Nam' }, email: { type: 'string' }, address: { type: 'string' }, notes: { type: 'string' } } },
    ok: { type: 'object', properties: { id: uuid } } },
  { id: 'getAvailability', method: 'get', path: '/api/v1/availability', summary: 'Tra cứu số chiếc còn trống theo mẫu trong một khoảng thời gian', scope: 'availability:read',
    params: [{ name: 'start', in: 'query', required: true, description: 'Bắt đầu', schema: dt }, { name: 'end', in: 'query', required: true, description: 'Kết thúc', schema: dt }, { name: 'modelId', in: 'query', description: 'Chỉ một mẫu', schema: uuid }],
    ok: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { modelId: uuid, name: { type: 'string' }, tracked: { type: 'boolean' }, total: { type: 'integer' }, free: { type: 'integer' } } } } } } },
  { id: 'listBookings', method: 'get', path: '/api/v1/bookings', summary: 'Danh sách đơn thuê', scope: 'bookings:read',
    params: [{ name: 'status', in: 'query', description: 'Lọc theo trạng thái', schema: { type: 'string' } }, { name: 'customerId', in: 'query', description: 'Lọc theo khách', schema: uuid }, ...page], ok: list(booking) },
  { id: 'getBooking', method: 'get', path: '/api/v1/bookings/{id}', summary: 'Chi tiết một đơn thuê (có dòng thiết bị)', scope: 'bookings:read',
    params: [{ name: 'id', in: 'path', required: true, description: 'Mã đơn (uuid)', schema: uuid }], ok: booking },
  { id: 'createBooking', method: 'post', path: '/api/v1/bookings', summary: 'Tạo đơn thuê (báo giá, giữ chỗ hoặc xác nhận); kiểm tra lịch trống và tính giá như giao diện', scope: 'bookings:write', created: true,
    body: { type: 'object', required: ['customerId', 'start', 'end', 'items'], properties: {
      customerId: uuid, start: dt, end: dt, status: { type: 'string', enum: ['QUOTE', 'HOLD', 'CONFIRMED'], default: 'QUOTE' },
      items: { type: 'array', minItems: 1, items: { type: 'object', required: ['modelId', 'qty'], properties: { modelId: uuid, qty: { type: 'integer', minimum: 1 } } } }, notes: { type: 'string' } } },
    ok: { type: 'object', properties: { id: uuid, code: { type: 'string' } } } },
] as const;

const ERROR_SCHEMA = { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } };

const STATUS_DOC: Record<string, string> = {
  '400': 'Dữ liệu gửi lên không hợp lệ (message tiếng Việt)', '401': 'Thiếu hoặc sai khóa API', '403': 'Khóa không có phạm vi quyền hoặc gói chưa bật API',
  '404': 'Không tìm thấy', '409': 'Xung đột (VD thiết bị đã được đặt)', '429': 'Vượt giới hạn tốc độ, xem header Retry-After',
};

export function buildOpenApi(opts: { baseUrl?: string; version?: string } = {}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of API_ENDPOINTS) {
    (paths[e.path] ??= {})[e.method] = {
      operationId: e.id, summary: e.summary, security: [{ bearerAuth: [e.scope] }], tags: [e.scope.split(':')[0]],
      description: `Phạm vi quyền cần có: \`${e.scope}\` (${API_SCOPE_LABEL[e.scope]}).`,
      ...(e.params ? { parameters: e.params.map((p) => ({ name: p.name, in: p.in, required: p.in === 'path' || p.required === true, description: p.description, schema: p.schema })) } : {}),
      ...(e.body ? { requestBody: { required: true, content: { 'application/json': { schema: e.body } } } } : {}),
      responses: {
        [e.created ? '201' : '200']: { description: 'Thành công', content: { 'application/json': { schema: e.ok } } },
        ...Object.fromEntries(Object.entries(STATUS_DOC).map(([c, d]) => [c, { description: d, content: { 'application/json': { schema: ERROR_SCHEMA } } }])),
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'RentPro API', version: opts.version ?? '1.0.0',
      description: 'API công khai cho cửa hàng (gói Doanh nghiệp). Xác thực bằng khóa API trong header `Authorization: Bearer rp_live_…`. Tiền là số nguyên đồng; thời gian ISO 8601.\n\n'
        + 'Webhook đi: cửa hàng đăng ký địa chỉ nhận; mỗi sự kiện gửi POST JSON `{id, type, createdAt, data}` kèm header `X-RentPro-Signature: v1=<HMAC-SHA256(secret, "<timestamp>.<body>")>` và `X-RentPro-Timestamp`. '
        + `Sự kiện: ${WEBHOOK_EVENTS.map((x) => `\`${x}\` (${WEBHOOK_EVENT_LABEL[x]})`).join(', ')}. Thử lại tối đa 6 lần với giãn cách tăng dần.`,
    },
    servers: opts.baseUrl ? [{ url: opts.baseUrl }] : [],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Khóa API tạo ở Cài đặt → API và webhook' } } },
    paths,
  };
}

export const endpointFor = (method: string, path: string): ApiEndpoint | undefined =>
  API_ENDPOINTS.find((e) => e.method === method.toLowerCase() && e.path === path);
