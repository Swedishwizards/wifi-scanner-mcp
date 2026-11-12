'use strict';
// Shared helpers that turn platform-specific scan data into one common shape.

/** Convert Windows/Linux signal percentage (0-100) to an approximate dBm value. */
function percentToDbm(pct) {
  if (typeof pct !== 'number' || Number.isNaN(pct)) return null;
  const p = Math.max(0, Math.min(100, pct));
  return Math.round(p / 2 - 100);
}

/** Convert dBm to an approximate 0-100 percentage (inverse of percentToDbm). */
function dbmToPercent(dbm) {
  if (typeof dbm !== 'number' || Number.isNaN(dbm)) return null;
  return Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))));
}

/** Human-friendly signal label. */
function signalQuality(dbm) {
  if (typeof dbm !== 'number') return 'unknown';
  if (dbm >= -55) return 'excellent';
  if (dbm >= -67) return 'good';
  if (dbm >= -75) return 'fair';
  return 'weak';
}

/** Signal bars 1-4 like the OS menu bar icon. */
function signalBars(dbm) {
  if (typeof dbm !== 'number') return 0;
  if (dbm >= -55) return 4;
  if (dbm >= -67) return 3;
  if (dbm >= -75) return 2;
  return 1;
}

/** Guess the band from a channel number when nothing better is known. */
function bandFromChannel(ch) {
  if (typeof ch !== 'number') return null;
  if (ch >= 1 && ch <= 14) return '2.4 GHz';
  if (ch >= 32 && ch <= 177) return '5 GHz';
  return null;
}

/** Band from a frequency in MHz. */
function bandFromFrequency(mhz) {
  if (typeof mhz !== 'number') return null;
  if (mhz >= 2400 && mhz < 2500) return '2.4 GHz';
  if (mhz >= 4900 && mhz < 5925) return '5 GHz';
  if (mhz >= 5925 && mhz < 7125) return '6 GHz';
  return null;
}

/** Normalize a free-text band label ("5 GHz", "2,4 GHz", "6GHz") to our canonical form. */
function normalizeBand(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(',', '.').replace(/\s+/g, '').toLowerCase();
  if (t.startsWith('2.4')) return '2.4 GHz';
  if (t.startsWith('5')) return '5 GHz';
  if (t.startsWith('6')) return '6 GHz';
  return null;
}

/**
 * Map a raw security description to a short, comparable label.
 * Works on Windows (localized), macOS (CoreWLAN / system_profiler) and Linux (nmcli) strings.
 */
function normalizeSecurity(raw) {
  if (raw === null || raw === undefined) return 'unknown';
  const s = String(raw).toLowerCase();
  if (!s.trim() || s.trim() === '--') return 'open';
  if (/enterprise|802\.1x|eap|företag|unternehmen|entreprise|empresa/.test(s)) return 'enterprise';
  const wpa3 = /wpa3|sae|owe/.test(s);
  const wpa2 = /wpa2|rsn/.test(s) || (wpa3 && /transition|mixed/.test(s));
  if (wpa3 && wpa2) return 'WPA2/WPA3';
  if (wpa3) return 'WPA3';
  if (wpa2) return 'WPA2';
  if (/wpa/.test(s)) return 'WPA';
  if (/wep/.test(s)) return 'WEP';
  if (/open|none|öppen|offen|ouvert|abierta|aperta|åpen|åben|avoin|^ingen$/.test(s)) return 'open';
  return 'unknown';
}

/** Build one network record with every field present (null when unknown). */
function makeNetwork(fields) {
  const dbm = typeof fields.signal_dbm === 'number' ? fields.signal_dbm
    : percentToDbm(fields.signal_percent);
  const pct = typeof fields.signal_percent === 'number' ? fields.signal_percent : dbmToPercent(dbm);
  const channel = typeof fields.channel === 'number' ? fields.channel : null;
  const band = fields.band || bandFromFrequency(fields.frequency_mhz) || bandFromChannel(channel);
  const ssid = typeof fields.ssid === 'string' && fields.ssid.length > 0 ? fields.ssid : null;
  return {
    ssid,
    hidden: ssid === null,
    bssid: fields.bssid ? String(fields.bssid).toLowerCase() : null,
    signal_dbm: dbm,
    signal_percent: pct,
    signal_quality: signalQuality(dbm),
    signal_bars: signalBars(dbm),
    noise_dbm: typeof fields.noise_dbm === 'number' ? fields.noise_dbm : null,
    channel,
    channel_width_mhz: typeof fields.channel_width_mhz === 'number' ? fields.channel_width_mhz : null,
    band,
    frequency_mhz: typeof fields.frequency_mhz === 'number' ? fields.frequency_mhz : null,
    security: normalizeSecurity(fields.security_raw),
    security_raw: fields.security_raw != null ? String(fields.security_raw) : null,
    phy_mode: fields.phy_mode || null,
    connected: Boolean(fields.connected),
  };
}

/** Collapse several access points (BSSIDs) of the same network name into one entry. */
function groupBySsid(networks) {
  const groups = new Map();
  const out = [];
  for (const n of networks) {
    if (n.ssid === null) { out.push({ ...n, access_points: 1 }); continue; }
    const g = groups.get(n.ssid);
    if (!g) {
      const entry = { ...n, access_points: 1, bands: n.band ? [n.band] : [] };
      groups.set(n.ssid, entry);
      out.push(entry);
      continue;
    }
    g.access_points += 1;
    if (n.band && !g.bands.includes(n.band)) g.bands.push(n.band);
    g.connected = g.connected || n.connected;
    const better = (n.signal_dbm ?? -999) > (g.signal_dbm ?? -999);
    if (better) {
      const keep = { access_points: g.access_points, bands: g.bands, connected: g.connected };
      Object.assign(g, n, keep);
    }
  }
  for (const g of groups.values()) g.bands.sort();
  return out;
}

function sortNetworks(networks, by) {
  const arr = networks.slice();
  if (by === 'name') {
    arr.sort((a, b) => (a.ssid ?? '￿').localeCompare(b.ssid ?? '￿', undefined, { sensitivity: 'base' }));
  } else if (by === 'channel') {
    arr.sort((a, b) => (a.channel ?? 999) - (b.channel ?? 999) || (b.signal_dbm ?? -999) - (a.signal_dbm ?? -999));
  } else {
    arr.sort((a, b) => (b.connected - a.connected) || (b.signal_dbm ?? -999) - (a.signal_dbm ?? -999));
  }
  return arr;
}

/** Parse a single integer, returning null for anything else. */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^-?\d+$/);
  return m ? parseInt(m[0], 10) : null;
}

module.exports = {
  percentToDbm, dbmToPercent, signalQuality, signalBars,
  bandFromChannel, bandFromFrequency, normalizeBand, normalizeSecurity,
  makeNetwork, groupBySsid, sortNetworks, toInt,
};
