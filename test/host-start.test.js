'use strict';
// Regression: Claude Desktop runs .mcpb extensions through its own bootstrap script. The server
// must still start listening on stdin there (it did not in the first 1.0.0 build).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'host-bootstrap.js');

test('the server answers initialize when a host loads it through a bootstrap script', async () => {
  const child = spawn(process.execPath, [BOOTSTRAP, SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const reply = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl !== -1) { clearTimeout(timer); child.kill(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  });
  assert.ok(reply, 'no reply within 5 s: the server did not start under a bootstrap script');
  assert.equal(reply.id, 1);
  assert.equal(reply.result.serverInfo.name, 'wifi-scanner');
});
