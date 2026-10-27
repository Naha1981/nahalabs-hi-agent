import test from 'node:test';
import assert from 'node:assert/strict';
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { assertSchemaReady } from '../src/db.js';

process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
delete process.env.GROQ_API_KEY;

// Boot readiness guard: the app must refuse to serve when the schema is incomplete, and
// start cleanly once migrations have run. Regression for the 23 Oct 2026 live incident where
// a deploy without the estate migration served 500s on /app/estate instead of failing the deploy.
test('schema guard fails on unmigrated DB and passes after migrate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hi-pg-guard-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pgpass', port: 54330, persistent: false });
  await server.initialise();
  await server.start();
  await server.createDatabase('hi');
  const ownerUrl = 'postgres://postgres:pgpass@127.0.0.1:54330/hi';
  try {
    const ownerPool = new pg.Pool({ connectionString: ownerUrl });
    await assert.rejects(() => assertSchemaReady(ownerPool), /missing tables[\s\S]*re_deals/);
    const appPw = 'test_app_password_0123456789';
    await migrate(ownerUrl, appPw);
    // assert through the least-privilege app role, mirroring production visibility
    const appPool = new pg.Pool({ connectionString: `postgres://hi_app:${appPw}@127.0.0.1:54330/hi` });
    try {
      await assertSchemaReady(appPool);
    } finally {
      await appPool.end();
      await ownerPool.end();
    }
  } finally {
    await server.stop();
  }
});

// Self-onboarding journey: signup signs the customer straight in with a working cookie,
// each signup is its own isolated tenant, and an existing email is rejected without merging
// or touching the existing account.
test('signup auto-login, tenant isolation, existing-email safety', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hi-pg-signup-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pgpass', port: 54331, persistent: false });
  await server.initialise();
  await server.start();
  await server.createDatabase('hi');
  const ownerUrl = 'postgres://postgres:pgpass@127.0.0.1:54331/hi';
  const appPw = 'test_app_password_0123456789';
  await migrate(ownerUrl, appPw);
  process.env.DATABASE_URL = `postgres://hi_app:${appPw}@127.0.0.1:54331/hi`;
  const { buildApp } = await import('../src/server.js');
  const app = await buildApp({ logger: false });
  const form = (o) => new URLSearchParams(o).toString();
  const H = { 'content-type': 'application/x-www-form-urlencoded' };
  try {
    // 1. signup returns a working session immediately - no manual sign-in step
    const s1 = await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ company: 'Alpha Props', email: 'alpha@example.test', password: 'a-long-test-password-1' }) });
    assert.equal(s1.statusCode, 302);
    assert.equal(s1.headers.location, '/app/agent');
    const cookie = String(s1.headers['set-cookie']).split(';')[0];
    assert.match(cookie, /^hi_session=/);
    assert.equal((await app.inject({ url: '/app/agent', headers: { cookie } })).statusCode, 200);
    // the estate page (the table set missing in the incident) renders for a brand-new tenant
    assert.equal((await app.inject({ url: '/app/templates/real-estate', headers: { cookie } })).statusCode, 200);

    // 2. second signup is a separate tenant; sessions see only their own data
    const s2 = await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ company: 'Beta Homes', email: 'beta@example.test', password: 'a-long-test-password-2' }) });
    assert.equal(s2.statusCode, 302);
    const cookie2 = String(s2.headers['set-cookie']).split(';')[0];
    const prof1 = await app.inject({ url: '/app/profile', headers: { cookie } });
    assert.match(prof1.body, /Alpha Props/);
    const prof2 = await app.inject({ url: '/app/profile', headers: { cookie: cookie2 } });
    assert.match(prof2.body, /Beta Homes/);
    assert.doesNotMatch(prof2.body, /Alpha Props/);

    // 3. existing email: rejected with a clear message, no new tenant, original session intact
    const o = new pg.Client({ connectionString: ownerUrl });
    await o.connect();
    const before = (await o.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n;
    const dup = await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ company: 'Alpha Props 2', email: 'alpha@example.test', password: 'another-long-password-3' }) });
    assert.equal(dup.statusCode, 302);
    assert.match(String(dup.headers.location), /already%20registered/);
    assert.equal((await o.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n, before);
    await o.end();
    assert.equal((await app.inject({ url: '/app/agent', headers: { cookie } })).statusCode, 200);

    // 4. per-field validation messages
    const short = await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ company: 'X', email: 'x@y.z', password: 'short' }) });
    assert.match(String(short.headers.location), /12%20or%20more/);
    const badEmail = await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ company: 'X', email: 'not-an-email', password: 'a-long-test-password-1' }) });
    assert.match(String(badEmail.headers.location), /valid%20email/);
  } finally {
    await app.close();
    await server.stop();
  }
});
