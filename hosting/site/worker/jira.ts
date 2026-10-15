import type { Issue, Sprint } from '../shared/protocol.ts';
import { fail, type Environment } from './types.ts';

type RawIssue = { key: string; fields: { summary: string; description?: string; issuetype: { name: string }; status: { name: string }; assignee: { displayName: string } | null; [field: string]: unknown } };

export function jiraOrigin(env: Environment) {
  let origin: URL;
  try {
    origin = new URL(env.JIRA_URL);
  } catch {
    return fail(503, 'Jira is not configured');
  }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') fail(503, 'Jira requires a configured HTTPS origin');
  return origin.origin;
}

export function createJira(env: Environment, token: string, renew: () => Promise<void> = async () => {}) {
  const origin = jiraOrigin(env);
  if (!/^\d+$/.test(env.JIRA_BOARD_ID) || !/^[A-Z][A-Z0-9_]+$/.test(env.JIRA_PROJECT_KEY) || !/^customfield_\d+$/.test(env.JIRA_POINTS_FIELD)) fail(503, 'Jira board, project, or points field is not configured');
  const field = env.JIRA_POINTS_FIELD;
  const fields = ['summary', 'description', 'issuetype', 'status', 'assignee', field];

  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    await renew();
    let response: Response;
    try {
      response = await fetch(`${origin}${path}`, {
        method,
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return fail(502, 'The hosted server cannot reach Jira. Check Jira network access and try again.');
    }
    if (response.status === 401) fail(400, 'Jira rejected the token: it is invalid or expired');
    if (response.status === 403) fail(403, 'Jira denied access. Check token permissions and Jira network restrictions.');
    if (response.status >= 300 && response.status < 400) fail(502, 'Jira redirected to a login page instead of accepting API authentication');
    if (response.status === 204) return undefined;
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const details = [...(Array.isArray(data?.errorMessages) ? data.errorMessages : []), ...Object.values(data?.errors ?? {})].filter((value) => typeof value === 'string').join('; ');
      fail(502, details ? details.replaceAll(token, '[redacted]').slice(0, 1000) : `Jira request failed (${response.status})`);
    }
    if (!data) fail(502, 'Jira returned an unexpected API response');
    return data;
  }

  const issue = (raw: RawIssue): Issue => ({
    key: raw.key,
    summary: raw.fields.summary.trim(),
    description: raw.fields.description ?? '',
    type: raw.fields.issuetype.name,
    status: raw.fields.status.name,
    assignee: raw.fields.assignee?.displayName ?? null,
    points: typeof raw.fields[field] === 'number' ? raw.fields[field] as number : null,
  });

  async function search(jql: string): Promise<Issue[]> {
    const found: Issue[] = [];
    for (let startAt = 0; ; ) {
      const page = await request('/rest/api/2/search', 'POST', { jql: `project = ${env.JIRA_PROJECT_KEY} AND ${jql}`, fields, maxResults: 50, startAt });
      if (!Array.isArray(page.issues) || typeof page.total !== 'number') fail(502, 'Jira returned an unexpected search response');
      found.push(...page.issues.map(issue));
      startAt += page.issues.length;
      if (!page.issues.length || startAt >= page.total) return found;
      if (startAt >= 10_000) fail(502, 'This Jira query is too large; select a smaller sprint');
    }
  }

  async function issues(keys: string[]): Promise<Issue[]> {
    if (keys.some((key) => !new RegExp(`^${env.JIRA_PROJECT_KEY}-\\d+$`).test(key))) fail(400, `Only ${env.JIRA_PROJECT_KEY} tickets can be added`);
    const found: Issue[] = [];
    for (let offset = 0; offset < keys.length; offset += 50) {
      const chunk = keys.slice(offset, offset + 50);
      let page: Issue[];
      try {
        page = await search(`key in (${chunk.join(',')})`);
      } catch (error) {
        if (!String((error as Error).message).includes('does not exist')) throw error;
        page = [];
        for (const key of chunk) {
          try {
            page.push(...await search(`key = ${key}`));
          } catch (singleError) {
            if (!String((singleError as Error).message).includes('does not exist')) throw singleError;
          }
        }
        if (!page.length) throw error;
      }
      found.push(...chunk.flatMap((key) => page.filter((ticket) => ticket.key === key)));
    }
    return found;
  }

  async function edit(key: string, changes: Record<string, unknown>) {
    await issues([key]);
    const error = await request(`/rest/api/2/issue/${encodeURIComponent(key)}`, 'PUT', { fields: changes }).then(() => null, (reason: Error) => reason);
    const [now] = await issues([key]);
    const normalize = (value: unknown) => typeof value === 'string' ? value.replaceAll('\r\n', '\n').trimEnd() : value;
    for (const [name, value] of Object.entries(changes)) {
      const actual = name === field ? now?.points : now?.[name as keyof Issue];
      if (normalize(actual) !== normalize(value)) throw error ?? new Error(`Jira kept the old ${name === field ? 'estimate' : name}`);
    }
  }

  return {
    issues,
    edit,
    async writePoints(key: string, points: number | null) {
      const [before] = await issues([key]);
      await edit(key, { [field]: points });
      return before?.points ?? null;
    },
    async sprints(): Promise<Sprint[]> {
      const found: Sprint[] = [];
      for (const state of ['active', 'future'] as const) {
        for (let startAt = 0; ; ) {
          const page = await request(`/rest/agile/1.0/board/${env.JIRA_BOARD_ID}/sprint?state=${state}&startAt=${startAt}&maxResults=50`);
          if (!Array.isArray(page.values)) fail(502, 'Jira returned an unexpected sprint response');
          found.push(...page.values.map((sprint: any) => ({ id: String(sprint.id), name: sprint.name, state })));
          startAt += page.values.length;
          if (page.isLast || !page.values.length || startAt >= page.total) break;
          if (startAt >= 10_000) fail(502, 'This Jira board has too many sprints');
        }
      }
      return found;
    },
    sprintIssues(id: string) {
      if (!/^\d+$/.test(id)) fail(400, 'Invalid sprint id');
      return search(`sprint = ${id} AND issuetype not in subTaskIssueTypes() ORDER BY Rank ASC`);
    },
  };
}
