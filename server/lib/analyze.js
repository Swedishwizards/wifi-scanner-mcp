'use strict';
// Channel congestion and security analysis over a list of access points.

const NON_DFS_5GHZ = [36, 40, 44, 48, 149, 153, 157, 161, 165];
const TWO_GHZ_CANDIDATES = [1, 6, 11];

function strengthWeight(dbm) {
  if (typeof dbm !== 'number') return 0.5;
  return Math.min(1.2, Math.max(0.2, (dbm + 100) / 50));
}

function round(x) { return Math.round(x * 100) / 100; }

function channelTable(aps) {
  const map = new Map();
  for (const ap of aps) {
    if (typeof ap.channel !== 'number') continue;
    let row = map.get(ap.channel);
    if (!row) { row = { channel: ap.channel, access_points: 0, strongest_dbm: null, networks: [] }; map.set(ap.channel, row); }
    row.access_points += 1;
    if (typeof ap.signal_dbm === 'number' && (row.strongest_dbm === null || ap.signal_dbm > row.strongest_dbm)) row.strongest_dbm = ap.signal_dbm;
    const name = ap.ssid ?? '(hidden)';
    if (!row.networks.includes(name)) row.networks.push(name);
  }
  return [...map.values()].sort((a, b) => a.channel - b.channel);
}

/** 2.4 GHz channels overlap: anything within 4 channels interferes, more when closer. */
function score24(aps, candidate) {
  let s = 0;
  for (const ap of aps) {
    if (typeof ap.channel !== 'number') continue;
    const d = Math.abs(ap.channel - candidate);
    if (d > 4) continue;
    s += (1 - d / 5) * strengthWeight(ap.signal_dbm);
  }
  return s;
}

/** 5/6 GHz: count networks whose occupied block (by channel width) covers the candidate. */
function occupies(ap, candidate) {
  if (typeof ap.channel !== 'number') return false;
  const width = ap.channel_width_mhz || 20;
  const span = Math.max(1, width / 20); // number of 20 MHz sub-channels
  const blockSize = span * 4;           // channel numbers are 5 MHz apart, 20 MHz = 4 numbers
  if (span === 1) return ap.channel === candidate;
  // 5 GHz blocks are aligned starting at 36 (and 149 for UNII-3).
  const base = ap.channel >= 149 ? 149 : 36;
  const start = base + Math.floor((ap.channel - base) / blockSize) * blockSize;
  return candidate >= start && candidate < start + blockSize;
}

/** All 20 MHz channel numbers an access point occupies. */
function subChannels(ap) {
  if (typeof ap.channel !== 'number') return [];
  const out = [];
  for (let c = ap.channel - 28; c <= ap.channel + 28; c += 4) if (c > 0 && occupies(ap, c)) out.push(c);
  return out.length ? out : [ap.channel];
}

function score5(aps, candidate) {
  let s = 0;
  for (const ap of aps) if (occupies(ap, candidate)) s += strengthWeight(ap.signal_dbm);
  return s;
}

function analyze(aps, current) {
  const byBand = { '2.4 GHz': [], '5 GHz': [], '6 GHz': [] };
  for (const ap of aps) if (ap.band && byBand[ap.band]) byBand[ap.band].push(ap);

  const bands = {};
  // 2.4 GHz
  {
    const list = byBand['2.4 GHz'];
    const scores = TWO_GHZ_CANDIDATES.map((c) => ({ channel: c, interference_score: round(score24(list, c)) }));
    const best = scores.slice().sort((a, b) => a.interference_score - b.interference_score)[0];
    bands['2.4 GHz'] = {
      access_points: list.length,
      channels: channelTable(list),
      candidate_scores: scores,
      recommended_channel: list.length ? best.channel : null,
      advice: list.length
        ? `Use channel ${best.channel}. Only 1, 6 and 11 do not overlap each other on 2.4 GHz; lower score = less interference.`
        : 'No 2.4 GHz networks seen.',
    };
  }
  // 5 GHz
  {
    const list = byBand['5 GHz'];
    const scores = NON_DFS_5GHZ.map((c) => ({ channel: c, interference_score: round(score5(list, c)) }));
    const best = scores.slice().sort((a, b) => a.interference_score - b.interference_score || a.channel - b.channel)[0];
    bands['5 GHz'] = {
      access_points: list.length,
      channels: channelTable(list),
      candidate_scores: scores,
      recommended_channel: best.channel,
      advice: `Channel ${best.channel} is the least crowded non-DFS 5 GHz channel here (score ${best.interference_score}). DFS channels (52–144) may be even emptier if your router supports them.`,
    };
  }
  // 6 GHz
  {
    const list = byBand['6 GHz'];
    bands['6 GHz'] = {
      access_points: list.length,
      channels: channelTable(list),
      advice: list.length ? '6 GHz (Wi-Fi 6E/7) is rarely crowded; prefer it for devices that support it.' : 'No 6 GHz networks seen.',
    };
  }

  // Security findings (one per network name)
  const seen = new Set();
  const security_findings = [];
  for (const ap of aps) {
    const key = ap.ssid ?? ap.bssid;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (ap.security === 'open') security_findings.push({ network: ap.ssid ?? '(hidden)', issue: 'open', detail: 'No password and no encryption: anyone nearby can read unencrypted traffic.' });
    else if (ap.security === 'WEP') security_findings.push({ network: ap.ssid ?? '(hidden)', issue: 'WEP', detail: 'WEP can be cracked in minutes. It should be upgraded to WPA2 or WPA3.' });
    else if (ap.security === 'WPA') security_findings.push({ network: ap.ssid ?? '(hidden)', issue: 'WPA (TKIP)', detail: 'Original WPA is outdated. WPA2 or WPA3 is recommended.' });
  }

  let your_network = null;
  if (current && current.connected && typeof current.channel === 'number' && current.band) {
    const same = (byBand[current.band] || []).filter((ap) => ap.bssid !== current.bssid);
    const sharing = current.band === '2.4 GHz'
      ? same.filter((ap) => typeof ap.channel === 'number' && Math.abs(ap.channel - current.channel) <= 4).length
      : same.filter((ap) => {
        const mine = subChannels(current);
        return subChannels(ap).some((c) => mine.includes(c));
      }).length;
    const rec = bands[current.band] && bands[current.band].recommended_channel;
    your_network = {
      ssid: current.ssid,
      band: current.band,
      channel: current.channel,
      overlapping_access_points: sharing,
      congestion: sharing === 0 ? 'none' : sharing <= 2 ? 'low' : sharing <= 5 ? 'medium' : 'high',
      suggestion: rec && rec !== current.channel && sharing > 2
        ? `Consider moving your router to channel ${rec} on ${current.band}.`
        : 'Your channel looks fine.',
    };
  }

  return { total_access_points: aps.length, bands, your_network, security_findings };
}

module.exports = { analyze, occupies, score24 };
