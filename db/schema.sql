-- HI Opportunity Desk schema. Tenant tables use row-level security.
-- The application connects as hi_app (no BYPASSRLS, not table owner).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hi_app') THEN
    CREATE ROLE hi_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  paused boolean NOT NULL DEFAULT false,          -- tenant emergency stop
  model_budget_cents_month integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  pw_hash text NOT NULL,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_flags (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Shared public data (National Treasury eTenders OCDS, licence PDDL 1.0). No tenant data here.
CREATE TABLE IF NOT EXISTS tenders (
  ocid text PRIMARY KEY,
  tender_no text,
  title text,
  description text,
  category text,
  method text,
  buyer text,
  opens_at timestamptz,
  closes_at timestamptz,
  documents jsonb NOT NULL DEFAULT '[]',
  source_url text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenders_closes_idx ON tenders (closes_at);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  date_from date, date_to date,
  pages integer DEFAULT 0, upserted integer DEFAULT 0,
  error text
);

-- Tenant tables
CREATE TABLE IF NOT EXISTS profiles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  company_name text,
  keywords text[] NOT NULL DEFAULT '{}',
  exclude_keywords text[] NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',          -- goods, services, works
  buyer_terms text[] NOT NULL DEFAULT '{}',         -- e.g. municipality names / provinces to favour
  notes text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ocid text NOT NULL REFERENCES tenders(ocid) ON DELETE CASCADE,
  score integer NOT NULL,
  reasons jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','saved','dismissed','applied','won','lost')),
  dismiss_reason text,
  ai_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ocid)
);

CREATE TABLE IF NOT EXISTS vault_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  title text NOT NULL,
  reference text,
  expires_on date,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,                  -- dismiss_buyer, dismiss_term, preference, outcome
  subject text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject text NOT NULL,
  body_text text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','rejected','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL,                  -- send_brief
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','executed','failed','cancelled')),
  proposed_by text NOT NULL,           -- 'agent:<name>' or 'user:<id>'
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_usage (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL, model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0, completion_tokens integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  to_addr text NOT NULL,
  subject text NOT NULL,
  provider_id text,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log
CREATE OR REPLACE FUNCTION audit_no_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_no_change();

-- Row-level security on every tenant table
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','matches','vault_docs','memory_notes','briefs','approvals','model_usage']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;

-- audit_log: tenant rows readable only for the current tenant; inserts allowed for the current tenant or system (null)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_read ON audit_log;
CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS audit_insert ON audit_log;
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Grants for the app role. No UPDATE/DELETE on audit_log.
GRANT USAGE ON SCHEMA public TO hi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles, matches, vault_docs, memory_notes, briefs, approvals, model_usage TO hi_app;
GRANT SELECT, INSERT ON audit_log TO hi_app;
GRANT SELECT, INSERT, UPDATE ON tenders, ingest_runs, system_flags, tenants TO hi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions TO hi_app;
GRANT SELECT, INSERT ON email_log TO hi_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hi_app;
