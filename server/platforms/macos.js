'use strict';
// macOS backend.
//
// Since macOS 14.4 Apple removed the `airport` command and hides Wi-Fi names (SSIDs)
// from any process that has not been granted Location Services. A command-line
// Node process cannot ask for that permission, so this backend launches a tiny
// bundled helper app (WifiScanHelper.app, Swift + CoreWLAN) that can. The helper
// asks for "Location" once, scans, and writes JSON to a temp file.
//
// If the helper is missing or not allowed, the backend falls back to
// `system_profiler SPAirPortDataType -json`, which still reports signal, channel
// and security of nearby networks, but with the names hidden.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, ScanError } = require('../lib/exec');
const { makeNetwork, toInt } = require('../lib/normalize');

const HELPER_NAME = 'WifiScanHelper.app';
const HELPER_TIMEOUT_MS = 90000; // includes time for the user to answer the permission dialog

function helperCandidates() {
  const list = [];
  if (process.env.WIFI_SCANNER_HELPER) list.push(process.env.WIFI_SCANNER_HELPER);
  list.push(path.resolve(__dirname, '..', '..', 'macos', HELPER_NAME));
  list.push(path.resolve(__dirname, '..', '..', 'macos', 'build', HELPER_NAME));
  return list;
}

function findHelper() {
  for (const p of helperCandidates()) {
    const exe = path.join(p, 'Contents', 'MacOS', 'WifiScanHelper');
    if (fs.existsSync(exe)) {
      // Zip tools do not always keep the executable bit; restore it if needed.
      try {
        const mode = fs.statSync(exe).mode;
        if ((mode & 0o111) === 0) fs.chmodSync(exe, mode | 0o755);
      } catch { /* read-only install: ignore, open will report the problem */ }
      return p;
    }
  }
  return null;
}

/** Turn one helper record into our common network shape. */
function fromHelper(n, connected) {
  return makeNetwork({
    ssid: n.ssid,
    bssid: n.bssid,
    signal_dbm: typeof n.rssi === 'number' ? n.rssi : null,
    noise_dbm: typeof n.noise === 'number' ? n.noise : null,
    channel: toInt(n.channel),
    channel_width_mhz: toInt(n.width),
    band: n.band || null,
    security_raw: n.security,
    phy_mode: n.phyMode || null,
    connected,
  });
}

