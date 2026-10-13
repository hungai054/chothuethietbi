import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { migrate } from './migrate';
import { seed } from './seed';

const ROOT = resolve(import.meta.dirname, '../../..');
const DATA = resolve(ROOT, '.data/pg');
const PORT = Number(process.env.PG_PORT ?? 5432);
const ADMIN = process.env.DATABASE_ADMIN_URL ?? `postgresql://postgres:postgres@localhost:${PORT}/rentpro`;

async function startEmbedded(): Promise<EmbeddedPostgres> {
  const fresh = !existsSync(DATA);
  const pgs = new EmbeddedPostgres({ databaseDir: DATA, user: 'postgres', password: 'postgres', port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  if (fresh) await pgs.initialise();
  await pgs.start();
  if (fresh) await pgs.createDatabase('rentpro');
  return pgs;
}

async function dropAll(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

const cmd = process.argv[2];
if (cmd === 'dev-pg') {
  const server = await startEmbedded();
  console.log('migrate:', await migrate(ADMIN));
  await seed(ADMIN);
  console.log(`PostgreSQL dev đang chạy: ${ADMIN}  (Ctrl+C để dừng)`);
  const stop = async () => { await server.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
} else if (cmd === 'reset') {
  // Cần Postgres đang chạy (pnpm dev:pg hoặc server riêng, trỏ bằng DATABASE_ADMIN_URL).
  if (!process.env.DATABASE_ADMIN_URL && process.env.NODE_ENV === 'production') throw new Error('Không reset ở production');
  await dropAll(ADMIN);
  console.log('migrate:', await migrate(ADMIN));
  await seed(ADMIN);
  console.log('Đã reset và seed.');
} else if (cmd === 'wipe-local') {
  rmSync(DATA, { recursive: true, force: true });
} else {
  console.log('Dùng: dev-pg | reset | wipe-local');
}
