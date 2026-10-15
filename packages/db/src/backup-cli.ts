import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { backupFileName, isSafeDbName, parseBackupName, selectBackupsToPrune, verifyDbName } from '@rentpro/core';
import { loadRootEnv } from './env';

/**
 * Sao lưu / kiểm tra khôi phục PostgreSQL bằng pg_dump + pg_restore (cần cài sẵn công cụ client của Postgres).
 *   backup          tạo rentpro-<UTC>.dump (định dạng custom, nén) + .sha256, dọn bản cũ (BACKUP_KEEP, mặc định 14)
 *   verify [tệp]    khôi phục bản mới nhất (hoặc tệp chỉ định) vào DATABASE tạm, so số dòng các bảng chính rồi xóa DB tạm
 * Biến môi trường: DATABASE_ADMIN_URL (bắt buộc), BACKUP_DIR (mặc định .data/backups), BACKUP_KEEP.
 * Thư mục ảnh/giấy tờ (STORAGE_DIR) cần sao lưu riêng (rsync/snapshot): xem docs/VAN_HANH.md.
 */
loadRootEnv();
const KEY_TABLES = ['tenant', 'app_user', 'customer', 'equipment_unit', 'booking', 'payment', 'audit_log'];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], env });
    p.on('error', (e) => fail(new Error(`Không chạy được "${cmd}": ${e.message}. Cài công cụ client của PostgreSQL (postgresql-client).`)));
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} thoát với mã ${code}`))));
  });
}

const sha256 = (file: string) => new Promise<string>((ok, fail) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
});

const adminUrl = () => {
  const u = process.env.DATABASE_ADMIN_URL;
  if (!u) throw new Error('Thiếu DATABASE_ADMIN_URL.');
  return u;
};
const dir = () => resolve(process.env.BACKUP_DIR ?? '.data/backups');
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

export async function backup(): Promise<string> {
  const d = dir();
  await mkdir(d, { recursive: true });
  const name = backupFileName(new Date());
  const file = resolve(d, name);
  await run('pg_dump', ['--format=custom', '--no-owner', '--file', file, '--dbname', adminUrl()]);
  const size = (await stat(file)).size;
  if (size < 1024) throw new Error(`Bản sao lưu bất thường (chỉ ${size} byte), đã giữ lại để kiểm tra: ${file}`);
  await writeFile(`${file}.sha256`, `${await sha256(file)}  ${name}\n`);
  const prune = selectBackupsToPrune(await readdir(d), Number(process.env.BACKUP_KEEP ?? 14));
  for (const n of prune) await Promise.all([rm(resolve(d, n), { force: true }), rm(resolve(d, `${n}.sha256`), { force: true })]);
  console.log(`[backup] ${file} (${(size / 1024 / 1024).toFixed(1)} MB), đã dọn ${prune.length} bản cũ`);
  return file;
}

async function counts(url: string): Promise<Record<string, number>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const out: Record<string, number> = {};
    for (const t of KEY_TABLES) out[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    return out;
  } finally { await c.end(); }
}

export async function verify(file?: string): Promise<void> {
  const d = dir();
  const target = file ? resolve(file) : resolve(d, (await readdir(d)).filter((n) => parseBackupName(n)).sort().pop() ?? '');
  if (!existsSync(target) || !parseBackupName(target.split(/[\\/]/).pop()!)) throw new Error('Không tìm thấy bản sao lưu để kiểm tra.');
  const sumFile = `${target}.sha256`;
  if (existsSync(sumFile)) {
    const want = (await readFile(sumFile, 'utf8')).split(/\s+/)[0];
    if (want !== (await sha256(target))) throw new Error('Mã băm SHA-256 không khớp: bản sao lưu đã bị hỏng.');
  }
  const url = adminUrl();
  const tmp = verifyDbName(new Date());
  if (!isSafeDbName(tmp)) throw new Error('Tên DB tạm không an toàn.');
  const admin = new pg.Client({ connectionString: withDb(url, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${tmp}`);
    try {
      await run('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', withDb(url, tmp), target]);
      const [live, restored] = [await counts(url), await counts(withDb(url, tmp))];
      const diff = KEY_TABLES.filter((t) => restored[t]! > live[t]! || (restored[t] === 0 && live[t]! > 0));
      console.log('[verify] số dòng (đang chạy → khôi phục):', KEY_TABLES.map((t) => `${t} ${live[t]}→${restored[t]}`).join(', '));
      if (diff.length) throw new Error(`Dữ liệu khôi phục bất thường ở bảng: ${diff.join(', ')}`);
      console.log(`[verify] OK: ${target} khôi phục được.`);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${tmp} WITH (FORCE)`);
    }
  } finally { await admin.end(); }
}

if (process.argv[1]?.endsWith('backup-cli.ts')) {
  const [cmd, arg] = process.argv.slice(2);
  const job = cmd === 'backup' ? backup() : cmd === 'verify' ? verify(arg) : Promise.reject(new Error('Dùng: backup | verify [tệp]'));
  job.catch((e) => { console.error(`[backup] LỖI: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
