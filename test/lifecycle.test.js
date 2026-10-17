'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const { before, after } = require('node:test');
let server;
let chef;
let waiter;

before(async () => {
  server = await h.startServer();
  chef = await h.login(server.base, 'chef', 'chef123');
  waiter = await h.login(server.base, 'waiter', 'waiter123');
});
after(async () => { await server.close(); });

test('the full lifecycle walks PENDING -> PREPARING -> READY -> PICKED_UP -> SERVED', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'k1', quantity: 1 }]);
  assert.equal(order.status, 'PENDING');

  const started = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  assert.equal(started.status, 200);
  assert.equal(started.body.order.status, 'PREPARING');

  const ready = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/ready', { token: chef.token });
  assert.equal(ready.status, 200);
  assert.equal(ready.body.order.status, 'READY');

  const picked = await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/pickup', { token: waiter.token });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.order.status, 'PICKED_UP');

  const served = await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/serve', { token: waiter.token });
  assert.equal(served.status, 200);
  assert.equal(served.body.order.status, 'SERVED');

  const view = served.body.order;
  assert.equal(view.timestamps.preparingAt !== null, true);
  assert.equal(view.timestamps.readyAt !== null, true);
  assert.equal(view.timestamps.pickedUpAt !== null, true);
  assert.equal(view.timestamps.servedAt !== null, true);
});

test('every legal move records the actor and role', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'b2', quantity: 1 }]);

  const started = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  const ready = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/ready', { token: chef.token });
  const picked = await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/pickup', { token: waiter.token });
  const served = await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/serve', { token: waiter.token });

  const actors = served.body.order.actors;
  assert.deepEqual({ u: started.body.order.actors.startedBy.username, r: started.body.order.actors.startedBy.role }, { u: 'chef', r: 'CHEF' });
  assert.equal(ready.body.order.actors.readyBy.username, 'chef');
  assert.equal(picked.body.order.actors.pickedUpBy.username, 'waiter');
  assert.equal(served.body.order.actors.servedBy.role, 'WAITER');
  assert.ok(actors.startedBy.at);
});

test('a skipped transition is a 409', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'c3', quantity: 1 }]);
  // READY straight from PENDING is not allowed.
  const res = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/ready', { token: chef.token });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'INVALID_TRANSITION');
});

test('a repeated transition is a 409', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'c2', quantity: 1 }]);
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  const again = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  assert.equal(again.status, 409);
});

test('a chef cannot serve and a waiter cannot start (403)', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'w1', quantity: 1 }]);

  const chefServe = await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/serve', { token: chef.token });
  assert.equal(chefServe.status, 403);

  const waiterStart = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: waiter.token });
  assert.equal(waiterStart.status, 403);

  // ...and the role check wins over the state check.
  const waiterReady = await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/ready', { token: waiter.token });
  assert.equal(waiterReady.status, 403);
});

test('an unknown order id is a 404', async () => {
  const res = await h.request(server.base, 'PATCH', '/kitchen/orders/ORD-DOESNOTEXIST/start', { token: chef.token });
  assert.equal(res.status, 404);
});
