'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const { before, after } = require('node:test');
let server;

before(async () => { server = await h.startServer(); });
after(async () => { await server.close(); });

test('subtotal + 5% tax + total are computed server-side', async () => {
  // c1 @3.50 x2 = 7.00 ; w1 @6.00 x1 = 6.00 -> subtotal 13.00, tax 0.65, total 13.65
  const { order } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 2 }, { id: 'w1', quantity: 1 }]);

  assert.equal(order.subtotal, 13.00);
  assert.equal(order.tax, 0.65);
  assert.equal(order.total, 13.65);
  assert.equal(order.totalPrepTime, 5 * 2 + 9);
});

test('line totals use menu prices, not client prices', async () => {
  const res = await h.request(server.base, 'POST', '/orders', {
    body: { items: [{ id: 'c1', quantity: 2, price: 0.01, unitPrice: 0.01, lineTotal: 0.02, name: 'Hacked Espresso' }] }
  });
  assert.equal(res.status, 201);

  const [item] = res.body.order.items;
  assert.equal(item.unitPrice, 3.5);
  assert.equal(item.name, 'Artisanal Espresso');
  assert.equal(item.lineTotal, 7);
  assert.equal(res.body.order.total, 7.35);
});

test('a tampered totalAmount is ignored', async () => {
  const res = await h.request(server.base, 'POST', '/orders', {
    body: {
      items: [{ id: 'w2', quantity: 2 }],
      totalAmount: 0.01,
      subtotal: 0.01,
      tax: 0,
      total: 0.01
    }
  });

  // w2 @6.50 x2 = 13.00 ; tax 0.65 ; total 13.65
  assert.equal(res.body.order.subtotal, 13.00);
  assert.equal(res.body.order.tax, 0.65);
  assert.equal(res.body.order.total, 13.65);
});

test('money is rounded to two decimals', async () => {
  // c1 @3.50 x3 = 10.50 ; tax = 0.525 -> 0.53 ; total 11.03
  const { order } = await h.placeOrder(server.base, [{ id: 'c1', quantity: 3 }]);
  assert.equal(order.subtotal, 10.5);
  assert.equal(order.tax, 0.53);
  assert.equal(order.total, 11.03);
});

test('payment is always recorded as SIMULATED', async () => {
  const { order } = await h.placeOrder(server.base, [{ id: 'b1', quantity: 1 }]);
  assert.equal(order.payment.status, 'SIMULATED');
});
