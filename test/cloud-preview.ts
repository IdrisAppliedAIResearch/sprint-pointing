import { createServer } from 'node:http';
import worker from '../hosting/site/worker/app.ts';
import { randomToken } from '../hosting/site/worker/credentials.ts';
import { fakeJiraRest } from './fake-jira.ts';
import { testDatabase, testEnvironment } from './cloud-support.ts';

const db = testDatabase();
const env = { ...testEnvironment(db.binding), SPRINT_SESSION_KEY: randomToken() };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const request = new Request(input, options);
  return new URL(request.url).origin === env.JIRA_URL ? fakeJiraRest(request) : originalFetch(request);
};

const server = createServer(async (request, response) => {
  try {
    const body = ['GET', 'HEAD'].includes(request.method!) ? undefined : Buffer.concat(await request.toArray());
    const incoming = new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers: request.headers as Record<string, string>, body });
    const result = await worker.fetch(incoming, env);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end('Cloud preview request failed');
  }
});
server.listen(Number(process.env.PORT || 3101), '127.0.0.1', () => console.log('Standalone Sites backend test server ready'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => db.close()));
