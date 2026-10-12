CREATE TABLE projects (
  id uuid PRIMARY KEY, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sources (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
  connector text NOT NULL CHECK (connector IN ('manual','fixture')),
  external_id text NOT NULL, source_revision text NOT NULL,
  content text NOT NULL, digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, connector, external_id, source_revision)
);
CREATE TABLE requirements (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
  revision integer NOT NULL CHECK (revision=1),
  content jsonb NOT NULL, digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','ready')),
  ready_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE deliveries (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
  requirement_id uuid NOT NULL REFERENCES requirements(id), input_digest text NOT NULL,
  mode text NOT NULL CHECK (mode='simulation'),
  phase text NOT NULL CHECK (phase IN ('queued','running','simulation_completed','failed','cancelled')),
  control_state text NOT NULL CHECK (control_state IN ('active','paused')),
  revision integer NOT NULL DEFAULT 1,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 3),
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES deliveries(id),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 3), step text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0, epoch integer NOT NULL DEFAULT 0,
  worker_id text, lease_token uuid, lease_expires_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_id, step_index),
  CHECK ((status='running') = (worker_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE TABLE attempts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id),
  ordinal integer NOT NULL, epoch integer NOT NULL, worker_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','expired','cancelled')),
  reason text, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  UNIQUE (job_id, ordinal)
);
CREATE TABLE domain_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL UNIQUE, delivery_id uuid REFERENCES deliveries(id),
  type text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE outbox (
  event_id uuid PRIMARY KEY REFERENCES domain_events(id),
  delivered_at timestamptz
);
CREATE TABLE inbox (
  consumer text NOT NULL, event_id uuid NOT NULL REFERENCES domain_events(id),
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer, event_id)
);
CREATE TABLE command_receipts (
  key text PRIMARY KEY, request_digest text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX jobs_claim ON jobs(status, lease_expires_at);
CREATE INDEX deliveries_dispatch ON deliveries(control_state, phase, created_at);
CREATE INDEX events_delivery ON domain_events(delivery_id, sequence);
CREATE INDEX outbox_pending ON outbox(event_id) WHERE delivered_at IS NULL;
