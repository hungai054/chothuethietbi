import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Nạp file .env ở gốc repo cho các lệnh CLI (biến đã đặt sẵn trong môi trường được ưu tiên). */
export function loadRootEnv(): void {
  const f = resolve(import.meta.dirname, '../../../.env');
  if (existsSync(f)) process.loadEnvFile(f);
}
