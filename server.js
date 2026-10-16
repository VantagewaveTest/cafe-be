'use strict';

const http = require('http');

const { HttpError } = require('./errors');
const menu = require('./menu');
const auth = require('./auth');
const orders = require('./orders');

const PORT = Number(process.env.PORT || 5000);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY_BYTES = 1000000;

/* ------------------------------------------------------------------ *
 * Tiny router
 * ------------------------------------------------------------------ */

const routes = [];

function route(method, pattern, handler, options) {
  routes.push({
    method,
    pattern,
    handler,
    roles: (options && options.roles) || null
  });
}

function normalizePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function matchPattern(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;

  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].charAt(0) === ':') {
      try {
        params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
      } catch (err) {
        throw new HttpError(400, 'That request path was not valid.', 'VALIDATION_ERROR');
      }
    } else if (expected[i] !== actual[i]) {
      return null;
    }
  }
  return params;
}

function findRoute(method, pathname) {
  for (let i = 0; i < routes.length; i += 1) {
    if (routes[i].method !== method) continue;
    const params = matchPattern(routes[i].pattern, pathname);
    if (params) return { route: routes[i], params };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Request plumbing
 * ------------------------------------------------------------------ */

function setCors(res) {
  // Deliberate local-only config: the frontend runs on a different port.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tracking-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function sendError(res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    send(res, err.status, { success: false, message: err.message, code: err.code });
    return;
  }
  console.error('[cafe-be] unexpected error:', err);
  send(res, 500, {
    success: false,
    message: 'Something went wrong on the café server.',
    code: 'INTERNAL_ERROR'
  });
}

function bearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        reject(new HttpError(400, 'That request body was too large.', 'VALIDATION_ERROR'));
      }
    });

    req.on('end', () => {
      if (aborted) return;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new HttpError(400, 'That request body was not valid JSON.', 'VALIDATION_ERROR'));
      }
    });

    req.on('error', reject);
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function dateParam(query) {
  const raw = query.get('date');
  if (raw === null || raw === '') return todayUtc();
  if (!DATE_RE.test(raw)) {
    throw new HttpError(400, 'The date filter must be formatted YYYY-MM-DD.', 'VALIDATION_ERROR');
  }
  return raw;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

route('GET', '/api/health', () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

route('GET', '/api/menu', () => ({ menu: menu.getMenu() }));

route('POST', '/api/auth/login', (ctx) => {
  const session = auth.login(ctx.body.username, ctx.body.password);
  return {
    token: session.token,
    role: session.role,
    username: session.username,
    displayName: session.displayName,
    expiresAt: session.expiresAt
  };
});

route('POST', '/api/auth/logout', (ctx) => {
  auth.logout(ctx.session.token);
  return { message: 'Signed out.' };
}, { roles: ['CHEF', 'WAITER'] });

route('POST', '/api/orders', (ctx) => {
  const order = orders.createOrder(ctx.body);
  ctx.status = 201;
  return { order: orders.publicView(order), trackingToken: order.trackingToken };
});

route('GET', '/api/orders/:orderId', (ctx) => {
  const order = orders.findById(ctx.params.orderId);
  if (!order) throw new HttpError(404, 'No order with that id.', 'NOT_FOUND');

  const token = ctx.req.headers['x-tracking-token'];
  if (!token) {
    throw new HttpError(401, 'A tracking token is required to read this order.', 'UNAUTHENTICATED');
  }
  if (!order.trackingToken || !auth.safeEqual(String(token), order.trackingToken)) {
    throw new HttpError(403, 'That tracking token does not match this order.', 'FORBIDDEN');
  }

  return { order: orders.publicView(order) };
});

/* --- kitchen (CHEF only) --- */

function transitionRoute(action) {
  return (ctx) => {
    const order = orders.transitionOrder(ctx.params.id, action, ctx.session);
    return { order: orders.staffView(order) };
  };
}

route('GET', '/api/kitchen/queue', () => {
  const queue = orders.kitchenQueue();
  return {
    pending: queue.pending.map(orders.staffView),
    preparing: queue.preparing.map(orders.staffView),
    counts: queue.counts
  };
}, { roles: ['CHEF'] });

route('PATCH', '/api/kitchen/orders/:id/start', transitionRoute('start'), { roles: ['CHEF'] });
route('PATCH', '/api/kitchen/orders/:id/ready', transitionRoute('ready'), { roles: ['CHEF'] });

route('GET', '/api/kitchen/history', (ctx) => {
  const date = dateParam(ctx.query);
  return { date, orders: orders.kitchenHistory(date).map(orders.staffView) };
}, { roles: ['CHEF'] });

route('GET', '/api/stats/top-prepared', (ctx) => {
  const date = dateParam(ctx.query);
  const stats = orders.topPrepared(date);
  return { date, items: stats.items, ordersCompleted: stats.ordersCompleted };
}, { roles: ['CHEF'] });

/* --- service (WAITER only) --- */

route('GET', '/api/service/orders', () => {
  const board = orders.serviceOrders();
  return {
    preparing: board.preparing.map(orders.staffView),
    ready: board.ready.map(orders.staffView),
    pickedUp: board.pickedUp.map(orders.staffView),
    counts: board.counts
  };
}, { roles: ['WAITER'] });

route('PATCH', '/api/service/orders/:id/pickup', transitionRoute('pickup'), { roles: ['WAITER'] });
route('PATCH', '/api/service/orders/:id/serve', transitionRoute('serve'), { roles: ['WAITER'] });

route('GET', '/api/service/history', (ctx) => {
  const date = dateParam(ctx.query);
  return { date, orders: orders.serviceHistory(date).map(orders.staffView) };
}, { roles: ['WAITER'] });

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

async function handle(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    throw new HttpError(400, 'That request URL was not valid.', 'VALIDATION_ERROR');
  }

  const pathname = normalizePath(url.pathname);
  const match = findRoute(req.method, pathname);
  if (!match) {
    throw new HttpError(404, 'No such endpoint: ' + req.method + ' ' + pathname, 'NOT_FOUND');
  }

  const ctx = {
    req,
    res,
    params: match.params,
    query: url.searchParams,
    body: {},
    session: null,
    status: 200
  };

  // Roles are re-derived from the session on every protected request.
  if (match.route.roles) {
    ctx.session = auth.authenticate(bearer(req));
    if (match.route.roles.indexOf(ctx.session.role) === -1) {
      throw new HttpError(403, 'This action needs the ' + match.route.roles.join(' or ') + ' role.', 'FORBIDDEN');
    }
  }

  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    ctx.body = await readJsonBody(req);
  }

  const payload = await match.route.handler(ctx);
  send(res, ctx.status, Object.assign({ success: true }, payload || {}));
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendError(res, err);
      } catch (sendErr) {
        // The socket is already gone; nothing useful left to do.
      }
    });
  });
}

function start(port) {
  const server = createServer();
  server.listen(port === undefined ? PORT : port, () => {
    const address = server.address();
    const actual = address && typeof address === 'object' ? address.port : port;
    console.log('Cafe backend running on http://localhost:' + actual);
  });
  return server;
}

module.exports = { createServer, start, routes };

if (require.main === module) {
  start();
}
