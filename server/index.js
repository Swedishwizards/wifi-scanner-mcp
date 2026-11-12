#!/usr/bin/env node
'use strict';
/**
 * WiFi Scanner MCP server.
 *
 * A dependency-free Model Context Protocol server (stdio transport) that lets
 * Claude and other MCP clients see nearby Wi-Fi networks on macOS, Windows and Linux.
 * Everything runs locally and read-only: no network requests, no telemetry.
 */

const pkg = require('../package.json');
const { ScanError } = require('./lib/exec');
const { groupBySsid, sortNetworks } = require('./lib/normalize');
const { analyze } = require('./lib/analyze');

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CACHE_MS = 15000;

function backend() {
  switch (process.platform) {
    case 'darwin': return require('./platforms/macos');
    case 'win32': return require('./platforms/windows');
    case 'linux': return require('./platforms/linux');
    default:
      throw new ScanError(`Unsupported operating system: ${process.platform}`, { code: 'unsupported' });
  }
}

// ---------- scanning with a short cache ----------

let cache = null; // { at, data }

async function rawScan(fresh) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = await backend().scan();
  cache = { at: Date.now(), data };
  return data;
}

// ---------- tools ----------

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const BAND_ENUM = ['all', '2.4 GHz', '5 GHz', '6 GHz'];

const TOOLS = [
  {
    name: 'scan_wifi_networks',
    title: 'Scan nearby Wi-Fi networks',
    description:
      'Scan for Wi-Fi networks near this computer and list them with name (SSID), signal strength '
      + '(dBm, %, quality and 1-4 bars), channel, band (2.4/5/6 GHz), security type (open/WEP/WPA/WPA2/WPA3/enterprise) '
      + 'and whether this computer is connected to it. Use it when the user asks which Wi-Fi networks are around, '
      + 'which one is strongest, or to find a specific network. Read-only; does not connect to anything.',
    inputSchema: {
      type: 'object',
      properties: {
        group_by_network: { type: 'boolean', description: 'Merge access points that share a network name into one entry (default true). Set false to list every access point / BSSID.' },
        include_hidden: { type: 'boolean', description: 'Include networks that hide their name (default false).' },
        band: { type: 'string', enum: BAND_ENUM, description: 'Only return networks on this band (default "all").' },
        min_signal_dbm: { type: 'number', description: 'Only return networks at least this strong, e.g. -70.' },
        sort_by: { type: 'string', enum: ['signal', 'name', 'channel'], description: 'Sort order (default "signal", connected network first).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum number of networks to return (default 100).' },
        fresh: { type: 'boolean', description: 'Force a new scan instead of reusing one from the last 15 seconds.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Scan nearby Wi-Fi networks', ...READ_ONLY },
    handler: scanTool,
  },
  {
    name: 'get_current_wifi',
    title: 'Current Wi-Fi connection',
    description:
      'Show the Wi-Fi network this computer is connected to right now: name, BSSID, signal, channel, band, '
      + 'security and link speed when available. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Current Wi-Fi connection', ...READ_ONLY },
    handler: currentTool,
  },
  {
    name: 'analyze_wifi_channels',
    title: 'Analyze Wi-Fi channel congestion',
    description:
      'Analyze nearby access points per band and channel, score interference, recommend the least crowded '
      + 'channel for a router on 2.4 GHz (1/6/11) and 5 GHz, rate congestion on the channel this computer uses, '
      + 'and flag insecure nearby networks (open, WEP, old WPA). Use it for "why is my Wi-Fi slow", '
      + '"which channel should my router use" or a Wi-Fi site survey. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'Force a new scan instead of reusing one from the last 15 seconds.' } },
      additionalProperties: false,
    },
    annotations: { title: 'Analyze Wi-Fi channel congestion', ...READ_ONLY },
    handler: analyzeTool,
  },
];

function checkArgs(args, schema) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ScanError('Arguments must be an object.', { code: 'invalid_arguments' });
  for (const [k, v] of Object.entries(args)) {
    const spec = schema.properties[k];
    if (!spec) throw new ScanError(`Unknown argument: ${k}`, { code: 'invalid_arguments' });
    if (v === null || v === undefined) continue;
    const ok = spec.type === 'integer' ? Number.isInteger(v) : typeof v === spec.type;
    if (!ok) throw new ScanError(`Argument "${k}" must be of type ${spec.type}.`, { code: 'invalid_arguments' });
    if (spec.enum && !spec.enum.includes(v)) throw new ScanError(`Argument "${k}" must be one of: ${spec.enum.join(', ')}.`, { code: 'invalid_arguments' });
    if (typeof spec.minimum === 'number' && v < spec.minimum) throw new ScanError(`Argument "${k}" must be ≥ ${spec.minimum}.`, { code: 'invalid_arguments' });
    if (typeof spec.maximum === 'number' && v > spec.maximum) throw new ScanError(`Argument "${k}" must be ≤ ${spec.maximum}.`, { code: 'invalid_arguments' });
  }
  return args;
}

