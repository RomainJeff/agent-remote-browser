import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicIPv4 } from '../../egress.mjs';

// RFC 6890 special-purpose IPv4 ranges (+ multicast/reserved): first and last address of each must be refused.
const special = [
  ['0.0.0.0', '0.255.255.255'],         // "this network"
  ['10.0.0.0', '10.255.255.255'],       // private
  ['100.64.0.0', '100.127.255.255'],    // shared address space (CGNAT)
  ['127.0.0.0', '127.255.255.255'],     // loopback
  ['169.254.0.0', '169.254.255.255'],   // link local (cloud metadata)
  ['172.16.0.0', '172.31.255.255'],     // private
  ['192.0.0.0', '192.0.0.255'],         // IETF protocol assignments
  ['192.0.2.0', '192.0.2.255'],         // TEST-NET-1
  ['192.88.99.0', '192.88.99.255'],     // 6to4 relay anycast
  ['192.168.0.0', '192.168.255.255'],   // private
  ['198.18.0.0', '198.19.255.255'],     // benchmarking
  ['198.51.100.0', '198.51.100.255'],   // TEST-NET-2
  ['203.0.113.0', '203.0.113.255'],     // TEST-NET-3
  ['224.0.0.0', '239.255.255.255'],     // multicast
  ['240.0.0.0', '255.255.255.255'],     // reserved + limited broadcast
];

// Public neighbours just outside those ranges, and well-known public resolvers.
const pub = ['1.0.0.0', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.0',
  '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.88.98.255', '192.88.100.0',
  '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '198.51.99.255', '198.51.101.0', '203.0.112.255',
  '203.0.114.0', '223.255.255.255', '1.1.1.1', '8.8.8.8', '93.184.215.14'];

test('special-purpose ranges are refused', () => {
  for (const [first, last] of special) {
    assert.equal(publicIPv4(first), false, first);
    assert.equal(publicIPv4(last), false, last);
  }
});

test('public addresses are accepted', () => {
  for (const a of pub) assert.equal(publicIPv4(a), true, a);
});

test('non-IPv4 input is refused', () => {
  for (const a of ['::1', '::ffff:127.0.0.1', '2606:4700::1111', 'example.com', '', '1.2.3', '256.1.1.1', '01.2.3.4'])
    assert.equal(publicIPv4(a), false, a);
});
