'use strict';
// Windows backend: uses the built-in `netsh wlan` command (no admin rights, no installs).
//
// netsh output is translated into the Windows display language, so the parser never
// relies on the English key names. It uses the fixed order of the lines and the shape
// of the values instead (a "%" value is the signal, a MAC address is a BSSID, etc.).

const path = require('node:path');
const { run, ScanError } = require('../lib/exec');
const { makeNetwork, toInt, normalizeBand } = require('../lib/normalize');

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const PCT_RE = /^(\d{1,3})\s*%$/;

function splitKV(line) {
  const i = line.indexOf(' : ');
  if (i === -1) {
    const j = line.indexOf(':');
    if (j === -1) return null;
    return { key: line.slice(0, j).trim(), value: line.slice(j + 1).trim() };
  }
  return { key: line.slice(0, i).trim(), value: line.slice(i + 3).trim() };
}

function looksLikeAuth(v) {
  return /wpa|wep|open|öppen|offen|ouvert|abierta|aperta|personal|enterprise|sae|owe|802\.1x/i.test(v);
}

/**
 * Parse `netsh wlan show networks mode=bssid` output into one record per access point.
 */
function parseNetworks(text, connected = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const networks = [];
  let ssid = null;
  let header = [];      // key/value lines between "SSID n :" and the first "BSSID n :"
  let inSsid = false;
  let ap = null;        // current access point being filled

  const flushAp = () => {
    if (!ap) return;
    const isConnected = connected.bssid ? ap.bssid === connected.bssid
      : (connected.ssid != null && connected.ssid === ssid);
    networks.push(makeNetwork({
      ssid,
      bssid: ap.bssid,
      signal_percent: ap.signal,
      channel: ap.channel,
      band: ap.band,
      phy_mode: ap.radio,
      security_raw: ap.auth,
      connected: isConnected,
    }));
    ap = null;
  };

  for (const raw of lines) {
    const ssidMatch = raw.match(/^SSID\s+\d+\s*:\s?(.*)$/);
    if (ssidMatch) {
      flushAp();
      ssid = ssidMatch[1].trim();
      header = [];
      inSsid = true;
      continue;
    }
    if (!inSsid) continue;
    const kv = splitKV(raw);
    if (!kv) continue;

    if (/^BSSID\s+\d+$/i.test(kv.key) && MAC_RE.test(kv.value)) {
      flushAp();
      // Header order is fixed: network type, authentication, encryption.
      const auth = header[1] || header.find((h) => looksLikeAuth(h)) || null;
      ap = { bssid: kv.value.replace(/-/g, ':').toLowerCase(), auth, signal: null, channel: null, band: null, radio: null };
      continue;
    }
    if (!ap) { header.push(kv.value); continue; }

    const v = kv.value;
    const pct = v.match(PCT_RE);
    if (pct && ap.signal === null) { ap.signal = parseInt(pct[1], 10); continue; }
    if (/^802\.11/i.test(v) && !ap.radio) { ap.radio = v; continue; }
    if (/^\d+([.,]\d+)?\s*GHz$/i.test(v) && !ap.band) { ap.band = normalizeBand(v); continue; }
    // Channel is the first plain integer after the signal line (later integers are
    // "connected stations" and similar).
    const n = toInt(v);
    if (n !== null && ap.signal !== null && ap.channel === null && n >= 1 && n <= 233) { ap.channel = n; continue; }
  }
  flushAp();
  return networks;
}

/**
 * Parse `netsh wlan show interfaces`. Returns the first connected interface or
 * { connected: false } when Wi-Fi is not connected.
 */
