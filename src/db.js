import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
let pool;

export function getPool(url = process.env.DATABASE_URL) {
  if (!pool) {
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX || 5),
      ssl: process.env.DB_SSL === 'disable' ? false : (url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false }),
      statement_timeout: 15000,
    });
  }
  return pool;
}
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }

// Run fn inside a transaction scoped to one tenant. RLS then limits every tenant table to that tenant.
export async function withTenant(tenantId, fn, p = getPool()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(tenantId))) throw new Error('invalid tenant id');
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
}

// Run fn with no tenant set: only shared public tables and auth tables are usable.
export async function withSystem(fn, p = getPool()) {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
}

export async function audit(c, tenantId, actor, action, detail = {}) {
  await c.query('INSERT INTO audit_log (tenant_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
    [tenantId, actor, action, JSON.stringify(detail)]);
}

// Audit from outside a tenant transaction (login, pause). Opens its own tenant-scoped transaction.
export async function auditFor(tenantId, actor, action, detail = {}) {
  if (!tenantId) return withSystem((c) => audit(c, null, actor, action, detail));
  return withTenant(tenantId, (c) => audit(c, tenantId, actor, action, detail));
}

export function schemaSql() {
  return readFileSync(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
}
