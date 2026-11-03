import test from 'node:test';
import assert from 'node:assert/strict';
import { createQrSvg } from './qr-code.mjs';

const invite = 'https://justchan005.github.io/matching-game/?event=abc123def456';

test('event QR SVG is deterministic, standalone, and contains no remote resources', () => {
  const svg = createQrSvg(invite);
  assert.equal(svg, createQrSvg(invite));
  assert.match(svg, /^<svg /);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /fill="white"/);
  assert.match(svg, /fill="black"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.ok(svg.endsWith('</svg>'));
  assert.doesNotMatch(svg, /(?:href=|<image|<script|<title|<description)/);
  assert.ok(!svg.includes(invite), 'Link is encoded as modules, not injected into markup');
  assert.notEqual(svg, createQrSvg(invite.replace('abc123def456', 'def456abc123')));
});

test('every QR module is square and has a four-module white margin on every side', () => {
  const svg = createQrSvg(invite);
  const [, width, height] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.equal(width, height);
  const modules = [...svg.matchAll(/M(\d+),(\d+)l(\d+),0 0,(\d+) -(\d+),0 0,-(\d+)z/g)];
  assert.ok(modules.length > 100);
  const size = Number(modules[0][3]);
  for (const module of modules) {
    const [x, y, right, down, left, up] = module.slice(1).map(Number);
    assert.deepEqual([right, down, left, up], [size, size, size, size]);
    assert.ok(x >= size * 4 && y >= size * 4);
    assert.ok(x + size <= Number(width) - size * 4);
    assert.ok(y + size <= Number(height) - size * 4);
  }
  assert.equal(Math.min(...modules.map((m) => Number(m[1]))), size * 4);
  assert.equal(Math.min(...modules.map((m) => Number(m[2]))), size * 4);
});

test('QR generation accepts Unicode and rejects empty or oversized input', () => {
  assert.match(createQrSvg('https://example.com/活动/?event=abc123def456'), /^<svg /);
  for (const value of ['', '  ', null, undefined, 42]) {
    assert.throws(() => createQrSvg(value), /invitation link is required/);
  }
  assert.throws(() => createQrSvg('x'.repeat(1025)), /too long/);
  assert.throws(() => createQrSvg('界'.repeat(342)), /too long/);
});