function parseInterfaces(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const ifaces = [];
  let cur = null;
  let afterSsid = false;
  for (const raw of lines) {
    const kv = splitKV(raw);
    if (!kv || !kv.key) continue;
    const { key, value } = kv;
    // Every interface block starts with its name; the first key of a block is the name.
    // The GUID line is a reliable anchor for a new block.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      cur = { guid: value, ssid: null, bssid: null, signal: null, channel: null, band: null, radio: null, auth: null, rx: null, tx: null };
      ifaces.push(cur);
      afterSsid = false;
      continue;
    }
    if (!cur) continue;
    if (key === 'SSID') { cur.ssid = value; afterSsid = true; continue; }
    if (/BSSID$/i.test(key) && MAC_RE.test(value)) { cur.bssid = value.replace(/-/g, ':').toLowerCase(); continue; }
    const pct = value.match(PCT_RE);
    if (pct && cur.signal === null) { cur.signal = parseInt(pct[1], 10); continue; }
    if (/^802\.11/i.test(value) && !cur.radio) { cur.radio = value; continue; }
    if (/^\d+([.,]\d+)?\s*GHz$/i.test(value) && !cur.band) { cur.band = normalizeBand(value); continue; }
    if (/mbps|mbit/i.test(key)) {
      const rate = parseFloat(value.replace(',', '.'));
      if (!Number.isNaN(rate)) { if (cur.rx === null) cur.rx = rate; else if (cur.tx === null) cur.tx = rate; }
      continue;
    }
    if (afterSsid && !cur.auth && looksLikeAuth(value) && !/^802\.11/i.test(value)) { cur.auth = value; continue; }
    const n = toInt(value);
    if (afterSsid && n !== null && cur.channel === null && n >= 1 && n <= 233) { cur.channel = n; continue; }
  }
  const active = ifaces.find((i) => i.ssid) || null;
  if (!active) return { connected: false, interfaces: ifaces.length };
  const net = makeNetwork({
    ssid: active.ssid, bssid: active.bssid, signal_percent: active.signal, channel: active.channel,
    band: active.band, phy_mode: active.radio, security_raw: active.auth, connected: true,
  });
  return { connected: true, ...net, receive_rate_mbps: active.rx, transmit_rate_mbps: active.tx, interfaces: ifaces.length };
}

function systemExe(name) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', name);
}

/** Run netsh with UTF-8 output so non-English network names survive. */
async function netsh(args) {
  // cmd.exe has its own quoting rules, so the command line is passed verbatim.
  // /s + outer quotes: cmd strips exactly the first and last quote and runs the rest.
  const cmd = `"chcp 65001 >nul & "${systemExe('netsh.exe')}" ${args}"`;
  return run(systemExe('cmd.exe'), ['/d', '/s', '/c', cmd], { timeoutMs: 20000, verbatim: true });
}

function checkErrors(r, text) {
  if (/ms-settings:privacy-location|need location permission/i.test(text)) {
    throw new ScanError('Windows blocked the Wi-Fi scan because location access is turned off.', {
      code: 'permission_denied',
      hint: 'Open Settings → Privacy & security → Location, turn on "Location services" and "Let desktop apps access your location", then try again.',
    });
  }
  if (/wlansvc|wireless autoconfig|wlan autoconfig/i.test(text) && r.code !== 0) {
    throw new ScanError('The Windows WLAN AutoConfig service is not running.', {
      code: 'service_stopped',
      hint: 'Start the "WLAN AutoConfig" service (services.msc) and try again.',
    });
  }
  if (r.timedOut) throw new ScanError('netsh did not answer in time.', { code: 'timeout' });
}

async function scan() {
  const ifaceRun = await netsh('wlan show interfaces');
  const ifaceText = ifaceRun.stdout + ifaceRun.stderr;
  checkErrors(ifaceRun, ifaceText);
  const current = parseInterfaces(ifaceText);

  const r = await netsh('wlan show networks mode=bssid');
  const text = r.stdout + r.stderr;
  checkErrors(r, text);
  const networks = parseNetworks(text, current.connected ? { ssid: current.ssid, bssid: current.bssid } : {});
  if (networks.length === 0 && !/^SSID\s+\d+/m.test(text)) {
    if (current.interfaces === 0) {
      throw new ScanError('No Wi-Fi adapter was found on this PC.', { code: 'no_adapter', hint: 'Make sure Wi-Fi is turned on and the adapter is enabled.' });
    }
  }
  return {
    networks,
    notes: ['Windows refreshes its list of nearby networks automatically about once a minute.'],
  };
}

async function current() {
  const r = await netsh('wlan show interfaces');
  const text = r.stdout + r.stderr;
  checkErrors(r, text);
  const c = parseInterfaces(text);
  if (c.interfaces === 0 && !c.connected) {
    throw new ScanError('No Wi-Fi adapter was found on this PC.', { code: 'no_adapter' });
  }
  return c;
}

module.exports = { scan, current, parseNetworks, parseInterfaces, checkErrors };
