'use strict';
// Preloaded with `node -r` in tests: replaces the platform backend with fixture data,
// so the protocol and tool logic can be tested on any OS without a Wi-Fi adapter.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const win = require('../server/platforms/windows');
const { ScanError } = require('../server/lib/exec');

const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'netsh-networks-en.txt'), 'utf8');
const ifaces = fs.readFileSync(path.join(__dirname, 'fixtures', 'netsh-interfaces-en.txt'), 'utf8');

const fake = {
  async scan() {
    if (process.env.FAKE_FAIL) throw new ScanError('Location is off.', { code: 'permission_denied', hint: 'Turn it on.' });
    const cur = win.parseInterfaces(ifaces);
    return { networks: win.parseNetworks(text, { ssid: cur.ssid, bssid: cur.bssid }), notes: [] };
  },
  async current() { return win.parseInterfaces(ifaces); },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (/platforms[\\/](macos|windows|linux)$/.test(request) && parent && /server[\\/]index\.js$/.test(parent.filename)) return fake;
  return origLoad.call(this, request, parent, isMain);
};
