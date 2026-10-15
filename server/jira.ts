import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Issue, Sprint } from '../shared/protocol.ts';

type RawSprint = { id: string; name: string };
type RawIssue = {
  key: string;
  summary: string;
  description?: string;
  issue_type: { name: string };
  status: { name: string };
  assignee: { display_name: string };
} & Record<string, unknown>;

export class JiraUnreachable extends Error {
  constructor() {
    super("Can't reach the Jira MCP server. Is it running (docker compose up -d)?");
  }
}

export type Jira = ReturnType<typeof createJira>;

// One MCP client per Jira session: the PAT lives only in this closure and in each request's header.
export function createJira({ mcpUrl, token, field, boardId }: { mcpUrl: string; token: string; field: string; boardId: string }) {
  const fields = `summary,description,status,issuetype,assignee,${field}`;
  const writes = new Map<string, Promise<unknown>>();
  let client: Promise<Client> | undefined;
  let closed = false;

  async function connect() {
    const mcp = new Client({ name: 'sprint-pointing', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: `Token ${token}` } } }));
    return mcp;
  }

  async function call(name: string, args: Record<string, unknown>, timeout?: number) {
    if (closed) throw new Error('Jira connection is closed');
    const current = (client ??= connect());
    let result;
    try {
      result = await (await current).callTool({ name, arguments: args }, { timeout });
    } catch (e) {
      // A transport failure, not a tool error: close this client (mcp-atlassian holds its SSE stream open) and let
      // the next call start over with a fresh one.
      if (client === current) client = undefined;
      current.then((mcp) => mcp.close(), () => {});
      throw e instanceof TypeError ? new JiraUnreachable() : e; // fetch failed: nothing is listening
    }
    const text = (result.content[0] as { text: string }).text;
    if (result.isError) throw new Error(text.replace(/^Error calling tool '\w+': (Failed to update issue [\w-]+: )*/, ''));
    return JSON.parse(text);
  }

  const search = (jql: string, start = 0): Promise<{ total: number; issues: RawIssue[] }> =>
    call('jira_search', { jql, fields, limit: 50, start_at: start });

  const pointsOf = (issue: RawIssue) => (issue[field] as { value: number | null } | undefined)?.value ?? null;

  const toIssue = (issue: RawIssue): Issue => ({
    key: issue.key,
    summary: issue.summary.trim(),
    description: issue.description ?? '',
    type: issue.issue_type.name,
    status: issue.status.name,
    assignee: issue.assignee.display_name === 'Unassigned' ? null : issue.assignee.display_name,
    points: pointsOf(issue),
  });

  async function sprints(): Promise<Sprint[]> {
    const out: Sprint[] = [];
    for (const state of ['active', 'future'] as const) {
      for (let start = 0; ; start += 50) {
        const page: RawSprint[] = await call('jira_get_sprints_from_board', { board_id: boardId, state, limit: 50, start_at: start });
        out.push(...page.map(({ id, name }) => ({ id, name, state })));
        if (page.length < 50) break;
      }
    }
    return out;
  }

  async function sprintIssues(id: string): Promise<Issue[]> {
    const out: Issue[] = [];
    for (;;) {
      const page = await search(`sprint = ${id} AND issuetype not in subTaskIssueTypes() ORDER BY Rank ASC`, out.length);
      out.push(...page.issues.map(toIssue));
      if (!page.issues.length || out.length >= page.total) return out;
    }
  }

  async function issues(keys: string[]): Promise<Issue[]> {
    const out: Issue[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const found = await search(`key in (${chunk.join(',')})`).then(
        (page) => page.issues,
        async (e) => {
          // One missing key fails the whole search, so ask for each key alone and keep the ones Jira finds.
          const each = (await Promise.all(chunk.map((key) => search(`key = ${key}`).then((page) => page.issues, () => [])))).flat();
          if (!each.length) throw e;
          return each;
        },
      );
      out.push(...found.map(toIssue));
    }
    return out;
  }

  async function write(key: string, to: number | null) {
    const from = (await issues([key]))[0]?.points ?? null;
    try {
      const { issue } = await call(
        'jira_update_issue',
        { issue_key: key, fields: JSON.stringify({ [field]: to }), return_fields: field },
        90_000,
      );
      const got = pointsOf(issue);
      // The tool reports success even when it silently skipped the write.
      if (got !== to) throw new Error(`Jira kept ${got} instead of ${to}`);
    } catch (e) {
      // The write may have landed even though the call failed (e.g. a timeout), so check before reporting.
      const [now] = await issues([key]).catch(() => []);
      if (now?.points !== to) throw e;
    }
    return from;
  }

  // "Description" rather than "description": the tool converts the lower-case key from Markdown, which would mangle
  // Jira's wiki markup (bold, nested bullets, mentions). The other spelling reaches Jira unchanged.
  async function edit(key: string, changes: { summary?: string; description?: string }) {
    const { description, ...rest } = changes;
    const fields = JSON.stringify(description === undefined ? rest : { ...rest, Description: description });
    const error = await call('jira_update_issue', { issue_key: key, fields, return_fields: 'summary' }, 90_000).then(() => null, (e: Error) => e);
    // Check what Jira holds: the tool can report success without writing, or fail after the write landed.
    const [now] = await issues([key]);
    const flat = (text = '') => text.replaceAll('\r\n', '\n').trimEnd();
    if (Object.entries(changes).some(([k, v]) => flat(v) !== flat(now[k as keyof typeof changes]))) throw error ?? new Error('Jira kept the old text');
  }

  return {
    sprints,
    sprintIssues,
    issues,
    edit,
    // Writes to one ticket run one at a time, in order.
    writePoints(key: string, to: number | null) {
      const result = (writes.get(key) ?? Promise.resolve()).then(() => write(key, to));
      writes.set(key, result.catch(() => {}));
      return result;
    },
    async close() {
      await Promise.all(writes.values());
      closed = true;
      await (await client?.catch(() => undefined))?.close();
    },
  };
}
