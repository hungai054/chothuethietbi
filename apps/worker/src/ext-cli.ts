import { applyExtensionMigrations } from '@rentpro/db';
import { checkCompatibility, listExtensions, validateDefinition } from '@rentpro/extension-sdk';
import pg from 'pg';
import './extensions.generated';

/**
 * Công cụ dòng lệnh cho extension:
 *  - check:   kiểm tra mọi extension đã cài (định nghĩa, tương thích SDK, migration). Thoát mã 1 nếu có lỗi (dùng trong CI).
 *  - migrate: áp migration riêng của extension bằng kết nối quản trị CSDL (DATABASE_ADMIN_URL), mỗi migration một lần.
 */
async function main() {
  const cmd = process.argv[2];
  const exts = listExtensions();
  if (cmd === 'check') {
    let bad = 0;
    for (const d of exts) {
      const errs = validateDefinition(d);
      const compat = checkCompatibility(d.manifest);
      console.log(`${errs.length || compat ? '✗' : '✓'} ${d.manifest.code} v${d.manifest.version} (SDK ${d.manifest.sdk}) · móc: ${d.manifest.hooks.join(', ') || '—'} · báo cáo ${d.reports?.length ?? 0} · trang ${d.pages?.length ?? 0} · tác vụ ${d.jobs?.length ?? 0}`);
      for (const e of errs) { console.log(`    - ${e}`); bad++; }
    }
    console.log(exts.length ? `\n${exts.length} extension, ${bad} lỗi.` : 'Chưa có extension nào.');
    process.exit(bad ? 1 : 0);
  }
  if (cmd === 'migrate') {
    const url = process.env.DATABASE_ADMIN_URL;
    if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL (kết nối quản trị CSDL, như khi chạy migrate lõi).');
    const pool = new pg.Pool({ connectionString: url });
    try {
      const applied = await applyExtensionMigrations(pool, exts);
      console.log(applied.length ? `Đã áp dụng: ${applied.join(', ')}` : 'Không có migration extension mới.');
    } finally {
      await pool.end();
    }
    return;
  }
  console.error('Cách dùng: ext-cli <check|migrate>');
  process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
