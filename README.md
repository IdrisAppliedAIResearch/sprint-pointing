# Sprint Pointing

Story pointing for one team's sprint planning meeting. The moderator connects Jira with a personal access token (or
types custom tickets), picks tickets from a sprint, and the team votes. Finish Voting writes the estimate to the
ticket's Story Points. The Completed Stories tab is the index: change or revert any estimate and Jira is updated right
away. The moderator can also edit a ticket's summary and description during the meeting.

There are no accounts. A session is one meeting and ends when the moderator ends it or after about 30 minutes of
inactivity.

Requires Jira Data Center or Server with personal access tokens (REST API v2 and the Agile API). Jira Cloud is not
supported.

## Deploy on ChatGPT Sites

`hosting/site` is a standalone Site: it serves the frontend, keeps meeting state in its D1 database, and calls Jira's
REST API directly. Nothing runs on the moderator's computer. To have ChatGPT do it, ask:

> Clone this repository and deploy it to Sites by following the README's "Deploy on ChatGPT Sites" steps.

1. Build. The Site embeds the frontend built at the repository root, so build the root first:

   ```sh
   npm ci && npm run build
   cd hosting/site && npm ci && npm run build && npm run validate
   ```

2. Publish `hosting/site` as a new Site. Its `.openai/hosting.json` declares the D1 database (`d1: "DB"`) and has no
   project ID, so the first publish creates your own Site. The publishing workflow applies the `drizzle/` migrations.
3. Set these in the Site's environment settings:

   | Variable | |
   |---|---|
   | `JIRA_URL` | Jira base URL over HTTPS, e.g. `https://jira.example.com` |
   | `JIRA_BOARD_ID` | Board whose active and future sprints are offered (the `rapidView` number in the board URL) |
   | `JIRA_PROJECT_KEY` | Only this project's tickets can be added, e.g. `ABC` |
   | `JIRA_POINTS_FIELD` | Story Points field ID, e.g. `customfield_10106` (listed by `GET /rest/api/2/field`) |
   | `SPRINT_SESSION_KEY` | **Secret**, 32 random bytes as base64url: `node -p "require('node:crypto').randomBytes(32).toString('base64url')"` |

   Never put a Jira PAT in settings. Keep `SPRINT_SESSION_KEY` stable while meetings are active.
4. Keep the Site private to your workspace, then check `/api/health?jira=1`. Jira must be reachable from the Sites
   runtime. If your Jira only answers inside a VPN, run the app locally instead (below).

## A session

1. Start page: enter your name, pick a deck and the point range, then paste your Jira PAT and press **Connect Jira**,
   or press **Use custom tickets**. You are the moderator.
2. Pick a sprint and the tickets to estimate. Share the invite link; each teammate joins with a name.
3. **Start**, everyone votes, the cards flip when everyone has voted (or press **Flip Cards**), then **Finish Voting**
   with the final estimate. In a Jira session that writes Story Points immediately.
   The ticket's description shows while voting. The moderator edits it, or the summary in the ticket's details, with
   the pen button; ✓ writes it to Jira as wiki markup.
4. **Completed Stories** is the index. Change an estimate there, or open a story to see its history and revert to an
   earlier value (including the value Jira had before the meeting). Each change goes to Jira at once; failures show
   **Retry**.
5. **Export** downloads the estimates as CSV. **End session** ends it for everyone.

## The token

- The moderator enters a PAT when starting a meeting. It is never part of the source, a build, or deployment settings.
  The backend sends it only to Jira, as `Authorization: Bearer`.
- On Sites, the PAT is encrypted with AES-256-GCM under `SPRINT_SESSION_KEY`, with the meeting ID as authenticated
  data, and only the ciphertext is stored in D1. Participant cookies are stored as SHA-256 hashes. API responses never
  contain the PAT, its ciphertext, or hashes.
- Ending a meeting deletes its records. Expired meetings are purged on access or when another meeting starts. Platform
  database backups may keep encrypted records under their own retention, so revoke the PAT when you no longer need it.
- The local server keeps the PAT only in memory.
- Every Jira write triggers Jira's normal "issue updated" notifications.

## Run locally (optional)

The local server keeps sessions in memory and reaches Jira through [mcp-atlassian](https://github.com/sooperset/mcp-atlassian)
in Docker. Use it when Jira is only reachable from your network.

```sh
cp .env.example .env          # then fill it in
docker compose up -d          # the Jira MCP server on 127.0.0.1:9800 (holds no credentials)
npm ci
npm run build
npm start                     # http://localhost:3000
```

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Listen address |
| `JIRA_URL` | | Jira base URL, for ticket links and the MCP server |
| `JIRA_MCP_URL` | | The MCP server, `http://127.0.0.1:9800/mcp` with the compose file |
| `JIRA_BOARD_ID` | | Board whose active and future sprints are offered |
| `JIRA_PROJECT_KEY` | | The only project the MCP server will touch |
| `JIRA_POINTS_FIELD` | `customfield_10106` | Story Points field |

The compose file limits the MCP server to the three tools the app uses (sprint list, search, update issue).

Teammates need to reach the app, so for a real meeting serve it over HTTPS on a host they can reach, e.g. a TLS proxy
in front of the default `HOST=127.0.0.1`. The proxy must send `X-Forwarded-Proto` so session cookies get `Secure`
(Caddy does by default; nginx needs `proxy_set_header X-Forwarded-Proto $scheme;`). The start page refuses to send a
token over plain HTTP unless the page is on localhost.

`hosting/launch-local.mjs` and `hosting/legacy-gateway.js` are an earlier tunnel-based trial and are not needed for
either setup.

## Development

```sh
node test/fake-jira.ts                                                 # fake Jira MCP on 127.0.0.1:9100, any token but "bad-token"
JIRA_MCP_URL=http://127.0.0.1:9100/mcp JIRA_BOARD_ID=9001 npm run dev  # server on :3000, Vite on http://localhost:5173
npm run typecheck
npm test                                                               # needs both builds above (the Sites tests load the bundle's assets)
npm run e2e                                                            # Playwright, two browsers, against the fake
npm run e2e:cloud                                                      # the same against the Sites backend and a fake Jira REST API
```

| Path | |
|---|---|
| `server/rooms.ts` | Local server: sessions, participants, voting, WebSocket snapshots, the index |
| `server/jira.ts` | Local server's MCP client: sprints, issues, verified writes |
| `hosting/site/worker` | Sites backend: API, D1 store, direct Jira REST client, PAT encryption |
| `web/src` | React app (start page, room, dialogs) |
| `shared/protocol.ts` | Types and decks shared by every side |
| `test/fake-jira.ts` | Fake mcp-atlassian with the real tool shapes |

Schema changes go in `hosting/site/db/schema.ts`; run `npm --prefix hosting/site run db:generate` and never edit
migrations that were already applied.
