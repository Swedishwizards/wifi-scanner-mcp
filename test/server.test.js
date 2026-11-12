'use strict';
// End-to-end protocol test: starts the real server over stdio with a fake backend.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const FAKE = path.join(__dirname, 'fake-backend.js');

function startServer() {
  const child = spawn(process.execPath, ['-r', FAKE, SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  let next = 1;
  const call = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { child, call, notify };
}

test('MCP handshake, tools/list and all three tools', async () => {
  const { child, call, notify } = startServer();
  try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'wifi-scanner');
    notify('notifications/initialized');

    const list = await call('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['analyze_wifi_channels', 'get_current_wifi', 'scan_wifi_networks']);
    for (const t of list.result.tools) {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.handler, undefined);
    }

    const scan = await call('tools/call', { name: 'scan_wifi_networks', arguments: {} });
    assert.equal(scan.result.isError, false);
    const s = scan.result.structuredContent;
    assert.equal(s.count, 3); // HomeNet (grouped), CoffeeShop Free, Office-WPA3; hidden left out
    assert.equal(s.networks[0].ssid, 'HomeNet'); // connected first
    assert.match(scan.result.content[0].text, /Found 3 network/);

    const only5 = await call('tools/call', { name: 'scan_wifi_networks', arguments: { band: '5 GHz', include_hidden: true, group_by_network: false } });
    assert.deepEqual(only5.result.structuredContent.networks.map((n) => n.channel).sort((a, b) => a - b), [36, 149]);

    const strong = await call('tools/call', { name: 'scan_wifi_networks', arguments: { min_signal_dbm: -60, sort_by: 'name' } });
    assert.deepEqual(strong.result.structuredContent.networks.map((n) => n.ssid), ['HomeNet', 'Office-WPA3']);

    const cur = await call('tools/call', { name: 'get_current_wifi', arguments: {} });
    assert.equal(cur.result.structuredContent.ssid, 'HomeNet');

    const an = await call('tools/call', { name: 'analyze_wifi_channels', arguments: {} });
    const a = an.result.structuredContent;
    assert.equal(a.total_access_points, 5);
    assert.ok([1, 6, 11].includes(a.bands['2.4 GHz'].recommended_channel));
    assert.notEqual(a.bands['2.4 GHz'].recommended_channel, 6); // 6 is taken by a strong AP
    assert.equal(a.your_network.channel, 36);
    assert.ok(a.security_findings.some((f) => f.network === 'CoffeeShop Free' && f.issue === 'open'));

    const bad = await call('tools/call', { name: 'scan_wifi_networks', arguments: { band: 'banana' } });
    assert.equal(bad.result.isError, true);

    const unknown = await call('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);

    const ping = await call('ping', {});
    assert.deepEqual(ping.result, {});
  } finally {
    child.kill();
  }
});

test('errors from the backend come back as readable tool errors', async () => {
  const child = spawn(process.execPath, ['-r', FAKE, SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FAKE_FAIL: '1' } });
  const out = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n').filter(Boolean);
      if (lines.length >= 2) resolve(lines.map((l) => JSON.parse(l)));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scan_wifi_networks', arguments: {} } }) + '\n');
  });
  child.kill();
  const r = out.find((m) => m.id === 2).result;
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'permission_denied');
  assert.match(r.content[0].text, /How to fix/);
});
