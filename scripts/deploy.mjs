// Copies the plugin build (main.js, manifest.json, styles.css) into an
// Obsidian vault's .obsidian/plugins/weekfit/ folder.
//
// Defaults to the local scratch vault used for Phase 0+ manual testing.
// Overridable via WEEKFIT_VAULT so a real vault *could* be targeted later —
// but never Tyler's actual vault (quetx): this refuses to run if the
// resolved path contains "quetx", full stop.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_VAULT = 'C:/Users/tyler/weekfit-scratch';
const vaultPath = path.resolve(process.env.WEEKFIT_VAULT || DEFAULT_VAULT);

if (vaultPath.toLowerCase().includes('quetx')) {
  console.error(
    `Refusing to deploy: target path contains "quetx" (${vaultPath}). ` +
      'That is Tyler\'s real Obsidian vault and must never be a deploy target.',
  );
  process.exit(1);
}

const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'weekfit');
mkdirSync(pluginDir, { recursive: true });

const FILES = ['main.js', 'manifest.json', 'styles.css'];
const copied = [];

for (const file of FILES) {
  const src = path.join(repoRoot, file);
  if (!existsSync(src)) {
    console.error(`Missing build output: ${src} (did you run "npm run build" or "npm run dev"?)`);
    process.exit(1);
  }
  const dest = path.join(pluginDir, file);
  copyFileSync(src, dest);
  copied.push(dest);
}

console.log(`Deployed to ${pluginDir}:`);
for (const f of copied) {
  console.log(`  - ${f}`);
}
