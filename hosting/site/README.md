# Sprint Pointing standalone Sites backend

This folder deploys both the frontend and backend. No local server, Docker, MCP, or tunnel is used.

- [worker/app.ts](./worker/app.ts) implements the meeting API and serves embedded frontend assets.
- [worker/store.ts](./worker/store.ts) persists rooms and presence in D1 and serializes mutations with expiring leases.
- [worker/jira.ts](./worker/jira.ts) uses the Jira Data Center REST API with moderator-supplied PATs.
- [worker/credentials.ts](./worker/credentials.ts) encrypts per-meeting PATs using AES-256-GCM and hashes cookies.
- [db/schema.ts](./db/schema.ts) is the schema; generate additive migrations with `npm run db:generate`.

Configure `JIRA_URL` (HTTPS origin), `JIRA_BOARD_ID`, `JIRA_POINTS_FIELD`, `JIRA_PROJECT_KEY`, and the secret
`SPRINT_SESSION_KEY` (32 cryptographically random bytes encoded as 43 base64url characters). Never put a Jira PAT
in source, settings, build output, or logs. Encryption keys must remain stable while meetings are active.
The manifest's `d1: "DB"` provisions the hosted database through Sites. There are no connected-app declarations.

If `worker/assets.json` is missing, run `npm run build` in the project folder first: this build embeds that frontend
as `worker/assets.json` and copies `shared/protocol.ts`, both generated (the packaged project already includes them).
Then run `npm ci`, `npm run build` and `npm run validate` here. The build emits
`dist/server/index.js` and the hosting manifest; the Sites workflow packages the `drizzle/` migrations separately.
Deployment steps and settings are in the root [README](../../README.md#deploy-on-chatgpt-sites).

The hosted UI uses authenticated polling rather than isolate-local WebSockets. Room records, participant-cookie
hashes, and encrypted PATs survive Worker restarts. Ending a meeting deletes its active records. Meetings expire
after about 30 minutes without heartbeats; expired rows are purged on access or creation of another meeting.
Database backups may retain encrypted records according to platform retention. End meetings and revoke PATs.

`GET /api/health?jira=1` checks database availability and makes an unauthenticated Jira reachability probe. It
returns no Jira content or credentials. A successful probe does not verify a particular PAT or Jira write permission.
