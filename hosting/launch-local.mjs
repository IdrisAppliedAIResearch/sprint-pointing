import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server/app.ts';

for (const name of ['JIRA_URL', 'JIRA_MCP_URL', 'JIRA_BOARD_ID']) {
  if (!process.env[name]) throw new Error(`Missing ${name}; start with node --env-file=.env hosting/launch-local.mjs`);
}
const binary = fileURLToPath(new URL('../.sites-runtime/bin/cloudflared', import.meta.url));
if (!existsSync(binary)) throw new Error('Install the verified cloudflared binary in .sites-runtime/bin first');
if (!existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)))) throw new Error('Build the app before starting the hosting session');

console.log('Paste the gateway key on hidden stdin (not your Jira PAT), then press Enter.');
const terminal = process.stdin.isTTY;
if (terminal) process.stdin.setRawMode(true);
let input = '';
const gatewayToken = await new Promise((resolve, reject) => {
  function consume(chunk) {
    input += chunk.toString();
    if (input.includes('\u0003') || input.length > 256) {
      process.stdin.off('data', consume);
      reject(new Error('Gateway startup cancelled'));
    } else if (/[\r\n]/.test(input)) {
      process.stdin.off('data', consume);
      resolve(input.trim());
    }
  }
  process.stdin.on('data', consume);
  process.stdin.once('end', () => reject(new Error('No gateway key supplied')));
}).finally(() => {
  if (terminal) process.stdin.setRawMode(false);
  process.stdin.pause();
});
if (!/^[A-Za-z0-9_-]{43}$/.test(gatewayToken)) throw new Error('Use a fresh 32-byte base64url gateway key');
input = '';

const app = await buildApp({
  jira: {
    url: process.env.JIRA_URL,
    mcpUrl: process.env.JIRA_MCP_URL,
    boardId: process.env.JIRA_BOARD_ID,
    field: process.env.JIRA_POINTS_FIELD || 'customfield_10106',
  },
  webRoot: fileURLToPath(new URL('../dist', import.meta.url)),
  gatewayToken,
});
const address = await app.listen({ host: '127.0.0.1', port: 3210 });
const tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', address], { stdio: ['ignore', 'pipe', 'pipe'] });
const startupDeadline = setTimeout(() => {
  console.error('The encrypted tunnel did not connect within 90 seconds. Check network access and retry.');
  void stop(true);
}, 90_000);
let output = '';
let announced = false;
function consumeTunnel(chunk) {
  output = (output + chunk.toString()).slice(-16000);
  const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (url && !announced) {
    announced = true;
    console.log(JSON.stringify({ originUrl: url, localPort: 3210, protected: true }));
  }
  if (output.includes('Registered tunnel connection')) {
    clearTimeout(startupDeadline);
    console.log('Encrypted tunnel connected; keep this process and Docker running during the meeting.');
    output = '';
  }
}
tunnel.stdout.on('data', consumeTunnel);
tunnel.stderr.on('data', consumeTunnel);

let stopping = false;
async function stop(failed = false) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupDeadline);
  tunnel.kill('SIGTERM');
  await app.close();
  if (failed) process.exitCode = 1;
}
tunnel.on('error', () => void stop(true));
tunnel.on('exit', () => void stop(!stopping));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
