'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Point the order store at a throwaway file. Must run *before* `../server` is
 * required, because `orders.js` reads the env var at module load.
 */
function useTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cafe-test-'));
  const file = path.join(dir, 'orders.json');
  process.env.CAFE_ORDERS_FILE = file;
  return file;
}

/** Drop every cached café module so the next startServer() reads from disk. */
function purgeCafeModules() {
  const root = path.resolve(__dirname, '..');
  Object.keys(require.cache).forEach((key) => {
    if (key.startsWith(root) && key.indexOf('node_modules') === -1) {
      delete require.cache[key];
    }
  });
}

/** Start the real server on an ephemeral port. */
async function startServer() {
  const { createServer } = require('../server');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: 'http://127.0.0.1:' + port + '/api',
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Minimal fetch wrapper returning { status, body }. */
async function request(base, method, url, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers);
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.trackingToken) headers['X-Tracking-Token'] = opts.trackingToken;

  const res = await fetch(base + url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (err) { body = text; }
  }
  return { status: res.status, body };
}

async function login(base, username, password) {
  const res = await request(base, 'POST', '/auth/login', { body: { username, password } });
  if (res.status !== 200) {
    throw new Error('login failed for ' + username + ': ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res.body;
}

/** Place an order and return { order, trackingToken }. */
async function placeOrder(base, items, extra) {
  const payload = Object.assign(
    { items, fulfilment: { type: 'PICKUP' }, payment: { method: 'card' } },
    extra || {}
  );
  const res = await request(base, 'POST', '/orders', { body: payload });
  if (res.status !== 201) {
    throw new Error('order failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return { order: res.body.order, trackingToken: res.body.trackingToken };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  useTempStore,
  purgeCafeModules,
  startServer,
  request,
  login,
  placeOrder,
  sleep
};
