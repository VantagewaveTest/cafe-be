'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const { before, after } = require('node:test');
let server;

before(async () => { server = await h.startServer(); });
after(async () => { await server.close(); });

test('GET /api/menu returns the nine menu items with a price', async () => {
  const res = await h.request(server.base, 'GET', '/menu');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.menu.length, 9);
  res.body.menu.forEach((item) => {
    assert.equal(typeof item.id, 'string');
    assert.equal(typeof item.price, 'number');
    assert.equal(typeof item.prepTime, 'number');
  });
});

test('GET /api/health reports ok', async () => {
  const res = await h.request(server.base, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('an unknown route is a 404 with a code', async () => {
  const res = await h.request(server.base, 'GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('an empty cart is rejected with 400', async () => {
  const res = await h.request(server.base, 'POST', '/orders', { body: { items: [] } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('an unknown menu id is rejected with 400', async () => {
  const res = await h.request(server.base, 'POST', '/orders', { body: { items: [{ id: 'zz9', quantity: 1 }] } });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /Unknown menu item/);
});

test('quantities must be positive whole numbers', async () => {
  for (const quantity of [0, -3, 1.5, '2', null]) {
    const res = await h.request(server.base, 'POST', '/orders', { body: { items: [{ id: 'c1', quantity }] } });
    assert.equal(res.status, 400, 'quantity ' + JSON.stringify(quantity) + ' should be rejected');
    assert.equal(res.body.code, 'VALIDATION_ERROR');
  }
});

test('a duplicate menu id in one cart is rejected', async () => {
  const res = await h.request(server.base, 'POST', '/orders', {
    body: { items: [{ id: 'c1', quantity: 1 }, { id: 'c1', quantity: 2 }] }
  });
  assert.equal(res.status, 400);
});

test('malformed JSON is rejected with 400, not a crash', async () => {
  const raw = await fetch(server.base + '/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ this is not json'
  });
  assert.equal(raw.status, 400);
  const payload = await raw.json();
  assert.equal(payload.code, 'VALIDATION_ERROR');
});

test('dine-in requires a table number, pickup does not', async () => {
  const bad = await h.request(server.base, 'POST', '/orders', {
    body: { items: [{ id: 'c1', quantity: 1 }], fulfilment: { type: 'DINE_IN' } }
  });
  assert.equal(bad.status, 400);

  const good = await h.request(server.base, 'POST', '/orders', {
    body: { items: [{ id: 'c1', quantity: 1 }], fulfilment: { type: 'DINE_IN', tableNumber: 7 } }
  });
  assert.equal(good.status, 201);
  assert.deepEqual(good.body.order.fulfilment, { type: 'DINE_IN', tableNumber: 7 });
});
