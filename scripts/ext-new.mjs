import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_RE, ROOT, syncExtensions } from './ext-lib.mjs';

const [, , code, ...nameParts] = process.argv;
if (!code || !CODE_RE.test(code)) {
  console.error('Cách dùng: pnpm ext:new <ma-khach-hang> ["Tên hiển thị"]\nMã gồm chữ thường, số, gạch ngang; 2–31 ký tự; bắt đầu bằng chữ (VD: cua-hang-abc).');
  process.exit(1);
}
const name = nameParts.join(' ').trim() || `Extension ${code}`;
const dest = join(ROOT, 'extensions', code);
if (existsSync(dest)) { console.error(`Đã có extensions/${code}. Chọn mã khác hoặc xóa thư mục cũ.`); process.exit(1); }

cpSync(join(ROOT, 'extensions', '_template'), dest, { recursive: true });
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
    const s = readFileSync(p, 'utf8').replaceAll('__CODE__', code).replaceAll('__NAME__', name);
    writeFileSync(p, s);
  }
};
walk(dest);
// package.json của bản sinh ra có script thật (bản mẫu để "echo skip" cho khỏi chạy test của mẫu)
const pj = join(dest, 'package.json');
const j = JSON.parse(readFileSync(pj, 'utf8'));
j.scripts = { typecheck: 'tsc --noEmit', lint: 'echo skip', test: 'vitest run' };
writeFileSync(pj, JSON.stringify(j, null, 2) + '\n');

const { changed } = syncExtensions();
console.log(`Đã tạo extensions/${code} (${name}).`);
console.log(`Các bước tiếp theo:\n  1. pnpm install\n  2. Sửa extensions/${code}/src/index.ts\n  3. pnpm --filter @rentpro-ext/${code} test && pnpm ext:check\n  4. Build lại ứng dụng rồi bật extension cho khách trong cổng quản trị.`);
if (changed.length === 0) console.log('(ext:sync không đổi gì)');