async function runHelper(helper) {
  const out = path.join(os.tmpdir(), `wifi-scanner-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    // -W wait, -g keep in background, -n new instance; arguments go to the helper.
    const r = await run('/usr/bin/open', ['-W', '-g', '-n', helper, '--args', out], { timeoutMs: HELPER_TIMEOUT_MS });
    let data = null;
    try { data = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* handled below */ }
    if (!data) {
      const msg = (r.stderr || r.stdout || '').trim();
      if (r.timedOut) throw new ScanError('The Wi-Fi helper did not finish in time.', { code: 'timeout', hint: 'If a Location permission dialog is open, answer it and try again.' });
      if (/damaged|cannot be opened|unidentified developer|not opened/i.test(msg)) {
        throw new ScanError('macOS blocked the bundled Wi-Fi helper app.', {
          code: 'helper_blocked',
          hint: `Open System Settings → Privacy & Security and click "Open Anyway" for WifiScanHelper, or run: xattr -dr com.apple.quarantine "${helper}"`,
        });
      }
      throw new ScanError('The Wi-Fi helper returned no result.' + (msg ? ` (${msg})` : ''), { code: 'helper_failed' });
    }
    return data;
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

// ---------- system_profiler fallback ----------

function parseChannelText(v) {
  if (typeof v === 'number') return { channel: v, band: null, width: null };
  if (typeof v !== 'string') return { channel: null, band: null, width: null };
  const m = v.match(/(\d+)(?:\s*\(\s*(\d(?:\.\d)?)\s*GHz(?:\s*,\s*(\d+)\s*MHz)?\s*\))?/i);
  if (!m) return { channel: null, band: null, width: null };
  const g = m[2];
  const band = g ? (g.startsWith('2') ? '2.4 GHz' : `${g} GHz`) : null;
  return { channel: parseInt(m[1], 10), band, width: m[3] ? parseInt(m[3], 10) : null };
}

function parseSignalNoise(v) {
  if (typeof v !== 'string') return { rssi: null, noise: null };
  const m = v.match(/(-?\d+)\s*dBm(?:\s*\/\s*(-?\d+)\s*dBm)?/i);
  return m ? { rssi: parseInt(m[1], 10), noise: m[2] ? parseInt(m[2], 10) : null } : { rssi: null, noise: null };
}

function cleanName(name) {
  if (typeof name !== 'string' || !name) return null;
  if (/redacted/i.test(name)) return null;
  return name;
}

function securityFromProfiler(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/^spairport_security_mode_/, '').replace(/_/g, ' ');
}

function profilerRecord(n, connected) {
  const ch = parseChannelText(n.spairport_network_channel);
  const sn = parseSignalNoise(n.spairport_signal_noise);
  return makeNetwork({
    ssid: cleanName(n._name),
    signal_dbm: sn.rssi,
    noise_dbm: sn.noise,
    channel: ch.channel,
    channel_width_mhz: ch.width,
    band: ch.band,
    security_raw: securityFromProfiler(n.spairport_security_mode),
    phy_mode: n.spairport_network_phymode || null,
    connected,
  });
}

/** Parse `system_profiler SPAirPortDataType -json` output. */
function parseSystemProfiler(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const result = { interface: null, power: null, current: null, networks: [] };
  for (const block of data.SPAirPortDataType || []) {
    for (const itf of block.spairport_airport_interfaces || []) {
      if (!itf || typeof itf !== 'object') continue;
      const hasWifiInfo = 'spairport_status_information' in itf || 'spairport_current_network_information' in itf
        || 'spairport_airport_other_local_wireless_networks' in itf;
      if (!hasWifiInfo) continue;
      result.interface = itf._name || null;
      const status = String(itf.spairport_status_information || '');
      result.power = !/off/i.test(status);
      if (itf.spairport_current_network_information) {
        result.current = profilerRecord(itf.spairport_current_network_information, true);
        result.networks.push(result.current);
      }
      for (const n of itf.spairport_airport_other_local_wireless_networks || []) {
        result.networks.push(profilerRecord(n, false));
      }
      return result;
    }
  }
  return result;
}

async function profilerScan() {
  const r = await run('/usr/sbin/system_profiler', ['SPAirPortDataType', '-json'], { timeoutMs: 45000 });
  if (!r.stdout.trim()) throw new ScanError('system_profiler returned nothing.', { code: 'scan_failed' });
  return parseSystemProfiler(r.stdout);
}

// ---------- public API ----------

const HELPER_MISSING_NOTE = 'Network names are hidden by macOS unless the bundled WifiScanHelper app is installed and allowed to use Location Services. Signal, channel and security are still accurate.';

async function helperOrFallback() {
  const helper = findHelper();
  if (helper) {
    const data = await runHelper(helper);
    if (!data.error) {
      const cur = data.current || null;
      const curKey = cur ? (cur.bssid || cur.ssid) : null;
      const networks = (data.networks || []).map((n) => fromHelper(n, Boolean(curKey) && (n.bssid || n.ssid) === curKey));
      return {
        source: 'corewlan-helper',
        interface: data.interface || null,
        power: data.power !== false,
        current: cur ? { ...fromHelper(cur, true), transmit_rate_mbps: typeof cur.txRate === 'number' ? cur.txRate : null } : null,
        networks,
        notes: [],
      };
    }
    if (data.code === 'wifi_off') {
      throw new ScanError('Wi-Fi is turned off.', { code: 'wifi_off', hint: 'Turn on Wi-Fi in the menu bar and try again.' });
    }
    if (data.code !== 'permission_denied' && data.code !== 'permission_timeout') {
      throw new ScanError(data.error, { code: data.code || 'helper_failed' });
    }
    // Permission missing: fall back so the user still gets useful data.
    const fb = await profilerScan();
    return {
      source: 'system_profiler',
      ...fb,
      notes: [
        'WifiScanHelper is not allowed to use Location Services, so macOS hides network names.',
        'Fix: System Settings → Privacy & Security → Location Services → turn on WifiScanHelper, then scan again.',
      ],
      permission: 'denied',
    };
  }
  const fb = await profilerScan();
  return { source: 'system_profiler', ...fb, notes: [HELPER_MISSING_NOTE] };
}

async function scan() {
  const r = await helperOrFallback();
  if (r.power === false) {
    throw new ScanError('Wi-Fi is turned off.', { code: 'wifi_off', hint: 'Turn on Wi-Fi in the menu bar and try again.' });
  }
  return r;
}

async function current() {
  const r = await helperOrFallback();
  if (r.power === false) return { connected: false, power: false, notes: r.notes };
  if (!r.current) return { connected: false, power: true, notes: r.notes };
  return { connected: true, ...r.current, interface: r.interface, notes: r.notes };
}

module.exports = { scan, current, parseSystemProfiler, parseChannelText, findHelper };
