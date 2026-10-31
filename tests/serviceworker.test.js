import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run public/sw.js in a mocked worker scope with a failing network and assert
// every respondWith() resolves to a real Response - never undefined (the bug
// that surfaced as ERR_FAILED for returning users).
const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const load = () => {
  const handlers = {};
  const self = { addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting: () => {} };
  const clients = { claim: () => {} };
  const location = { origin: 'https://hi.test' };
  const failingFetch = () => Promise.reject(new Error('offline'));
  new Function('self', 'clients', 'location', 'fetch', 'caches', src)(self, clients, location, failingFetch, { match: async () => undefined });
  return handlers;
};
const fire = async (handlers, req) => {
  let responded;
  handlers.fetch({ request: req, respondWith: (p) => { responded = Promise.resolve(p); } });
  return responded;
};

test('failed navigation returns a real offline page, never undefined', async () => {
  const res = await fire(load(), { method: 'GET', url: 'https://hi.test/', mode: 'navigate' });
  assert.ok(res instanceof Response, 'navigation failure must resolve to a Response');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /No connection/);
});

test('failed asset GET returns a plain Response, never undefined', async () => {
  const res = await fire(load(), { method: 'GET', url: 'https://hi.test/boot.js', mode: 'no-cors' });
  assert.ok(res instanceof Response, 'asset failure must resolve to a Response');
  assert.equal(res.status, 504);
});

test('non-GET and cross-origin requests are left alone', async () => {
  const handlers = load();
  assert.equal(await fire(handlers, { method: 'POST', url: 'https://hi.test/app', mode: 'navigate' }), undefined);
  assert.equal(await fire(handlers, { method: 'GET', url: 'https://other.test/', mode: 'navigate' }), undefined);
});
