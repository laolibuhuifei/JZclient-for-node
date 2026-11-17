import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.tsx'],
  bundle: true,
  write: false,
  outdir: 'dist',
  minify: true,
  target: ['es2020'],
  format: 'iife',
  external: ['/assets/*'],
  legalComments: 'inline',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
const javascript = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
const template = await readFile(path.join(root, 'index.html'), 'utf8');
const html = template
  .replace(/^[\t ]*<script type="module" src="\/src\/main\.tsx"><\/script>\r?\n/m, '')
  .replace('<!-- APP_STYLE -->', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
  .replace('<!-- APP_SCRIPT -->', () => `<script>${javascript.replace(/<\/script/gi, '<\\/script')}</script>`);
await writeFile(path.join(root, '../src/webui.html'), html, 'utf8');
console.log(`React WebUI built: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB, all scripts and styles bundled locally.`);
