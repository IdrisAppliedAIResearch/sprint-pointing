// Offline stand-in for mcp-atlassian 0.23.1 as docker-compose.yml runs it (stateless streamable HTTP, each request
// carrying the user's PAT): same tools, arguments, payloads and error texts as the live capture, on a
// synthetic board 9001. Every PAT works except `bad-token`. The Jira state is shared per process.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, McpServer, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

const POINTS = 'customfield_10106';

const SPRINTS = [
  { id: '7001', name: 'FAKE Team A Sprint 12', state: 'active', goal: '1. Ship login.\n2. Ship voting.', start_date: '2026-10-07T19:00:00.000-04:00', end_date: '2026-10-21T23:59:00.000-04:00' },
  { id: '7002', name: 'FAKE Team B Sprint 12', state: 'active', start_date: '2026-10-07T12:00:00.000-04:00', end_date: '2026-10-21T12:00:00.000-04:00' },
  { id: '7003', name: 'FAKE Team A Sprint 13', state: 'future', start_date: '2026-10-22T19:00:00.000-04:00', end_date: '2026-11-04T23:59:00.000-04:00' },
];

const STATUSES = [
  ['To Do', 'To Do', 'default'],
  ['In Progress', 'In Progress', 'inprogress'],
  ['Done', 'Done', 'success'],
  ['In QA', 'In Progress', 'inprogress'],
  ['To Do', 'To Do', 'default'],
  ['On Hold', 'In Progress', 'inprogress'],
  ['Canceled', 'Done', 'success'],
];
const TYPES = ['Task', 'Story', 'Task', 'Bug', 'Story', 'Risk', 'Task', 'Story'];
const VERBS = ['Add', 'Fix', 'Update', 'Remove', 'Document', 'Test', 'Refactor'];
const THINGS = ['login page', 'voting cards', 'sprint picker', 'Jira sync', 'results chart', 'room list', 'invite link',
  'story timer', 'observer mode', 'password rotation ', 'audit log', 'session cookies'];
const PEOPLE = [['Tester', 'Alice', 'AT01'], ['Builder', 'Bob', 'BB02'], ['Coder', 'Carol', 'CC03']].map(([last, first, name], i) => ({
  account_id: null,
  display_name: `${last}, ${first}`,
  name,
  email: `${first}.${last}@example.test`.toLowerCase(),
  avatar_url: `https://jira.example.test/secure/useravatar?avatarId=${10122 + i}`,
  key: `JIRAUSER${100001 + i}`,
}));

// FAKE-1..55 in sprint 7001 (FAKE-20 is a Sub-task), 56..62 in 7002, 63..82 in 7003.
// Unestimated: FAKE-48..55 and FAKE-74..82. Rank order is a fixed shuffle: FAKE-n ranks at 37n mod 83.
const issues = Array.from({ length: 82 }, (_, i) => {
  const n = i + 1;
  const [name, category, color] = STATUSES[n % STATUSES.length];
  return {
    sprint: n <= 55 ? '7001' : n <= 62 ? '7002' : '7003',
    rank: (n * 37) % 83,
    fields: {
      id: String(900000 + n),
      key: `FAKE-${n}`,
      summary: `${VERBS[n % VERBS.length]} ${THINGS[n % THINGS.length]}`,
      browse_url: `https://jira.example.test/browse/FAKE-${n}`,
      status: { name, category, color },
      issue_type: { name: n === 20 ? 'Sub-task' : n === 30 ? 'Epic' : TYPES[n % TYPES.length] },
      assignee: n % 5 < 2 ? { display_name: 'Unassigned' } : PEOPLE[n % PEOPLE.length],
      [POINTS]: { value: (n >= 48 && n <= 55) || n >= 74 ? null : [0, 0.5, 1, 2, 3, 4, 5][n % 7] },
    },
  };
});
// FAKE-1 has a wiki-markup description with Jira's CRLF line endings.
Object.assign(issues[0].fields, {
  summary: 'Summarize the sprint for stakeholders',
  description: '*As a* stakeholder,\r\n*I want* a short sprint summary.\r\n\r\nAcceptance Criteria\r\n* Fits one screen\r\n** no tables',
  status: { name: 'Done', category: 'Done', color: 'success' },
  issue_type: { name: 'Story' },
  assignee: PEOPLE[0],
  [POINTS]: { value: 3 },
});

