'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const { before, after } = require('node:test');
let server;
let chef;
let waiter;
let orders;

before(async () => {
  server = await h.startServer();
  chef = await h.login(server.base, 'chef', 'chef123');
  waiter = await h.login(server.base, 'waiter', 'waiter123');

  // Three orders with clearly separated timestamps so FIFO order is provable.
  orders = [];
  for (let i = 0; i < 3; i += 1) {
    const placed = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);
    orders.push(placed.order);
    await h.sleep(10);
  }
});
after(async () => { await server.close(); });

test('the pending queue is oldest-first (FIFO)', async () => {
  const res = await h.request(server.base, 'GET', '/kitchen/queue', { token: chef.token });
  assert.equal(res.status, 200);

  const ids = res.body.pending.map((order) => order.orderId);
  assert.deepEqual(ids, [orders[0].orderId, orders[1].orderId, orders[2].orderId]);
});

test('several orders can be preparing at once, without breaking FIFO', async () => {
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + orders[1].orderId + '/start', { token: chef.token });
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + orders[0].orderId + '/start', { token: chef.token });

  const res = await h.request(server.base, 'GET', '/kitchen/queue', { token: chef.token });
  assert.equal(res.body.preparing.length, 2);
  // orders[0] was started second, so it should sort after orders[1] on preparingAt.
  assert.deepEqual(res.body.preparing.map((o) => o.orderId), [orders[1].orderId, orders[0].orderId]);
  // Only the third order is still waiting.
  assert.deepEqual(res.body.pending.map((o) => o.orderId), [orders[2].orderId]);
});

test('counts cover all five statuses', async () => {
  const res = await h.request(server.base, 'GET', '/kitchen/queue', { token: chef.token });
  assert.equal(res.body.counts.PENDING, 1);
  assert.equal(res.body.counts.PREPARING, 2);
  assert.equal(res.body.counts.READY, 0);
  assert.equal(res.body.counts.PICKED_UP, 0);
  assert.equal(res.body.counts.SERVED, 0);
});

test('the waiter board separates preparing, ready and picked-up', async () => {
  const board = await h.request(server.base, 'GET', '/service/orders', { token: waiter.token });
  assert.equal(board.status, 200);
  assert.equal(board.body.preparing.length, 2);
  assert.equal(board.body.ready.length, 0);
  assert.equal(board.body.pickedUp.length, 0);

  await h.request(server.base, 'PATCH', '/kitchen/orders/' + orders[1].orderId + '/ready', { token: chef.token });

  const after = await h.request(server.base, 'GET', '/service/orders', { token: waiter.token });
  assert.equal(after.body.ready.length, 1);
  assert.equal(after.body.ready[0].orderId, orders[1].orderId);
});
