ALTER TABLE sources DROP CONSTRAINT sources_connector_check;
ALTER TABLE sources ADD CONSTRAINT sources_connector_check
  CHECK (connector IN ('manual','fixture','vanish','confluence'));

ALTER TABLE requirements DROP CONSTRAINT requirements_status_check;
ALTER TABLE requirements ADD CONSTRAINT requirements_status_check
  CHECK (status IN ('draft','ready','stale'));
ALTER TABLE deliveries ADD COLUMN input_stale boolean NOT NULL DEFAULT false;

CREATE TABLE source_scopes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  connector text NOT NULL CHECK (connector IN ('vanish','confluence')),
  external_scope_id text NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,connector,external_scope_id)
);
CREATE TABLE scope_items (
  scope_id uuid NOT NULL REFERENCES source_scopes(id),
  external_id text NOT NULL,
  latest_source_id uuid NOT NULL REFERENCES sources(id),
  latest_revision text NOT NULL,
  latest_digest text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_id,external_id)
);
CREATE TABLE intake_runs (
  id uuid PRIMARY KEY,
  scope_id uuid NOT NULL REFERENCES source_scopes(id),
  status text NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  start_page integer NOT NULL CHECK (start_page BETWEEN 1 AND 10000),
  next_page integer NOT NULL CHECK (next_page BETWEEN 1 AND 10001),
  max_pages integer NOT NULL CHECK (max_pages BETWEEN 1 AND 20),
  pages_read integer NOT NULL DEFAULT 0,
  records_seen integer NOT NULL DEFAULT 0,
  new_versions integer NOT NULL DEFAULT 0,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX intake_runs_scope_status ON intake_runs(scope_id,status,started_at);
CREATE TABLE intake_pages (
  run_id uuid NOT NULL REFERENCES intake_runs(id),
  page integer NOT NULL,
  records_seen integer NOT NULL,
  has_more boolean NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(run_id,page)
);
CREATE TABLE product_drafts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  source_ids uuid[] NOT NULL,
  content jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('review','approved','stale')),
  requirement_id uuid REFERENCES requirements(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX product_drafts_project ON product_drafts(project_id,created_at);
