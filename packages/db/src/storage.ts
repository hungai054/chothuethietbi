import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Lưu file riêng tư. Đường dẫn LUÔN bắt đầu bằng `tenants/<tenantId>/` và do hệ thống tự sinh (không dùng tên file của người dùng).
 * Bản production dùng adapter S3-compatible với cùng interface; truy cập qua URL ký có thời hạn, không công khai.
 */
export interface StorageAdapter {
  put(path: string, data: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  delete(path: string): Promise<void>;
}

export function newPrivatePath(tenantId: string, area: string, ext: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[a-z0-9_-]+$/.test(area) || !/^[a-z0-9]{1,5}$/.test(ext)) throw new Error('Đường dẫn lưu trữ không hợp lệ');
  return `tenants/${tenantId}/${area}/${randomBytes(16).toString('hex')}.${ext}`;
}

/** Chỉ cho phép đọc/xóa đường dẫn thuộc đúng tenant, chống `..` và tenant khác. */
export function assertTenantPath(tenantId: string, path: string): void {
  if (!path.startsWith(`tenants/${tenantId}/`) || path.includes('..') || path.includes('\\') || path.includes('//')) throw new Error('Đường dẫn không thuộc cửa hàng này');
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Lưu trên đĩa cục bộ (dev / cài riêng một máy chủ). Thư mục gốc nằm ngoài thư mục công khai của web. */
export class LocalFsStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  private full(path: string): string {
    const root = resolve(this.root);
    const f = resolve(root, path);
    if (!f.startsWith(root + sep)) throw new Error('Đường dẫn không hợp lệ');
    return f;
  }
  async put(path: string, data: Uint8Array): Promise<void> {
    const f = this.full(path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, data, { mode: 0o600 });
  }
  async get(path: string) {
    try {
      const data = await readFile(this.full(path));
      return { data: new Uint8Array(data), contentType: MIME[path.split('.').pop() ?? ''] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }
  async delete(path: string): Promise<void> {
    await rm(this.full(path), { force: true });
  }
}

/** Dùng cho test. */
export class MemoryStorage implements StorageAdapter {
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  async put(path: string, data: Uint8Array, contentType: string) { this.files.set(path, { data, contentType }); }
  async get(path: string) { return this.files.get(path) ?? null; }
  async delete(path: string) { this.files.delete(path); }
}
