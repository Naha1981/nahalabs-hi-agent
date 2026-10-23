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
  morning_brief_auto boolean NOT NULL DEFAULT false,  -- Settings opt-in: auto-send own morning brief
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

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
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
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, password_resets TO hi_app;
GRANT SELECT, INSERT ON email_log TO hi_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hi_app;

-- ===== Agent platform (phase 1) =====
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  persona text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Conversation',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  steps jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'archival' CHECK (kind IN ('core','archival')),
  content text NOT NULL CHECK (char_length(content) <= 1000),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_tsv_idx ON memories USING gin (tsv);
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL,
  instruction text NOT NULL CHECK (char_length(instruction) <= 2000),
  interval_minutes integer CHECK (interval_minutes IS NULL OR interval_minutes >= 60),
  next_run_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done')),
  last_run_at timestamptz,
  created_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed','budget')),
  result text,
  steps jsonb NOT NULL DEFAULT '[]',
  sources jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agents','conversations','messages','memories','tasks','runs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON agents, conversations, messages, memories, tasks, runs TO hi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hi_app;

-- ===== Browser jobs (phase 2) =====
CREATE TABLE IF NOT EXISTS browser_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  start_url text NOT NULL,
  goal text NOT NULL CHECK (char_length(goal) <= 1500),
  mode text NOT NULL DEFAULT 'read' CHECK (mode IN ('read','act')),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','queued','running','awaiting_approval','done','failed','rejected','expired')),
  token_hash text,
  token_expires_at timestamptz,
  step_count integer NOT NULL DEFAULT 0,
  pending jsonb,
  result text,
  log jsonb NOT NULL DEFAULT '[]',
  screenshots jsonb NOT NULL DEFAULT '[]',
  approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
ALTER TABLE browser_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON browser_jobs;
CREATE POLICY tenant_isolation ON browser_jobs USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON browser_jobs TO hi_app;
-- The runner authenticates with a one-job token, not a session, so lookup by id happens in a SECURITY DEFINER function that
-- returns the tenant only when the token hash matches.
CREATE OR REPLACE FUNCTION browser_job_tenant(p_job uuid, p_hash text) RETURNS uuid AS $$
  SELECT tenant_id FROM browser_jobs WHERE id = p_job AND token_hash = p_hash AND token_expires_at > now() AND status IN ('queued','running','awaiting_approval');
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION browser_job_tenant(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION browser_job_tenant(uuid, text) TO hi_app;

-- ===== WhatsApp connector (phase 2, engine-agnostic; simulator until a number is linked) =====
CREATE TABLE IF NOT EXISTS wa_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE CHECK (number ~ '^[0-9]{8,15}$' AND number !~ '^27(67|61)'),  -- the 067 and 061 outreach lines are never used for HI
  engine text NOT NULL DEFAULT 'simulator' CHECK (engine IN ('simulator','own_engine','meta_cloud')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wa_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone text NOT NULL CHECK (phone ~ '^[0-9]{8,15}$'),
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE TABLE IF NOT EXISTS wa_messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  body text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','ignored','queued','sent','failed')),
  external_id text,
  conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_ext ON wa_messages (tenant_id, external_id) WHERE external_id IS NOT NULL;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['wa_channels','wa_contacts','wa_messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON wa_channels, wa_contacts, wa_messages TO hi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hi_app;
CREATE OR REPLACE FUNCTION wa_channel_lookup(p_number text) RETURNS TABLE (tenant_id uuid, agent_id uuid, engine text) AS $$
  SELECT c.tenant_id, c.agent_id, c.engine FROM wa_channels c JOIN tenants t ON t.id = c.tenant_id WHERE c.number = p_number AND c.status='active' AND NOT t.paused;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION wa_channel_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wa_channel_lookup(text) TO hi_app;

-- ===== Multi-agent planner and skills registry (phase 3) =====
CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9\-]{1,40}$'),
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL CHECK (char_length(instructions) <= 2000),
  tools jsonb NOT NULL DEFAULT '[]',
  builtin boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  goal text NOT NULL CHECK (char_length(goal) <= 1500),
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','running','done','failed')),
  steps jsonb NOT NULL DEFAULT '[]',
  answer text,
  created_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skills','plans']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON skills, plans TO hi_app;

-- ===== Public keyed API (phase 3) =====
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON api_keys;
CREATE POLICY tenant_isolation ON api_keys USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO hi_app;
-- Bearer-token lookup without a tenant context: returns the tenant only for a live key hash.
CREATE OR REPLACE FUNCTION api_key_lookup(p_hash text) RETURNS TABLE (tenant_id uuid, key_id uuid) AS $$
  SELECT k.tenant_id, k.id FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
  WHERE k.key_hash = p_hash AND k.status = 'active' AND NOT t.paused;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION api_key_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_lookup(text) TO hi_app;

-- ===== Agent file generation (phase 3) =====
CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 120),
  mime text NOT NULL,
  content text NOT NULL CHECK (char_length(content) <= 200000),
  created_by text NOT NULL DEFAULT 'agent',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON files;
CREATE POLICY tenant_isolation ON files USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON files TO hi_app;

-- ===== User-connected integrations (phase 4): Gmail, Outlook, Google/Outlook Calendar =====
CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google','microsoft')),
  account_email text NOT NULL,
  scopes text NOT NULL DEFAULT '',
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, account_email)
);
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integrations;
CREATE POLICY tenant_isolation ON integrations USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations TO hi_app;

-- Column additions for existing databases (CREATE TABLE IF NOT EXISTS cannot add columns)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS morning_brief_auto boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS surfaced_at timestamptz;

-- ===== Real estate module =====
CREATE TABLE IF NOT EXISTS re_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('buyer','seller','landlord','tenant','other')),
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE re_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON re_contacts;
CREATE POLICY tenant_isolation ON re_contacts USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON re_contacts TO hi_app;

CREATE TABLE IF NOT EXISTS re_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title text NOT NULL,
  asking_price text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sole_mandate','sold','withdrawn')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE re_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_properties FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON re_properties;
CREATE POLICY tenant_isolation ON re_properties USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON re_properties TO hi_app;

CREATE TABLE IF NOT EXISTS re_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES re_properties(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES re_contacts(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'enquiry' CHECK (stage IN ('enquiry','viewing','offer','otp_signed','bond_pending','transfer_attorneys','registered','fallen_through')),
  next_action text NOT NULL DEFAULT '',
  next_action_date date,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE re_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_deals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON re_deals;
CREATE POLICY tenant_isolation ON re_deals USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON re_deals TO hi_app;
CREATE INDEX IF NOT EXISTS re_deals_followup ON re_deals (tenant_id, next_action_date) WHERE next_action_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS re_viewings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES re_properties(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES re_contacts(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','done','no_show','cancelled')),
  feedback text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE re_viewings ENABLE ROW LEVEL SECURITY;
ALTER TABLE re_viewings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON re_viewings;
CREATE POLICY tenant_isolation ON re_viewings USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON re_viewings TO hi_app;
