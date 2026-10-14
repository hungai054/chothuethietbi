import { ROOT, syncExtensions } from './ext-lib.mjs';
import { relative } from 'node:path';

const { codes, changed } = syncExtensions();
console.log(codes.length ? `Extension: ${codes.join(', ')}` : 'Chưa có extension nào.');
for (const f of changed) console.log(`  cập nhật ${relative(ROOT, f)}`);
if (changed.some((f) => f.endsWith('package.json'))) console.log('\nPhụ thuộc đã đổi: chạy `pnpm install` rồi build lại các ứng dụng.');
