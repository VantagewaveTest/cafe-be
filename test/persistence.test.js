'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const h = require('./helpers');
const STORE = h.useTempStore();

test('two back-to-back submissions both persist, atomically', async () => {
  const server = await h.startServer();

  const [a, b] = await Promise.all([
    h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]),
    h.placeOrder(server.base, [{ id: 'c2', quantity: 1 }])
  ]);
  assert.notEqual(a.order.orderId, b.order.orderId);

  const onDisk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  assert.equal(onDisk.length, 2);
  const ids = onDisk.map((order) => order.orderId).sort();
  assert.deepEqual(ids, [a.order.orderId, b.order.orderId].sort());

  // No temp file survives a successful write.
  const leftovers = fs.readdirSync(path.dirname(STORE)).filter((name) => name.indexOf('.tmp-') !== -1);
  assert.deepEqual(leftovers, []);

  await server.close();
});

test('a restart keeps statuses, timestamps and actors', async () => {
  const first = await h.startServer();
  const chef = await h.login(first.base, 'chef', 'chef123');
  const { order, trackingToken } = await h.placeOrder(first.base, [{ id: 'k1', quantity: 2 }]);
  await h.request(first.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  await first.close();

  // Simulate a process restart: drop module state, boot again on the same file.
  h.purgeCafeModules();
  const second = await h.startServer();

  const res = await h.request(second.base, 'GET', '/orders/' + order.orderId, { trackingToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'PREPARING');
  assert.ok(res.body.order.timestamps.preparingAt);

  const queue = await h.login(second.base, 'chef', 'chef123');
  const board = await h.request(second.base, 'GET', '/kitchen/queue', { token: queue.token });
  const survivor = board.body.preparing.find((candidate) => candidate.orderId === order.orderId);
  assert.ok(survivor, 'the order should still be in the kitchen queue after restart');
  assert.equal(survivor.actors.startedBy.username, 'chef');

  await second.close();
});

test('a corrupt store is set aside and the server still boots', async () => {
  fs.writeFileSync(STORE, '{ this is not valid json');
  h.purgeCafeModules();

  const server = await h.startServer();
  const chef = await h.login(server.base, 'chef', 'chef123');
  const res = await h.request(server.base, 'GET', '/kitchen/queue', { token: chef.token });

  assert.equal(res.status, 200);
  assert.equal(res.body.counts.PENDING, 0);

  const corrupted = fs.readdirSync(path.dirname(STORE)).filter((name) => name.indexOf('.corrupt-') !== -1);
  assert.equal(corrupted.length, 1, 'the damaged file should be kept aside for inspection');

  await server.close();
});

test('legacy lowercase pending records are migrated on load', () => {
  const purged = h.purgeCafeModules();
  assert.equal(purged, undefined); // helper returns nothing; just ensure it ran

  const legacyPath = path.join(path.dirname(STORE), 'legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify([
    {
      orderId: 'ORD-LEGACY1',
      items: [{ id: 'c1', name: 'Artisanal Espresso', price: 3.5, quantity: 2, prepTime: 10 }],
      totalAmount: 7.35,
      totalPrepTime: 10,
      status: 'pending',
      createdAt: '2026-01-01T10:00:00.000Z'
    }
  ]));

  const previous = process.env.CAFE_ORDERS_FILE;
  process.env.CAFE_ORDERS_FILE = legacyPath;
  h.purgeCafeModules();

  // eslint-disable-next-line global-require
  const orders = require('../orders');
  const [migrated] = orders.all();
  assert.equal(migrated.status, 'PENDING');
  assert.equal(migrated.subtotal, 7);
  assert.equal(migrated.tax, 0.35);
  assert.equal(migrated.total, 7.35);
  assert.equal(migrated.fulfilment.type, 'PICKUP');
  assert.equal(migrated.payment.status, 'SIMULATED');

  process.env.CAFE_ORDERS_FILE = previous;
  h.purgeCafeModules();
});