async function scanTool(args) {
  const data = await rawScan(args.fresh === true);
  let list = data.networks.slice();
  const all = list.length;
  if (args.include_hidden !== true) list = list.filter((n) => n.ssid !== null);
  if (args.band && args.band !== 'all') list = list.filter((n) => n.band === args.band);
  if (typeof args.min_signal_dbm === 'number') list = list.filter((n) => typeof n.signal_dbm === 'number' && n.signal_dbm >= args.min_signal_dbm);
  if (args.group_by_network !== false) list = groupBySsid(list);
  list = sortNetworks(list, args.sort_by || 'signal');
  const limit = args.limit || 100;
  const truncated = list.length > limit;
  list = list.slice(0, limit);
  const hiddenCount = data.networks.filter((n) => n.ssid === null).length;
  const notes = [...(data.notes || [])];
  if (hiddenCount && args.include_hidden !== true) notes.push(`${hiddenCount} access point(s) without a visible name were left out (include_hidden: true shows them).`);
  if (truncated) notes.push(`Only the first ${limit} results are shown.`);
  return {
    platform: process.platform,
    scanned_at: new Date(cache ? cache.at : Date.now()).toISOString(),
    source: data.source || null,
    access_points_seen: all,
    count: list.length,
    networks: list,
    notes,
  };
}

async function currentTool() {
  const c = await backend().current();
  return { platform: process.platform, ...c };
}

async function analyzeTool(args) {
  const data = await rawScan(args.fresh === true);
  const current = data.networks.find((n) => n.connected) || (data.current && { connected: true, ...data.current }) || null;
  return {
    platform: process.platform,
    scanned_at: new Date(cache ? cache.at : Date.now()).toISOString(),
    ...analyze(data.networks, current ? { connected: true, ...current } : null),
    notes: data.notes || [],
  };
}

function summarize(name, data) {
  if (name === 'scan_wifi_networks') {
    const lines = data.networks.map((n) => {
      const nm = n.ssid ?? '(hidden)';
      const parts = [`${n.signal_dbm ?? '?'} dBm`, n.band, n.channel != null ? `ch ${n.channel}` : null, n.security].filter(Boolean);
      return `${n.connected ? '* ' : '  '}${nm} — ${parts.join(', ')}`;
    });
    return [`Found ${data.count} network(s):`, ...lines, ...data.notes.map((x) => `Note: ${x}`)].join('\n');
  }
  if (name === 'get_current_wifi') {
    if (!data.connected) return 'Not connected to Wi-Fi.';
    return `Connected to ${data.ssid ?? '(name hidden by OS)'} — ${data.signal_dbm ?? '?'} dBm (${data.signal_quality}), ${data.band ?? '?'} channel ${data.channel ?? '?'}, ${data.security}.`;
  }
  if (name === 'analyze_wifi_channels') {
    const b = data.bands;
    const out = [`Analyzed ${data.total_access_points} access point(s).`,
      `2.4 GHz: ${b['2.4 GHz'].access_points} APs, best channel ${b['2.4 GHz'].recommended_channel ?? '-'}.`,
      `5 GHz: ${b['5 GHz'].access_points} APs, best non-DFS channel ${b['5 GHz'].recommended_channel}.`,
      `6 GHz: ${b['6 GHz'].access_points} APs.`];
    if (data.your_network) out.push(`Your network ${data.your_network.ssid ?? ''} on channel ${data.your_network.channel}: congestion ${data.your_network.congestion}. ${data.your_network.suggestion}`);
    if (data.security_findings.length) out.push(`Insecure nearby networks: ${data.security_findings.map((f) => `${f.network} (${f.issue})`).join(', ')}.`);
    return out.join('\n');
  }
  return '';
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(req) {
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') return;
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  if (!isRequest) return; // notifications (initialized, cancelled, ...) need no answer

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wifi-scanner', title: 'WiFi Scanner', version: pkg.version },
        instructions: 'Use scan_wifi_networks to list nearby Wi-Fi networks, get_current_wifi for the active connection, and analyze_wifi_channels for congestion and router channel advice. All tools are read-only and local.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ handler, ...t }) => t) });
    case 'tools/call': {
      const name = params && params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return replyError(id, -32602, `Unknown tool: ${name}`);
      try {
        const args = checkArgs(params.arguments, tool.inputSchema);
        const data = await tool.handler(args);
        return reply(id, {
          content: [
            { type: 'text', text: summarize(name, data) },
            { type: 'text', text: JSON.stringify(data, null, 2) },
          ],
          structuredContent: data,
          isError: false,
        });
      } catch (e) {
        const err = e instanceof ScanError ? e : new ScanError(`Unexpected error: ${e && e.message ? e.message : e}`, { code: 'internal_error' });
        const payload = { error: err.message, code: err.code, hint: err.hint, platform: process.platform };
        return reply(id, {
          content: [{ type: 'text', text: err.hint ? `${err.message}\nHow to fix: ${err.hint}` : err.message }],
          structuredContent: payload,
          isError: true,
        });
      }
    }
    case 'resources/list': return reply(id, { resources: [] });
    case 'prompts/list': return reply(id, { prompts: [] });
    default:
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      for (const m of batch) {
        handle(m).catch((e) => {
          if (m && m.id != null) replyError(m.id, -32603, String(e && e.message ? e.message : e));
        });
      }
    }
  });
  // When the client closes stdin, Node exits on its own once in-flight scans have
  // replied (no process.exit, so buffered output on pipes is never cut off).
  process.stdin.resume();
}

if (require.main === module) main();

module.exports = { handle, TOOLS, summarize };
