'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const { before, after } = require('node:test');
let server;

before(async () => { server = await h.startServer(); });
after(async () => { await server.close(); });

test('an order id without a tracking token is rejected (401)', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);
  const res = await h.request(server.base, 'GET', '/orders/' + order.orderId);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
});

test('the right token returns the public order view', async () => {
  const { order, trackingToken } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 2 }]);
  const res = await h.request(server.base, 'GET', '/orders/' + order.orderId, { trackingToken });

  assert.equal(res.status, 200);
  assert.equal(res.body.order.status, 'PENDING');
  assert.equal(res.body.order.total, 7.35);
  // The public view must never leak the token or the actor trail.
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.order, 'trackingToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.order, 'actors'), false);
});

test('another order cannot be read with the wrong token (403)', async () => {
  const first = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);
  const second = await h.placeOrder(server.base, [{ id: 'b1', quantity: 1 }]);

  const res = await h.request(server.base, 'GET', '/orders/' + first.order.orderId, {
    trackingToken: second.trackingToken
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('an unknown order id is a 404 even with a token', async () => {
  const { trackingToken } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);
  const res = await h.request(server.base, 'GET', '/orders/ORD-NOPE', { trackingToken });
  assert.equal(res.status, 404);
});

test('tracking reflects backend status changes', async () => {
  const chef = await h.login(server.base, 'chef', 'chef123');
  const { order, trackingToken } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);

  await h.request(server.base, 'PATCH', '/kitchen/orders/' + order.orderId + '/start', { token: chef.token });

  const res = await h.request(server.base, 'GET', '/orders/' + order.orderId, { trackingToken });
  assert.equal(res.body.order.status, 'PREPARING');
});

test('order ids and tracking tokens are long and unique', async () => {
  const a = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);
  const b = await h.placeOrder(server.base, [{ id: 'c1', quantity: 1 }]);

  assert.notEqual(a.order.orderId, b.order.orderId);
  assert.notEqual(a.trackingToken, b.trackingToken);
  assert.ok(a.order.orderId.length >= 12);
  assert.ok(a.trackingToken.length >= 32);
});
