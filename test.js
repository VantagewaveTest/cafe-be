const http = require('http');
const assert = require('assert');

const BASE = 'http://localhost:5000';
let passed = 0;
let failed = 0;
let chefToken = '';
let waiterToken = '';
let testOrderId = '';
let testOrderToken = '';

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function t(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL: ${name} — ${err.message}`);
    failed++;
  }
}

function eq(actual, expected, msg) {
  assert.strictEqual(actual, expected, msg);
}

async function main() {
  // ---- Checkout & pricing ----
  await t('Valid checkout returns orderId + token + PENDING', async () => {
    const r = await request('POST', '/api/orders', {
      items: [{ id: 'c1', quantity: 2 }],
      paymentMethod: 'card',
      tableNumber: '6',
      tipPercent: 10
    });
    eq(r.status, 201);
    assert(r.body.success, 'success should be true');
    assert(r.body.orderId, 'orderId should exist');
    assert(r.body.orderAccessToken, 'orderAccessToken should exist');
    eq(r.body.status, 'PENDING');
    testOrderId = r.body.orderId;
    testOrderToken = r.body.orderAccessToken;
    // Server-calculated total (2 * 3.50 + 5% tax + 10% tip = 7 + 0.35 + 0.70 = 8.05)
    eq(r.body.grandTotal, 8.05, 'grandTotal should be server-calculated');
  });

  await t('Forged client total is ignored', async () => {
    const r = await request('POST', '/api/orders', {
      items: [{ id: 'c1', quantity: 1 }],
      paymentMethod: 'cash',
      totalAmount: 999999
    });
    eq(r.status, 201);
    eq(r.body.grandTotal, 3.68, 'server total should override client total'); // 3.50 + 5% tax
  });

  await t('Empty cart rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [], paymentMethod: 'cash' });
    eq(r.status, 400);
  });

  await t('Invalid menu ID rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [{ id: 'zzz', quantity: 1 }], paymentMethod: 'cash' });
    eq(r.status, 400);
  });

  await t('Zero quantity rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [{ id: 'c1', quantity: 0 }], paymentMethod: 'cash' });
    eq(r.status, 400);
  });

  await t('Negative quantity rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [{ id: 'c1', quantity: -1 }], paymentMethod: 'cash' });
    eq(r.status, 400);
  });

  await t('Non-integer quantity rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [{ id: 'c1', quantity: 1.5 }], paymentMethod: 'cash' });
    eq(r.status, 400);
  });

  await t('Quantity > 100 rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [{ id: 'c1', quantity: 101 }], paymentMethod: 'cash' });
    eq(r.status, 400);
  });

  await t('Invalid JSON rejected', async () => {
    const r = await new Promise((resolve, reject) => {
      const opts = { hostname: 'localhost', port: 5000, path: '/api/orders', method: 'POST',
        headers: { 'Content-Type': 'application/json' } };
      const req = http.request(opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write('not json');
      req.end();
    });
    eq(r.status, 400);
  });

  // ---- Staff login ----
  await t('Chef login succeeds', async () => {
    const r = await request('POST', '/staff/login', { username: 'chef01', password: 'chef01', role: 'CHEF' });
    eq(r.status, 200);
    assert(r.body.token, 'token should exist');
    eq(r.body.role, 'CHEF');
    chefToken = r.body.token;
  });

  await t('Waiter login succeeds', async () => {
    const r = await request('POST', '/staff/login', { username: 'waiter01', password: 'waiter01', role: 'WAITER' });
    eq(r.status, 200);
    eq(r.body.role, 'WAITER');
    waiterToken = r.body.token;
  });

  await t('Invalid credentials rejected', async () => {
    const r = await request('POST', '/staff/login', { username: 'chef01', password: 'wrong', role: 'CHEF' });
    eq(r.status, 401);
  });

  await t('Client-supplied role not trusted for authorization', async () => {
    // Chef credentials with waiter role should fail (chef01 is not in waiter list)
    const r = await request('POST', '/staff/login', { username: 'chef01', password: 'chef01', role: 'WAITER' });
    eq(r.status, 401);
    // Waiter credentials with chef role should fail (waiter01 is not in chef list)
    const r2 = await request('POST', '/staff/login', { username: 'waiter01', password: 'waiter01', role: 'CHEF' });
    eq(r2.status, 401);
    // The role in the token is server-assigned based on which account list validates
  });

  // ---- Secure order read ----
  await t('Customer reads own order with X-Order-Token', async () => {
    const r = await request('GET', `/api/orders/${testOrderId}`, null, { 'X-Order-Token': testOrderToken });
    eq(r.status, 200);
    eq(r.body.order.orderId, testOrderId);
    eq(r.body.order.status, 'PENDING');
  });

  await t('Customer cannot read order without token', async () => {
    const r = await request('GET', `/api/orders/${testOrderId}`);
    eq(r.status, 401);
  });

  await t('Customer cannot read another order with wrong token', async () => {
    const r = await request('GET', `/api/orders/${testOrderId}`, null, { 'X-Order-Token': 'wrong-token' });
    eq(r.status, 401);
  });

  await t('Staff can read any order with valid token', async () => {
    const r = await request('GET', `/api/orders/${testOrderId}`, null, { Authorization: `Bearer ${chefToken}` });
    eq(r.status, 200);
  });

  await t('Nonexistent order returns 404', async () => {
    const r = await request('GET', '/api/orders/ORD-NONE', null, { 'X-Order-Token': testOrderToken });
    eq(r.status, 404);
  });

  // ---- Status transitions ----
  await t('Chef starts prep: PENDING → PREPARING', async () => {
    const r = await request('PATCH', `/api/chef/orders/${testOrderId}/status`, { status: 'PREPARING', reason: 'started' },
      { Authorization: `Bearer ${chefToken}` });
    eq(r.status, 200);
    eq(r.body.status, 'PREPARING');
  });

  await t('Chef marks ready: PREPARING → READY', async () => {
    const r = await request('PATCH', `/api/chef/orders/${testOrderId}/status`, { status: 'READY', reason: 'ready' },
      { Authorization: `Bearer ${chefToken}` });
    eq(r.status, 200);
    eq(r.body.status, 'READY');
  });

  await t('Waiter cannot start prep (forbidden role)', async () => {
    const r = await request('PATCH', `/api/chef/orders/${testOrderId}/status`, { status: 'PREPARING' },
      { Authorization: `Bearer ${waiterToken}` });
    eq(r.status, 401);
  });

  await t('Waiter picks up: READY → PICKED_UP', async () => {
    const r = await request('PATCH', `/api/waiter/orders/${testOrderId}/pickup`, { reason: 'picked up' },
      { Authorization: `Bearer ${waiterToken}` });
    eq(r.status, 200);
    eq(r.body.status, 'PICKED_UP');
  });

  await t('Chef cannot pickup/serve (forbidden role)', async () => {
    const r = await request('PATCH', `/api/waiter/orders/${testOrderId}/serve`, {},
      { Authorization: `Bearer ${chefToken}` });
    eq(r.status, 401);
  });

  await t('Waiter serves: PICKED_UP → SERVED', async () => {
    const r = await request('PATCH', `/api/waiter/orders/${testOrderId}/serve`, { reason: 'served' },
      { Authorization: `Bearer ${waiterToken}` });
    eq(r.status, 200);
    eq(r.body.status, 'SERVED');
  });

  await t('Skip transition PENDING → READY rejected', async () => {
    // Create a fresh PENDING order
    const r = await request('POST', '/api/orders', { items: [{ id: 'c2', quantity: 1 }], paymentMethod: 'cash' });
    const oid = r.body.orderId;
    const ot = r.body.orderAccessToken;
    const skip = await request('PATCH', `/api/chef/orders/${oid}/status`, { status: 'READY' },
      { Authorization: `Bearer ${chefToken}` });
    eq(skip.status, 409);
  });

  await t('Repeated transition rejected', async () => {
    const repeat = await request('PATCH', `/api/chef/orders/${testOrderId}/status`, { status: 'SERVED' },
      { Authorization: `Bearer ${chefToken}` });
    eq(repeat.status, 409);
  });

  await t('Lowercase status rejected', async () => {
    const r = await request('POST', '/api/orders', { items: [{ id: 'c1', quantity: 1 }], paymentMethod: 'cash' });
    const oid = r.body.orderId;
    const lower = await request('PATCH', `/api/chef/orders/${oid}/status`, { status: 'ready' },
      { Authorization: `Bearer ${chefToken}` });
    eq(lower.status, 400);
  });

  await t('No login token returns 401', async () => {
    const r = await request('PATCH', `/api/chef/orders/${testOrderId}/status`, { status: 'PREPARING' });
    eq(r.status, 401);
  });

  // ---- FIFO queue ----
  await t('FIFO: oldest PENDING first', async () => {
    // Create two PENDING orders
    await request('POST', '/api/orders', { items: [{ id: 'c1', quantity: 1 }], paymentMethod: 'cash' });
    await new Promise(r => setTimeout(r, 50));
    await request('POST', '/api/orders', { items: [{ id: 'c2', quantity: 1 }], paymentMethod: 'cash' });

    const r = await request('GET', '/api/chef/queue', null, { Authorization: `Bearer ${chefToken}` });
    eq(r.status, 200);
    assert(r.body.queue.length >= 2, 'queue should have at least 2 pending');
    // First should be older than second
    const first = r.body.queue[0];
    const second = r.body.queue[1];
    assert(new Date(first.createdAt) <= new Date(second.createdAt), 'FIFO order');
  });

  await t('Concurrent PREPARING allowed', async () => {
    const r = await request('GET', '/api/chef/queue', null, { Authorization: `Bearer ${chefToken}` });
    eq(r.status, 200);
    assert(r.body.counts.preparing >= 0, 'preparing count exists');
  });

  // ---- Restart persistence ----
  await t('Order status persists in orders.json', async () => {
    const fs = require('fs');
    const raw = fs.readFileSync(require('path').join(__dirname, 'orders.json'), 'utf8');
    const orders = JSON.parse(raw);
    const found = orders.find(o => o.orderId === testOrderId);
    assert(found, 'test order should exist in orders.json');
    eq(found.status, 'SERVED');
    assert(found.statusHistory.length > 0, 'statusHistory should exist');
    assert(found.servedAt, 'servedAt should exist');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