// Only id, key and browse_url are always present; the field `issuetype` comes back as `issue_type`.
function pick({ fields }: (typeof issues)[number], wanted: string) {
  const names = wanted.split(',').map((f) => f.trim().replace(/^issuetype$/, 'issue_type'));
  return Object.fromEntries(Object.entries(fields).filter(([k]) => ['id', 'key', 'browse_url', ...names].includes(k)));
}

// Supports the JQL the app sends: `sprint = N` or `key = K` or `key in (K1,K2)`, then optionally
// `AND issuetype not in subTaskIssueTypes()` and `ORDER BY Rank ASC`.
function search(jql: string) {
  const [, where = '', noSubTasks, byRank] = /^(.+?)( AND issuetype not in subTaskIssueTypes\(\))?( ORDER BY Rank ASC)?$/i.exec(jql) ?? [];
  const sprint = /^sprint = (\d+)$/i.exec(where)?.[1];
  const byKey = /^key (?:= (\S+)|in \((.+)\))$/i.exec(where);
  if (!sprint && !byKey) throw new Error(`Error in JQL Query: fake-jira does not support '${jql}'`);
  const keys = byKey && (byKey[1] ?? byKey[2]).split(',').map((k) => k.trim());
  const missing = keys?.find((k) => !issues.some((i) => i.fields.key === k));
  if (missing) throw new Error(`An issue with key '${missing}' does not exist for field 'key'.`);
  const found = issues.filter((i) => (keys ? keys.includes(i.fields.key) : i.sprint === sprint) && !(noSubTasks && i.fields.issue_type.name === 'Sub-task'));
  return byRank ? found.sort((a, b) => a.rank - b.rank) : found.reverse(); // Jira's default order is key descending
}

function update(key: string, fields: string, returnFields: string) {
  const issue = issues.find((i) => i.fields.key === key);
  const fail = (detail: string) => new Error(`Failed to update issue ${key}: Failed to update issue ${key}: ${detail}`);
  if (!issue) throw fail('Issue Does Not Exist');
  if (key === 'FAKE-13') throw fail(`Field '${POINTS}' cannot be set. It is not on the appropriate screen, or unknown.`);
  const values = JSON.parse(fields);
  // FAKE-14 is the silent no-op: the write is dropped but the tool still reports success with the old value.
  if (key !== 'FAKE-14') {
    if (POINTS in values) {
      if (values[POINTS] !== null && typeof values[POINTS] !== 'number') throw fail('Operation value must be a number');
      issue.fields[POINTS].value = values[POINTS];
    }
    if ('summary' in values) issue.fields.summary = values.summary;
    // The real tool converts a "description" key from Markdown (wiki bold becomes italic); "Description" passes as is.
    if ('description' in values) Object.assign(issue.fields, { description: values.description.replace(/\*(\S[^*]*)\*/g, '_$1_') });
    if ('Description' in values) Object.assign(issue.fields, { description: values.Description });
  }
  const { browse_url: _, ...shown } = pick(issue, returnFields); // update results carry no browse_url
  return { message: 'Issue updated successfully', issue: shown };
}

// Tests can hold every write until they release it, to act while a write is pending.
let writes = Promise.resolve();
export function holdWrites() {
  const { promise, resolve } = Promise.withResolvers<void>();
  writes = promise;
  return resolve;
}

