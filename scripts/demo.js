'use strict';

/**
 * Self-contained demo / evidence script.
 *
 *   node scripts/demo.js
 *
 * Boots the real server (no mocks) on an ephemeral port with a throwaway order
 * store, then walks one guest order through the entire lifecycle and prints a
 * transcript of every request and response — including the security checks.
 *
 * No dependencies: uses the built-in fetch (Node 18+).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.DEMO_PORT || 5091);
const BASE = 'http://localhost:' + PORT + '/api';
const STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-demo-')), 'orders.json');

let checks = 0;
let failures = 0;

function hr() { console.log('-'.repeat(72)); }
function step(title) { console.log(''); hr(); console.log('## ' + title); hr(); }

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log('  PASS  ' + name);
  } else {
    failures += 1;
    console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

async function call(method, url, options) {
  options = options || {};
  const headers = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = 'Bearer ' + options.token;
  if (options.trackingToken) headers['X-Tracking-Token'] = options.trackingToken;

  const res = await fetch(BASE + url, {
    method: method,
    headers: headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch (e) { payload = text; } }

  console.log(method + ' ' + url + '  ->  ' + res.status);
  console.log(JSON.stringify(payload, null, 2));
  hr();
  return { status: res.status, body: payload };
}

async function waitForHealth(child) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error('server exited during startup');
    try {
      const res = await fetch(BASE + '/health');
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server never became healthy');
}

async function main() {
  console.log('Daily Grind Café — live API demo');
  console.log('Node ' + process.version + ' · server on port ' + PORT);
  console.log('Throwaway order store: ' + STORE);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), CAFE_ORDERS_FILE: STORE }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitForHealth(child);

    step('1. Health + menu');
    const health = await call('GET', '/health');
    check('health is ok', health.status === 200 && health.body.status === 'ok');
    const menu = await call('GET', '/menu');
    check('menu has 9 items', menu.status === 200 && menu.body.menu.length === 9,
      'count=' + (menu.body.menu && menu.body.menu.length));

    step('2. Guest checkout — the client sends ids + quantities only');
    const checkout = await call('POST', '/orders', {
      body: {
        items: [{ id: 'c1', quantity: 2 }, { id: 'w1', quantity: 1 }],
        // Deliberately hostile client-priced fields: the server must ignore them.
        totalAmount: 0.01,
        fulfilment: { type: 'DINE_IN', tableNumber: 7 },
        payment: { method: 'card' }
      }
    });
    const orderId = checkout.body.order.orderId;
    const trackingToken = checkout.body.trackingToken;
    // 2 x 3.50 + 1 x 6.00 = 13.00 subtotal, +5% tax = 13.65
    check('order created (201)', checkout.status === 201);
    check('server computed the total (13.65), ignoring the client', checkout.body.order.total === 13.65,
      'total=' + checkout.body.order.total);
    check('status starts PENDING', checkout.body.order.status === 'PENDING');
    check('a tracking token was issued', typeof trackingToken === 'string' && trackingToken.length >= 32);
    check('prep time is summed from the menu (2x5 + 9 = 19s)', checkout.body.order.totalPrepTime === 19,
      'prep=' + checkout.body.order.totalPrepTime);

    step('3. Security — an order id alone is not enough');
    const noToken = await call('GET', '/orders/' + orderId);
    check('no tracking token -> 401', noToken.status === 401, 'got ' + noToken.status);
    const wrongToken = await call('GET', '/orders/' + orderId, { trackingToken: 'not-the-token' });
    check('wrong tracking token -> 403', wrongToken.status === 403, 'got ' + wrongToken.status);
    const track = await call('GET', '/orders/' + orderId, { trackingToken: trackingToken });
    check('correct token -> 200', track.status === 200);
    check('public view never leaks the token', !('trackingToken' in track.body.order));
    check('public view never leaks the actors', !('actors' in track.body.order));

    step('4. Security — roles come from the server, not the client');
    const badLogin = await call('POST', '/auth/login', { body: { username: 'chef', password: 'nope' } });
    check('wrong password -> 401', badLogin.status === 401, 'got ' + badLogin.status);
    const asChef = await call('POST', '/auth/login', { body: { username: 'chef', password: 'chef123' } });
    check('chef login -> role CHEF', asChef.body.role === 'CHEF');
    const chef = asChef.body.token;
    const noAuth = await call('GET', '/kitchen/queue');
    check('no bearer token -> 401', noAuth.status === 401, 'got ' + noAuth.status);
    const wrongRole = await call('GET', '/service/orders', { token: chef });
    check('chef on the waiter API -> 403', wrongRole.status === 403, 'got ' + wrongRole.status);

    step('5. Kitchen (CHEF): PENDING -> PREPARING -> READY');
    const queue = await call('GET', '/kitchen/queue', { token: chef });
    check('FIFO queue holds the order', queue.body.pending.some((o) => o.orderId === orderId));
    const skip = await call('PATCH', '/kitchen/orders/' + orderId + '/ready', { token: chef });
    check('skipping a step -> 409', skip.status === 409, 'got ' + skip.status);
    await call('PATCH', '/kitchen/orders/' + orderId + '/start', { token: chef });
    const ready = await call('PATCH', '/kitchen/orders/' + orderId + '/ready', { token: chef });
    check('ready -> READY', ready.body.order.status === 'READY');
    check('the actor was recorded', ready.body.order.actors.readyBy.username === 'chef');

    step('6. Service (WAITER): READY -> PICKED_UP -> SERVED');
    const asWaiter = await call('POST', '/auth/login', { body: { username: 'waiter', password: 'waiter123' } });
    check('waiter login -> role WAITER', asWaiter.body.role === 'WAITER');
    const waiter = asWaiter.body.token;
    const svc = await call('GET', '/service/orders', { token: waiter });
    check('waiter board shows the READY order', svc.body.ready.some((o) => o.orderId === orderId));
    await call('PATCH', '/service/orders/' + orderId + '/pickup', { token: waiter });
    const served = await call('PATCH', '/service/orders/' + orderId + '/serve', { token: waiter });
    check('serve -> SERVED', served.body.order.status === 'SERVED');
    check('the waiter was recorded', served.body.order.actors.servedBy.role === 'WAITER');

    step('7. The customer tracker now reflects the backend');
    const final = await call('GET', '/orders/' + orderId, { trackingToken: trackingToken });
    check('customer sees SERVED', final.body.order.status === 'SERVED');
    check('every transition has a timestamp', ['createdAt', 'preparingAt', 'readyAt', 'pickedUpAt', 'servedAt']
      .every((k) => typeof final.body.order.timestamps[k] === 'string'));

    step('8. History + statistics');
    const today = new Date().toISOString().slice(0, 10);
    const history = await call('GET', '/kitchen/history?date=' + today, { token: chef });
    check('kitchen history has the order', history.body.orders.some((o) => o.orderId === orderId));
    const top = await call('GET', '/stats/top-prepared?date=' + today, { token: chef });
    const espresso = top.body.items.find((i) => i.id === 'c1');
    check('top-prepared counts 2 espressos', !!espresso && espresso.quantity === 2);
    check('stats report ordersCompleted', top.body.ordersCompleted === 1);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('');
  hr();
  console.log('  RESULT: ' + (checks - failures) + ' / ' + checks + ' checks passed' +
    (failures ? '  (' + failures + ' FAILED)' : ''));
  hr();
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exitCode = 1;
});
