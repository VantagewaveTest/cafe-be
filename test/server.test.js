const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a throwaway orders file so tests never clobber real data.
const TEST_ORDERS = path.join(os.tmpdir(), `cafe-test-orders-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
process.env.ORDERS_FILE = TEST_ORDERS;
process.env.STAFF_USERS = 'chef1:chef-secret:CHEF,waiter1:waiter-secret:WAITER';

const mod = require('../server.js');
const { server } = mod;

let baseUrl;
let port;

function request(method, pathName, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: pathName, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}, headers || {})
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login(username, password) {
  const r = await request('POST', '/api/auth/login', { body: { username, password } });
  return r.json && r.json.token;
}

async function placeOrder(overrides = {}) {
  const body = Object.assign({
    items: [{ id: 'c1', quantity: 2 }, { id: 'w1', quantity: 1 }],
    fulfillment: 'table', tableNumber: 'T4', paymentMethod: 'card'
  }, overrides);
  return request('POST', '/api/orders', { body });
}

test.before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(() => {
  server.close();
  try { fs.unlinkSync(TEST_ORDERS); } catch {}
  try { fs.unlinkSync(TEST_ORDERS + '.tmp'); } catch {}
});

test('server-side pricing and 5% tax (client total ignored)', async () => {
  const r = await placeOrder({ totalAmount: 1.0, items: [{ id: 'c1', quantity: 2, price: 0.01 }] });
  assert.strictEqual(r.status, 201);
  // c1 price 3.50 x2 = 7.00; tax 0.35; total 7.35
  assert.strictEqual(r.json.subtotal, 7.0);
  assert.strictEqual(r.json.tax, 0.35);
  assert.strictEqual(r.json.total, 7.35);
  assert.strictEqual(r.json.status, 'PENDING');
  assert.ok(r.json.trackingToken, 'returns tracking token');
});

test('rejects unknown menu item', async () => {
  const r = await placeOrder({ items: [{ id: 'zz', quantity: 1 }] });
  assert.strictEqual(r.status, 400);
});

test('rejects non-positive and non-integer quantities', async () => {
  assert.strictEqual((await placeOrder({ items: [{ id: 'c1', quantity: 0 }] })).status, 400);
  assert.strictEqual((await placeOrder({ items: [{ id: 'c1', quantity: 2.5 }] })).status, 400);
});

test('rejects malformed JSON', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/orders', method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{ not json');
  });
  assert.strictEqual(r, 400);
});

test('staff auth: bad credentials 401, correct returns role', async () => {
  const bad = await request('POST', '/api/auth/login', { body: { username: 'chef1', password: 'nope' } });
  assert.strictEqual(bad.status, 401);
  const chef = await login('chef1', 'chef-secret');
  assert.ok(chef);
  const r = await request('GET', '/api/auth/login'.replace('/auth/login', '/kitchen/queue'), { headers: { Authorization: `Bearer ${chef}` } });
  assert.strictEqual(r.status, 200);
});

test('unauthenticated staff access is 401; wrong role is 403', async () => {
  assert.strictEqual((await request('GET', '/api/kitchen/queue')).status, 401);
  const waiter = await login('waiter1', 'waiter-secret');
  assert.strictEqual((await request('GET', '/api/kitchen/queue', { headers: { Authorization: `Bearer ${waiter}` } })).status, 403);
  const chef = await login('chef1', 'chef-secret');
  assert.strictEqual((await request('PATCH', '/api/service/orders/x/pickup', { headers: { Authorization: `Bearer ${chef}` } })).status, 403);
});

test('guest tracking: token required and order-scoped', async () => {
  const r = await placeOrder();
  const { orderId, trackingToken } = r.json;
  assert.strictEqual((await request('GET', `/api/orders/${orderId}`)).status, 401);
  assert.strictEqual((await request('GET', `/api/orders/${orderId}`, { headers: { 'X-Order-Token': 'wrong' } })).status, 403);
  const ok = await request('GET', `/api/orders/${orderId}`, { headers: { 'X-Order-Token': trackingToken } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.order.status, 'PENDING');
  // Token never leaks through staff queue.
  const chef = await login('chef1', 'chef-secret');
  const queue = await request('GET', '/api/kitchen/queue', { headers: { Authorization: `Bearer ${chef}` } });
  assert.ok(!queue.raw.includes(trackingToken), 'queue must not expose guest token');
});

test('full lifecycle with actor/timestamps and invalid transitions', async () => {
  const { orderId } = (await placeOrder()).json;
  const chef = await login('chef1', 'chef-secret');
  const waiter = await login('waiter1', 'waiter-secret');
  const chefH = { Authorization: `Bearer ${chef}` };
  const waiterH = { Authorization: `Bearer ${waiter}` };

  // Skipped transition rejected: READY before PREPARING.
  assert.strictEqual((await request('PATCH', `/api/kitchen/orders/${orderId}/ready`, { headers: chefH })).status, 409);

  const start = await request('PATCH', `/api/kitchen/orders/${orderId}/start`, { headers: chefH });
  assert.strictEqual(start.status, 200);
  assert.strictEqual(start.json.order.status, 'PREPARING');
  assert.strictEqual(start.json.order.actors.PREPARING, 'chef1');

  // Repeated start rejected.
  assert.strictEqual((await request('PATCH', `/api/kitchen/orders/${orderId}/start`, { headers: chefH })).status, 409);

  assert.strictEqual((await request('PATCH', `/api/kitchen/orders/${orderId}/ready`, { headers: chefH })).status, 200);
  // CHEF cannot pickup.
  assert.strictEqual((await request('PATCH', `/api/kitchen/orders/${orderId}/pickup`, { headers: chefH })).status, 404);

  const pickup = await request('PATCH', `/api/service/orders/${orderId}/pickup`, { headers: waiterH });
  assert.strictEqual(pickup.status, 200);
  assert.strictEqual(pickup.json.order.actors.PICKED_UP, 'waiter1');

  const serve = await request('PATCH', `/api/service/orders/${orderId}/serve`, { headers: waiterH });
  assert.strictEqual(serve.status, 200);
  assert.strictEqual(serve.json.order.status, 'SERVED');

  // Repeated serve rejected.
  assert.strictEqual((await request('PATCH', `/api/service/orders/${orderId}/serve`, { headers: waiterH })).status, 409);
});

test('FIFO: oldest pending first, multiple preparing coexist', async () => {
  const chef = await login('chef1', 'chef-secret');
  const chefH = { Authorization: `Bearer ${chef}` };
  const a = (await placeOrder({ items: [{ id: 'c1', quantity: 1 }] })).json;
  await new Promise(r => setTimeout(r, 5));
  const b = (await placeOrder({ items: [{ id: 'c2', quantity: 1 }] })).json;

  const q1 = await request('GET', '/api/kitchen/queue', { headers: chefH });
  const firstIds = q1.json.queue.map(o => o.orderId);
  assert.ok(firstIds.indexOf(a.orderId) < firstIds.indexOf(b.orderId), 'oldest first');

  // Start both -> both PREPARING coexist.
  await request('PATCH', `/api/kitchen/orders/${a.orderId}/start`, { headers: chefH });
  await request('PATCH', `/api/kitchen/orders/${b.orderId}/start`, { headers: chefH });
  const q2 = await request('GET', '/api/kitchen/queue', { headers: chefH });
  assert.strictEqual(q2.json.preparing.length >= 2, true);
});

test('persistence and restart recovery preserve status and actors', async () => {
  const { orderId } = (await placeOrder()).json;
  const chef = await login('chef1', 'chef-secret');
  await request('PATCH', `/api/kitchen/orders/${orderId}/start`, { headers: { Authorization: `Bearer ${chef}` } });
  await mod._flush(); // wait for async write to disk
  const before = JSON.parse(fs.readFileSync(TEST_ORDERS, 'utf8'));
  const saved = before.find(o => o.orderId === orderId);
  assert.ok(saved, 'order persisted to disk');
  assert.strictEqual(saved.status, 'PREPARING');
  assert.strictEqual(saved.actors.PREPARING, 'chef1', 'actor persisted');
  assert.ok(saved.statusTimestamps.PREPARING, 'timestamp persisted');
  // Simulate restart: reload from disk and confirm status + actor survive.
  const reloaded = mod._reload();
  const after = reloaded.find(o => o.orderId === orderId);
  assert.strictEqual(after.status, 'PREPARING');
  assert.strictEqual(after.actors.PREPARING, 'chef1');
});

test('legacy lowercase pending orders are handled compatibly', async () => {
  const legacy = [{ orderId: 'ORD-legacy', items: [{ id: 'c1', name: 'x', price: 3.5, quantity: 1, prepTime: 5 }],
    totalAmount: 3.5, status: 'pending', createdAt: new Date().toISOString() }];
  fs.writeFileSync(TEST_ORDERS, JSON.stringify(legacy, null, 2));
  const reloaded = mod._reload();
  const legacyOrder = reloaded.find(o => o.orderId === 'ORD-legacy');
  assert.ok(legacyOrder, 'legacy order loaded without data loss');
  assert.strictEqual(legacyOrder.status, 'PENDING', 'legacy lowercase pending normalized to PENDING');
});

test('date-filtered history and top-prepared stats', async () => {
  const chef = await login('chef1', 'chef-secret');
  const chefH = { Authorization: `Bearer ${chef}` };
  const today = new Date().toISOString().slice(0, 10);
  const { orderId } = (await placeOrder({ items: [{ id: 'c2', quantity: 3 }] })).json;
  await request('PATCH', `/api/kitchen/orders/${orderId}/start`, { headers: chefH });

  const hist = await request('GET', `/api/kitchen/history?date=${today}`, { headers: chefH });
  assert.strictEqual(hist.status, 200);
  assert.ok(hist.json.history.some(o => o.orderId === orderId));

  const stats = await request('GET', `/api/stats/top-prepared?date=${today}`, { headers: chefH });
  assert.strictEqual(stats.status, 200);
  const c2 = stats.json.topPrepared.find(i => i.id === 'c2');
  assert.ok(c2 && c2.quantity >= 3);

  // Future date returns empty.
  const future = await request('GET', `/api/kitchen/history?date=2000-01-01`, { headers: chefH });
  assert.strictEqual(future.json.history.length, 0);
});

test('health endpoint reports ok and order count', async () => {
  const r = await request('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, 'ok');
  assert.strictEqual(typeof r.json.orders, 'number');
  assert.ok(r.json.time, 'reports server time');
});

test('CORS preflight and PATCH support', async () => {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/orders', method: 'OPTIONS' }, res => {
      resolve({ status: res.statusCode, methods: res.headers['access-control-allow-methods'], headers: res.headers['access-control-allow-headers'] });
    });
    req.on('error', reject); req.end();
  });
  assert.strictEqual(r.status, 204);
  assert.ok(r.methods.includes('PATCH'));
  assert.ok(r.headers.toLowerCase().includes('x-order-token'));
});
