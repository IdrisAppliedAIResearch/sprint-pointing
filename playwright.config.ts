import { defineConfig } from '@playwright/test';

const cloud = process.env.CLOUD_E2E === '1';

export default defineConfig({
  testDir: 'e2e',
  timeout: cloud ? 60_000 : 30_000,
  use: {
    baseURL: cloud ? 'http://127.0.0.1:3101' : 'http://127.0.0.1:3100',
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  // The app against the fake mcp-atlassian, never .env.
  webServer: cloud ? [{ command: 'node test/cloud-preview.ts', env: { PORT: '3101' }, url: 'http://127.0.0.1:3101' }] : [
    { command: 'node test/fake-jira.ts', env: { FAKE_JIRA_PORT: '9191' }, url: 'http://127.0.0.1:9191/mcp' },
    {
      command: 'npm run build && node server/main.ts',
      env: {
        PORT: '3100',
        JIRA_URL: 'https://jira.example.test',
        JIRA_MCP_URL: 'http://127.0.0.1:9191/mcp',
        JIRA_BOARD_ID: '9001',
        JIRA_POINTS_FIELD: 'customfield_10106',
      },
      url: 'http://127.0.0.1:3100',
    },
  ],
});
