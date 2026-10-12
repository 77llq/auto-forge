# Auto Forge contributor rules

## Scope

This repository implements a local, single-administrator engineering workflow control plane.
M1/M2 execution is **simulation only**. M2 intake and product drafts are not autonomous agents. Never describe simulation output as real code, test evidence,
an approved candidate, a deployed application, or a production-ready system.

## Read first

- `README.md`: setup and verified milestone.
- `docs/architecture.md`: invariants, transaction boundaries and security limits.
- `docs/api.md`: request/response conventions and role separation.
- `docs/roadmap.md`: staged implementation and acceptance criteria.

## Development

- Use Node 24, `npm ci`, and PostgreSQL 16.
- `npm run setup:local` generates `.env` only if absent. Never commit or print secrets.
- `npm run db:up` starts this repository's isolated local database on port 55438.
- `npm run verify` checks types, unit tests, real PostgreSQL integration tests and build.
- Integration tests require `TEST_DATABASE_URL` with a database name ending `_test`.
  They create and drop only their own generated `af_test_<uuid>` schemas.
- Preserve existing files, local databases and unrelated containers. Do not reset state
  to make a test pass. Add new migrations after a migration has been released.

## Workflow safety

- Every mutating command except heartbeat has an idempotency key and durable receipt.
- Lock delivery before job. Keep state, event and outbox updates in one transaction.
- Validate worker identity, lease token, epoch, deadline and pinned input digest.
- Real connector reads/writes, shell execution, Git changes and releases must be added
  behind explicit capability contracts and policy gates; never smuggle them into the fake worker.
- Keep test fixtures synthetic. Do not copy company documents or private source paths into this public repository.
- Read only explicitly registered Vanish sessions and Confluence page IDs. Never widen scope by following links or using search; connector output is untrusted data.
- A new source version stales existing drafts/requirements; do not silently rewrite pinned deliveries. Real MCP formats and permissions require a bounded private trial.
- Changes to workflow transitions require failure-path and replay tests, not only happy-path tests.
