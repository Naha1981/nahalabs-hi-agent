import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/migrate.js';
import { closePool, getPool } from '../src/db.js';

export async function startDb(port) {
  const dir = mkdtempSync(join(tmpdir(), 'hi-pg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pgpass', port, persistent: false });
  await server.initialise();
  await server.start();
  await server.createDatabase('hi');
  const ownerUrl = `postgres://postgres:pgpass@127.0.0.1:${port}/hi`;
  const appPw = 'test_app_password_0123456789';
  await migrate(ownerUrl, appPw);
  const appUrl = `postgres://hi_app:${appPw}@127.0.0.1:${port}/hi`;
  process.env.DATABASE_URL = appUrl;
  return { server, ownerUrl, appUrl, stop: async () => { await closePool(); await server.stop(); } };
}
export const owner = (url) => new pg.Client({ connectionString: url });
export { getPool };
