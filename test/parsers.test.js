'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const win = require('../server/platforms/windows');
const mac = require('../server/platforms/macos');
const linux = require('../server/platforms/linux');
const { normalizeSecurity, groupBySsid, percentToDbm } = require('../server/lib/normalize');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('windows: English netsh networks', () => {
  const nets = win.parseNetworks(fx('netsh-networks-en.txt'), { ssid: 'HomeNet', bssid: 'a4:2b:b0:11:22:33' });
  assert.equal(nets.length, 5);
  const [a, b, c, hidden, d] = nets;
  assert.equal(a.ssid, 'HomeNet');
  assert.equal(a.bssid, 'a4:2b:b0:11:22:33');
  assert.equal(a.signal_percent, 92);
  assert.equal(a.signal_dbm, -54);
  assert.equal(a.channel, 36);
  assert.equal(a.band, '5 GHz');
  assert.equal(a.security, 'WPA2');
  assert.equal(a.phy_mode, '802.11ax');
  assert.equal(a.connected, true);
  assert.equal(b.channel, 6);
  assert.equal(b.band, '2.4 GHz');
  assert.equal(b.connected, false);
  assert.equal(c.ssid, 'CoffeeShop Free');
  assert.equal(c.security, 'open');
  assert.equal(c.channel, 1);
  assert.equal(hidden.ssid, null);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.channel, 149);
  assert.equal(hidden.band, '5 GHz');
  assert.equal(d.security, 'WPA3');
  assert.equal(d.band, '6 GHz');
  assert.equal(d.channel, 37);
});

test('windows: Swedish netsh networks (localized keys, dashes in BSSID, comma band)', () => {
  const nets = win.parseNetworks(fx('netsh-networks-sv.txt'));
  assert.equal(nets.length, 2);
  assert.equal(nets[0].ssid, 'Hemmanätet Åkesson');
  assert.equal(nets[0].channel, 44);
  assert.equal(nets[0].signal_percent, 81);
  assert.equal(nets[0].security, 'WPA2');
  assert.equal(nets[1].ssid, 'Gäst');
  assert.equal(nets[1].bssid, '3c:84:6a:aa:bb:cd');
  assert.equal(nets[1].band, '2.4 GHz');
  assert.equal(nets[1].channel, 11);
  assert.equal(nets[1].security, 'open');
});

test('windows: interfaces (connected)', () => {
  const c = win.parseInterfaces(fx('netsh-interfaces-en.txt'));
  assert.equal(c.connected, true);
  assert.equal(c.ssid, 'HomeNet');
  assert.equal(c.bssid, 'a4:2b:b0:11:22:33');
  assert.equal(c.channel, 36);
  assert.equal(c.band, '5 GHz');
  assert.equal(c.signal_percent, 92);
  assert.equal(c.security, 'WPA2');
  assert.equal(c.receive_rate_mbps, 1201);
  assert.equal(c.transmit_rate_mbps, 960);
});

test('windows: interfaces (disconnected)', () => {
  const c = win.parseInterfaces(fx('netsh-interfaces-disconnected.txt'));
  assert.equal(c.connected, false);
  assert.equal(c.interfaces, 1);
});

test('macos: system_profiler fallback', () => {
  const r = mac.parseSystemProfiler(fx('system_profiler.json'));
  assert.equal(r.interface, 'en0');
  assert.equal(r.power, true);
  assert.equal(r.networks.length, 3);
  assert.equal(r.current.connected, true);
  assert.equal(r.current.ssid, null); // redacted by macOS
  assert.equal(r.current.channel, 36);
  assert.equal(r.current.channel_width_mhz, 80);
  assert.equal(r.current.band, '5 GHz');
  assert.equal(r.current.signal_dbm, -48);
  assert.equal(r.current.noise_dbm, -93);
  assert.equal(r.current.security, 'WPA2/WPA3'); // wpa3_transition
  assert.equal(r.networks[1].band, '2.4 GHz');
  assert.equal(r.networks[2].security, 'open');
});

test('macos: channel text parsing', () => {
  assert.deepEqual(mac.parseChannelText('6 (2GHz, 20MHz)'), { channel: 6, band: '2.4 GHz', width: 20 });
  assert.deepEqual(mac.parseChannelText('37 (6GHz, 160MHz)'), { channel: 37, band: '6 GHz', width: 160 });
  assert.deepEqual(mac.parseChannelText(11), { channel: 11, band: null, width: null });
});

test('linux: nmcli terse output with escaped colons', () => {
  const nets = linux.parseNmcli(fx('nmcli.txt'));
  assert.equal(nets.length, 4);
  assert.equal(nets[0].bssid, 'a4:2b:b0:11:22:33');
  assert.equal(nets[0].connected, true);
  assert.equal(nets[0].band, '5 GHz');
  assert.equal(nets[1].security, 'open');
  assert.equal(nets[1].band, '2.4 GHz');
  assert.equal(nets[2].ssid, null);
  assert.equal(nets[3].ssid, 'Odd:Name');
  assert.equal(nets[3].band, '6 GHz');
});

test('security normalization', () => {
  const cases = {
    'WPA2-Personal': 'WPA2', 'WPA3-Personal': 'WPA3', 'WPA2-Enterprise': 'enterprise', 'Open': 'open',
    'Öppen': 'open', 'WEP': 'WEP', 'WPA-Personal': 'WPA', 'WPA2/WPA3 Personal': 'WPA2/WPA3',
    'wpa3 transition': 'WPA2/WPA3', 'WPA1 WPA2': 'WPA2', 'WPA2 802.1X': 'enterprise', '': 'open', 'Företag': 'enterprise',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeSecurity(raw), want, raw);
});

test('grouping keeps the strongest access point and counts the rest', () => {
  const nets = win.parseNetworks(fx('netsh-networks-en.txt'));
  const g = groupBySsid(nets);
  const home = g.find((n) => n.ssid === 'HomeNet');
  assert.equal(home.access_points, 2);
  assert.equal(home.signal_percent, 92);
  assert.deepEqual(home.bands, ['2.4 GHz', '5 GHz']);
});

test('percent to dBm', () => {
  assert.equal(percentToDbm(100), -50);
  assert.equal(percentToDbm(0), -100);
});

test('windows: location-denied message becomes a permission error with a fix', () => {
  const text = fx('netsh-location-denied.txt');
  assert.throws(() => win.checkErrors({ code: 1 }, text), (e) => e.code === 'permission_denied' && /Location/.test(e.hint));
  assert.doesNotThrow(() => win.checkErrors({ code: 0 }, fx('netsh-networks-en.txt')));
});
