import type { ExtensionContext, ExtensionRead, ExtensionStore } from './index';

/** Kho khóa–giá trị trong bộ nhớ để test extension mà không cần cơ sở dữ liệu. */
export function memoryStore(): ExtensionStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T,>(key: string) => (data.has(key) ? (data.get(key) as T) : null),
    set: async (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key) => { data.delete(key); },
    list: async (prefix = '') => [...data.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
  };
}

export interface TestContextOptions {
  config?: Record<string, unknown>;
  tenantId?: string;
  timezone?: string;
  /** Kết quả giả cho ctx.read.query: hàm nhận câu SQL và tham số */
  query?: (sql: string, params: unknown[]) => unknown[] | Promise<unknown[]>;
}

/** Ngữ cảnh giả cho test extension. `logs` gom các lần gọi ctx.log. */
export function createTestContext(o: TestContextOptions = {}): ExtensionContext & { logs: string[]; store: ReturnType<typeof memoryStore> } {
  const logs: string[] = [];
  const read: ExtensionRead = { query: (async (sql: string, params: unknown[] = []) => (o.query ? o.query(sql, params) : [])) as ExtensionRead['query'] };
  return { tenantId: o.tenantId ?? '00000000-0000-0000-0000-000000000001', timezone: o.timezone ?? 'Asia/Ho_Chi_Minh', config: o.config ?? {}, log: (m) => { logs.push(m); }, store: memoryStore(), read, logs };
}