// Stateless mode builds a server per HTTP request, and mcp-atlassian checks the PAT with Jira before any tool runs.
function atlassian({ requestInfo }: McpRequestContext) {
  const rejected = requestInfo?.headers.get('authorization') === 'Token bad-token';

  // mcp-atlassian's envelopes: success carries the pretty JSON twice, errors are tool results prefixed with the
  // Python function name, never JSON-RPC errors.
  function respond(fn: string, run: () => unknown): CallToolResult {
    try {
      if (rejected) throw new Error('Invalid user Jira token or configuration: Unable to get current user account ID:');
      const text = JSON.stringify(run(), null, 2);
      return { content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error calling tool '${fn}': ${(e as Error).message}` }], isError: true };
    }
  }

  const server = new McpServer({ name: 'Atlassian MCP', version: '3.4.4' });
  const outputSchema = z.object({ result: z.string() });

  server.registerTool('jira_get_sprints_from_board', {
    inputSchema: z.strictObject({
      board_id: z.string(),
      state: z.string().optional(),
      start_at: z.int().min(0).default(0),
      limit: z.int().min(1).max(50).default(10),
    }),
    outputSchema,
  }, ({ board_id, state, start_at, limit }) => respond('get_sprints_from_board', () =>
    // An unknown board is not an error: mcp-atlassian logs Jira's error and returns [].
    (board_id === '9001' ? SPRINTS : []).filter((s) => !state || state.split(',').includes(s.state)).slice(start_at, start_at + limit)));

  server.registerTool('jira_search', {
    inputSchema: z.strictObject({
      jql: z.string(),
      fields: z.string().default('assignee,labels,created,issuetype,reporter,description,updated,versions,priority,summary,status'),
      limit: z.int().min(1).default(10),
      start_at: z.int().min(0).default(0),
    }),
    outputSchema,
  }, ({ jql, fields, limit, start_at }) => respond('search', () => {
    const found = search(jql);
    const max_results = Math.min(limit, 50); // Data Center caps the page size
    return { total: found.length, start_at, max_results, issues: found.slice(start_at, start_at + max_results).map((i) => pick(i, fields)) };
  }));

  server.registerTool('jira_update_issue', {
    inputSchema: z.strictObject({
      issue_key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+(?:-\d+)*$/),
      fields: z.string(),
      return_fields: z.string().default('*all'),
    }),
    outputSchema,
  }, async ({ issue_key, fields, return_fields }) => {
    await writes;
    return respond('update_issue', () => update(issue_key, fields, return_fields));
  });

  return server;
}

const mcp = createMcpHandler(atlassian);

export async function fakeJiraRest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = request.headers.get('authorization');
  if (!token || token === 'Bearer bad-token') return Response.json({ errorMessages: ['Invalid token'] }, { status: 401 });
  const raw = (record: (typeof issues)[number]) => ({
    key: record.fields.key,
    fields: {
      summary: record.fields.summary,
      description: (record.fields as { description?: string }).description ?? null,
      issuetype: record.fields.issue_type,
      status: record.fields.status,
      assignee: record.fields.assignee.display_name === 'Unassigned' ? null : { displayName: record.fields.assignee.display_name },
      [POINTS]: record.fields[POINTS].value,
    },
  });
  try {
    if (url.pathname === '/rest/api/2/serverInfo') return Response.json({ version: 'test' });
    if (url.pathname === '/rest/agile/1.0/board/9001/sprint') {
      const start = Number(url.searchParams.get('startAt') ?? 0);
      const found = SPRINTS.filter((sprint) => sprint.state === url.searchParams.get('state'));
      return Response.json({ values: found.slice(start, start + 50).map((sprint) => ({ ...sprint, id: Number(sprint.id) })), total: found.length, isLast: start + 50 >= found.length });
    }
    if (url.pathname === '/rest/api/2/search' && request.method === 'POST') {
      const { jql, startAt = 0, maxResults = 50 } = await request.json() as { jql: string; startAt: number; maxResults: number };
      const found = search(jql.replace(/^project = FAKE AND /, ''));
      return Response.json({ total: found.length, issues: found.slice(startAt, startAt + Math.min(maxResults, 50)).map(raw) });
    }
    const issue = /^\/rest\/api\/2\/issue\/(FAKE-\d+)$/.exec(url.pathname);
    if (issue && request.method === 'PUT') {
      await writes;
      const { fields } = await request.json() as { fields: Record<string, unknown> };
      if ('description' in fields) {
        fields.Description = fields.description;
        delete fields.description;
      }
      update(issue[1], JSON.stringify(fields), '*all');
      return new Response(null, { status: 204 });
    }
    return Response.json({ errorMessages: ['Not found'] }, { status: 404 });
  } catch (error) {
    return Response.json({ errorMessages: [(error as Error).message.replace(/^(Failed to update issue [\w-]+: )*/, '')] }, { status: 400 });
  }
}

export async function startFakeJira(port = 0) {
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp') return res.writeHead(404).end();
    if (!req.headers.authorization) {
      return res.writeHead(401, { 'content-type': 'application/json' })
        .end('{"error": "Authentication required: no Atlassian credentials were provided."}');
    }
    const body = req.method === 'POST' ? Buffer.concat(await req.toArray()) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body });
    const response = await mcp.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.main) console.log((await startFakeJira(Number(process.env.FAKE_JIRA_PORT || 9100))).url);
