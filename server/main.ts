import { join } from 'node:path';
import { buildApp } from './app.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value) return value;
  console.error(`Missing environment variable ${name} (see .env.example)`);
  process.exit(1);
}

const app = await buildApp({
  jira: {
    url: required('JIRA_URL'),
    mcpUrl: required('JIRA_MCP_URL'),
    boardId: required('JIRA_BOARD_ID'),
    field: process.env.JIRA_POINTS_FIELD || 'customfield_10106',
  },
  webRoot: join(import.meta.dirname, '../dist'),
  gatewayToken: process.env.SPRINT_GATEWAY_TOKEN,
});
await app.listen({ port: Number(process.env.PORT || 3000), host: process.env.HOST || '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void app.close());
