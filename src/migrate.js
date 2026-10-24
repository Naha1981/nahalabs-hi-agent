// Runs with an owner connection (MIGRATE_DATABASE_URL), never the app role.
import pg from 'pg';
import { schemaSql } from './db.js';

export async function migrate(url, appPassword) {
  const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true } });
  await c.connect();
  try {
    await c.query(schemaSql());
    // Only (re)set the app password when asked: re-setting it on every migration briefly breaks pooled connections.
    const login = (await c.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='hi_app'")).rows[0]?.rolcanlogin;
    if (appPassword && (!login || process.env.FORCE_APP_PASSWORD === 'true')) {
      if (!/^[A-Za-z0-9_\-]{20,}$/.test(appPassword)) throw new Error('HI_APP_PASSWORD must be 20+ chars of [A-Za-z0-9_-]');
      await c.query(`ALTER ROLE hi_app LOGIN PASSWORD '${appPassword}'`);
    }
  } finally { await c.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) { console.error('MIGRATE_DATABASE_URL is not set'); process.exit(1); }
  await migrate(url, process.env.HI_APP_PASSWORD);
  console.log('migration complete');
}
