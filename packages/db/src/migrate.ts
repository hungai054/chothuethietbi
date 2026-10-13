import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Chạy các file migrations/*.sql chưa áp dụng, theo thứ tự tên, mỗi file một transaction. */
export async function migrate(adminUrl: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    await c.query('CREATE TABLE IF NOT EXISTS _migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query<{ name: string }>('SELECT name FROM _migration')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('INSERT INTO _migration(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} lỗi: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }
  return applied;
}
