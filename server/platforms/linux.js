'use strict';
// Linux backend (bonus): uses NetworkManager's `nmcli`, present on most desktop distros.

const { run, ScanError } = require('../lib/exec');
const { makeNetwork, toInt } = require('../lib/normalize');

const FIELDS = 'IN-USE,BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY';

/** Split one terse nmcli line on unescaped colons and unescape "\:" and "\\". */
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; i++; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseNmcli(text) {
  const networks = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const f = splitTerse(line);
    if (f.length < 7) continue;
    const [inUse, bssid, ssid, chan, freq, signal, security] = f;
    networks.push(makeNetwork({
      ssid,
      bssid,
      channel: toInt(chan),
      frequency_mhz: toInt(String(freq).replace(/\s*MHz$/i, '')),
      signal_percent: toInt(signal),
      security_raw: security,
      connected: inUse.trim() === '*',
    }));
  }
  return networks;
}

async function nmcli(rescan) {
  const r = await run('nmcli', ['-t', '-e', 'yes', '-f', FIELDS, 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], { timeoutMs: 30000 });
  if (r.error && r.error.code === 'ENOENT') {
    throw new ScanError('nmcli (NetworkManager) is not installed.', { code: 'unsupported', hint: 'Install NetworkManager, or use macOS/Windows.' });
  }
  if (r.code !== 0 && !r.stdout.trim()) {
    throw new ScanError(`nmcli failed: ${(r.stderr || '').trim() || 'unknown error'}`, { code: 'scan_failed' });
  }
  return parseNmcli(r.stdout);
}

async function scan() {
  let networks;
  try { networks = await nmcli(true); } catch (e) {
    if (e.code === 'unsupported') throw e;
    networks = await nmcli(false); // rescan can be refused without privileges
  }
  return { networks, notes: [] };
}

async function current() {
  const networks = await nmcli(false);
  const c = networks.find((n) => n.connected);
  return c ? { connected: true, ...c } : { connected: false };
}

module.exports = { scan, current, parseNmcli, splitTerse };
