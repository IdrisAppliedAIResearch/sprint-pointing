import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));
const project = resolve(root, '../..');
const frontend = resolve(project, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

await mkdir(resolve(root, 'shared'), { recursive: true });
if (existsSync(resolve(project, 'shared/protocol.ts'))) await copyFile(resolve(project, 'shared/protocol.ts'), resolve(root, 'shared/protocol.ts'));
if (existsSync(resolve(frontend, 'index.html'))) {
  const assets = {};
  async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(resolve(directory, entry.name), path);
      else {
        const extension = entry.name.slice(entry.name.lastIndexOf('.'));
        const binary = !['.html', '.js', '.css', '.svg'].includes(extension);
        const data = await readFile(resolve(directory, entry.name));
        assets[path] = { type: types[extension] ?? 'application/octet-stream', data: data.toString(binary ? 'base64' : 'utf8'), ...(binary ? { binary: true } : {}) };
      }
    }
  }
  await collect(frontend);
  await writeFile(resolve(root, 'worker/assets.json'), JSON.stringify(assets));
}
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist/server'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
const bundle = await rolldown({ input: resolve(root, 'worker/index.js'), platform: 'browser' });
await bundle.write({ file: resolve(root, 'dist/server/index.js'), format: 'es', minify: true });
await bundle.close();
await copyFile(resolve(root, '.openai/hosting.json'), resolve(root, 'dist/.openai/hosting.json'));
console.log(`Built standalone Sites backend and frontend at ${resolve(root, 'dist')}`);
