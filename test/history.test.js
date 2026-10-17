'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const TODAY = new Date().toISOString().slice(0, 10);
const OTHER_DAY = '1970-01-01';

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

test('kitchen history is filtered by the READY date', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 2 }, { id: 'b1', quantity: 1 }]);
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/ready', { token: chef.token });

  const today = await h.request(server.base, 'GET', '/kitchen/history?date=' + TODAY, { token: chef.token });
  assert.equal(today.status, 200);
  assert.equal(today.body.date, TODAY);
  assert.ok(today.body.orders.some((candidate) => candidate.orderId === order.orderId));

  const other = await h.request(server.base, 'GET', '/kitchen/history?date=' + OTHER_DAY, { token: chef.token });
  assert.equal(other.body.orders.length, 0);
});

test('top-prepared counts completed item quantity', async () => {
  const res = await h.request(server.base, 'GET', '/stats/top-prepared?date=' + TODAY, { token: chef.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.ordersCompleted, 1);

  const top = res.body.items[0];
  assert.equal(top.id, 'c1');
  assert.equal(top.quantity, 2);
  assert.equal(top.name, 'Artisanal Espresso');

  const second = res.body.items[1];
  assert.equal(second.id, 'b1');
  assert.equal(second.quantity, 1);
});

test('service history is filtered by the SERVED date', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'b2', quantity: 1 }]);
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });
  await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/ready', { token: chef.token });
  await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/pickup', { token: waiter.token });
  await h.request(server.base, 'PATCH', '/service/orders/' + order.orderId + '/serve', { token: waiter.token });

  const today = await h.request(server.base, 'GET', '/service/history?date=' + TODAY, { token: waiter.token });
  const match = today.body.orders.find((candidate) => candidate.orderId === order.orderId);
  assert.ok(match);
  assert.equal(match.status, 'SERVED');

  const other = await h.request(server.base, 'GET', '/service/history?date=' + OTHER_DAY, { token: waiter.token });
  assert.equal(other.body.orders.length, 0);
});

test('a malformed date is a 400', async () => {
  const res = await h.request(server.base, 'GET', '/kitchen/history?date=16-10-2026', { token: chef.token });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('history endpoints reject the wrong role', async () => {
  const res = await h.request(server.base, 'GET', '/service/history?date=' + TODAY, { token: chef.token });
  assert.equal(res.status, 403);
});
