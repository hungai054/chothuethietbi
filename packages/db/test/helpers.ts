import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate, createPool } from '../src';

export interface TestDb {
  admin: pg.Pool;
  app: pg.Pool;
  platform: pg.Pool;
  stop(): Promise<void>;
}

/** Postgres thật: dùng TEST_DATABASE_ADMIN_URL nếu có, ngược lại bật embedded-postgres. */
export async function startTestDb(port = 54329): Promise<TestDb> {
  let stopFn = async () => {};
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  let appUrl = process.env.TEST_DATABASE_URL;
  let platformUrl = process.env.TEST_DATABASE_PLATFORM_URL;
  if (!adminUrl) {
    const dir = mkdtempSync(join(tmpdir(), 'rentpro-pg-'));
    const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
    await server.initialise();
    await server.start();
    await server.createDatabase('rentpro_test');
    adminUrl = `postgresql://postgres:postgres@localhost:${port}/rentpro_test`;
    appUrl = `postgresql://rentpro_app:rentpro_app@localhost:${port}/rentpro_test`;
    platformUrl = `postgresql://rentpro_admin:rentpro_admin@localhost:${port}/rentpro_test`;
    stopFn = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
  }
  await migrate(adminUrl);
  const admin = createPool(adminUrl);
  const app = createPool(appUrl);
  const platform = createPool(platformUrl ?? adminUrl);
  return {
    admin,
    app,
    platform,
    stop: async () => {
      await app.end();
      await platform.end();
      await admin.end();
      await stopFn();
    },
  };
}
