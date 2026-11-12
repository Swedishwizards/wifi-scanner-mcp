#!/usr/bin/env node
'use strict';
// Builds dist/wifi-scanner-<version>.mcpb (one-click install file for Claude Desktop).
// On macOS, build the helper first (npm run build:mac) so it is included in the bundle.
// Usage: node scripts/pack.js [--require-helper]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const manifest = require(path.join(root, 'manifest.json'));
const stage = path.join(root, 'build', 'bundle');
const dist = path.join(root, 'dist');
const out = path.join(dist, `wifi-scanner-${pkg.version}.mcpb`);

if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: package.json ${pkg.version} vs manifest.json ${manifest.version}`);
  process.exit(1);
}

const helper = path.join(root, 'macos', 'WifiScanHelper.app');
const hasHelper = fs.existsSync(path.join(helper, 'Contents', 'MacOS', 'WifiScanHelper'));
if (!hasHelper) {
  const msg = 'macos/WifiScanHelper.app not found: macOS users will see networks without names. Run "npm run build:mac" on a Mac first.';
  if (process.argv.includes('--require-helper')) { console.error(msg); process.exit(1); }
  console.warn('WARNING: ' + msg);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

const copy = (rel) => fs.cpSync(path.join(root, rel), path.join(stage, rel), { recursive: true, verbatimSymlinks: true });
['manifest.json', 'package.json', 'icon.png', 'README.md', 'LICENSE', 'server'].forEach(copy);
if (hasHelper) copy('macos/WifiScanHelper.app');

const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
execFileSync(cli, ['--yes', '@anthropic-ai/mcpb@latest', 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(cli, ['--yes', '@anthropic-ai/mcpb@latest', 'pack', stage, out], { stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`\nCreated ${path.relative(root, out)}${hasHelper ? ' (with macOS helper)' : ''}`);
