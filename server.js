const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Running as the real server (vs. imported by tests). Used to gate process-level
// concerns (request logging, rate limiting, graceful shutdown) so tests stay fast
// and deterministic.
const IS_MAIN = require.main === module;

// ---- Centralized configuration ----
const config = {
  port: Number(process.env.PORT || 5000),
  ordersFile: process.env.ORDERS_FILE || path.join(__dirname, 'orders.json'),
  taxRate: 0.05,
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 8 * 60 * 60),
  sessionSweepMs: Number(process.env.SESSION_SWEEP_MS || 60 * 1000),
  bodyLimitBytes: Number(process.env.BODY_LIMIT_BYTES || 1e6),
  shutdownGraceMs: Number(process.env.SHUTDOWN_GRACE_MS || 5000),
  loginWindowMs: Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000),
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS || 10),
  logRequests: process.env.LOG_REQUESTS !== 'false'
};

// ---- Trusted server-side menu (single source of truth for pricing) ----
const menuItems = [
  { id: 'c1', name: 'Artisanal Espresso', category: 'Coffees', price: 3.50, prepTime: 5, description: 'Rich, bold single origin espresso shot.', image: '☕' },
  { id: 'c2', name: 'Caramel Macchiato', category: 'Coffees', price: 4.50, prepTime: 7, description: 'Espresso with vanilla, steamed milk, and caramel drizzle.', image: '☕' },
  { id: 'c3', name: 'Iced Cold Brew', category: 'Coffees', price: 4.00, prepTime: 6, description: 'Steeped for 24 hours, smooth and refreshing over ice.', image: '🧋' },
  { id: 'w1', name: 'Belgian Chocolate Waffle', category: 'Waffles', price: 6.00, prepTime: 9, description: 'Crispy golden waffle drizzled with melted Belgian chocolate.', image: '🧇' },
  { id: 'w2', name: 'Berry Blast Waffle', category: 'Waffles', price: 6.50, prepTime: 10, description: 'Topped with fresh strawberries, blueberries, and whipped cream.', image: '🍓' },
  { id: 'k1', name: 'Red Velvet Slice', category: 'Cakes', price: 5.00, prepTime: 6, description: 'Classic red velvet sponge with smooth cream cheese frosting.', image: '🍰' },
  { id: 'k2', name: 'Molten Lava Cake', category: 'Cakes', price: 5.50, prepTime: 8, description: 'Warm chocolate cake with a gooey flowing center.', image: '🍫' },
  { id: 'b1', name: 'Butter Croissant', category: 'Biscuits', price: 3.00, prepTime: 5, description: 'Flaky, buttery French pastry baked golden brown.', image: '🥐' },
  { id: 'b2', name: 'Choco-Chip Cookie', category: 'Biscuits', price: 2.50, prepTime: 5, description: 'Warm, chewy cookie loaded with rich chocolate chunks.', image: '🍪' }
];
const menuById = new Map(menuItems.map(m => [m.id, m]));

// ---- Order lifecycle ----
const STATUSES = ['PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED'];
const NEXT_STATUS = {
  PENDING: 'PREPARING',
  PREPARING: 'READY',
  READY: 'PICKED_UP',
  PICKED_UP: 'SERVED',
  SERVED: null
};
// Legacy lowercase mapping so old saved orders keep working.
const STATUS_ALIASES = { pending: 'PENDING', preparing: 'PREPARING', ready: 'READY', picked_up: 'PICKED_UP', pickedup: 'PICKED_UP', served: 'SERVED' };
function normalizeStatus(s) {
  if (typeof s !== 'string') return 'PENDING';
  const upper = s.toUpperCase();
  if (STATUSES.includes(upper)) return upper;
  const alias = STATUS_ALIASES[s.toLowerCase()];
  return alias || 'PENDING';
}

// ---- Staff credentials (never committed as secrets). ----
function parseStaffEnv() {
  // Format: STAFF_USERS="chef1:secret:CHEF,waiter1:secret:WAITER"
  const raw = process.env.STAFF_USERS;
  if (!raw) return null;
  const map = new Map();
  for (const entry of raw.split(',')) {
    const [username, password, role] = entry.split(':');
    if (username && password && role) {
      map.set(username.trim(), { username: username.trim(), password, role: role.trim().toUpperCase() });
    }
  }
  return map.size ? map : null;
}
const usingDefaultCreds = !process.env.STAFF_USERS;
const staffUsers = parseStaffEnv() || new Map([
  ['chef1', { username: 'chef1', password: 'chef-secret', role: 'CHEF' }],
  ['waiter1', { username: 'waiter1', password: 'waiter-secret', role: 'WAITER' }]
]);

// Constant-time comparison to reduce timing-attack leakage on secrets.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Perform a dummy compare to keep timing roughly uniform, then fail.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// ---- In-memory sessions (staff tokens) ----
const sessions = new Map(); // token -> { username, role, expiresAt }
function createSession(username, role) {
  const token = 'st_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + config.sessionTtlSeconds * 1000;
  sessions.set(token, { username, role, expiresAt });
  return { token, expiresAt };
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}
// Periodically drop expired sessions so the Map doesn't grow unbounded.
function sweepExpiredSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [token, s] of sessions) {
    if (now > s.expiresAt) { sessions.delete(token); removed++; }
  }
  return removed;
}

// ---- Login brute-force protection (only active on the real server) ----
const loginAttempts = new Map(); // key -> { count, resetAt }
function loginRateKey(ip, username) { return `${ip}|${username}`; }
function loginRateLimited(key) {
  if (!IS_MAIN) return false;
  const now = Date.now();
  const e = loginAttempts.get(key);
  if (!e || now > e.resetAt) return false;
  return e.count >= config.loginMaxAttempts;
}
function recordLoginFailure(key) {
  if (!IS_MAIN) return;
  const now = Date.now();
  let e = loginAttempts.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + config.loginWindowMs }; loginAttempts.set(key, e); }
  e.count++;
}
function clearLoginFailures(key) { loginAttempts.delete(key); }
function sweepLoginAttempts() {
  const now = Date.now();
  for (const [k, e] of loginAttempts) if (now > e.resetAt) loginAttempts.delete(k);
}

// ---- Order store with serialized, atomic persistence ----
let orders = [];
function loadOrders() {
  if (!fs.existsSync(config.ordersFile)) { orders = []; return; }
  try {
    const raw = fs.readFileSync(config.ordersFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const o of parsed) {
        o.status = normalizeStatus(o.status);
        if (!o.statusTimestamps) o.statusTimestamps = {};
        if (!o.actors) o.actors = {};
      }
      orders = parsed;
    } else {
      orders = [];
    }
  } catch (err) {
    console.error('Error reading orders.json (starting with empty order list):', err.message);
    orders = [];
  }
}

// Serialize writes so concurrent updates don't silently overwrite each other,
// and write atomically (temp file + rename) to survive partial writes.
let writeChain = Promise.resolve();
function saveOrders() {
  const snapshot = JSON.stringify(orders, null, 2);
  writeChain = writeChain.then(() => new Promise((resolve) => {
    const tmp = config.ordersFile + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('orders.json write failed:', err.message); return resolve(); }
      fs.rename(tmp, config.ordersFile, (err2) => {
        if (err2) console.error('orders.json rename failed:', err2.message);
        resolve();
      });
    });
  }));
  return writeChain;
}

function round2(n) { return Math.round(n * 100) / 100; }
function findOrder(id) { return orders.find(o => o.orderId === id) || null; }

// ---- HTTP helpers ----
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Order-Token');
}
function sendJson(res, status, obj) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function sendError(res, status, message) { sendJson(res, status, { success: false, message }); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > config.bodyLimitBytes) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('Payload too large'));
      resolve(body);
    });
    req.on('error', reject);
  });
}

function getHeader(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---- Auth middleware helpers ----
function requireStaff(req, res, roles) {
  const auth = getHeader(req, 'authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = getSession(token);
  if (!session) { sendError(res, 401, 'Missing or expired staff login.'); return null; }
  if (roles && !roles.includes(session.role)) { sendError(res, 403, 'Insufficient permissions.'); return null; }
  return session;
}

// ---- Order construction ----
function buildOrderFromRequest(payload) {
  const items = payload && payload.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'Cart is empty or invalid items.' };
  }
  let subtotal = 0;
  let totalPrepTime = 0;
  const validated = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string') return { error: 'Invalid item.' };
    const menuItem = menuById.get(it.id);
    if (!menuItem) return { error: `Unknown menu item: ${it.id}` };
    const q = it.quantity;
    if (!Number.isInteger(q) || q <= 0) return { error: `Invalid quantity for ${menuItem.name}. Must be a positive integer.` };
    const line = round2(menuItem.price * q);
    subtotal += line;
    const prep = menuItem.prepTime * q;
    totalPrepTime += prep;
    validated.push({
      id: menuItem.id,
      name: menuItem.name,
      price: menuItem.price,      // server-derived
      quantity: q,
      prepTime: prep,
      lineTotal: line
    });
  }
  subtotal = round2(subtotal);
  const tax = round2(subtotal * config.taxRate);
  const total = round2(subtotal + tax);

  const fulfillment = payload.fulfillment === 'counter' ? 'counter' : 'table';
  const tableNumber = typeof payload.tableNumber === 'string' ? payload.tableNumber.trim() : '';
  if (fulfillment === 'table' && !tableNumber) {
    return { error: 'Table service requires a tableNumber.' };
  }
  const paymentMethod = ['card', 'upi', 'cash'].includes(payload.paymentMethod) ? payload.paymentMethod : 'card';

  return { order: { validated, subtotal, tax, total, totalPrepTime, fulfillment, tableNumber, paymentMethod } };
}

function makeOrderId() {
  // Timestamp + extra entropy avoids collisions when two orders share a ms.
  return 'ORD-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

// ---- Field projection for roles ----
function orderForGuest(o) {
  return {
    orderId: o.orderId,
    status: o.status,
    fulfillment: o.fulfillment,
    tableNumber: o.tableNumber,
    subtotal: o.subtotal,
    tax: o.tax,
    total: o.total,
    paymentMethod: o.paymentMethod,
    paymentStatus: 'SIMULATED',
    items: o.items.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, price: i.price, lineTotal: i.lineTotal })),
    createdAt: o.createdAt,
    estimatedPrepTime: o.totalPrepTime,
    statusTimestamps: o.statusTimestamps,
    actors: o.actors
  };
}
function orderForStaff(o) {
  // Staff view: no guest tracking token exposure.
  return orderForGuest(o);
}

// ---- Date filtering (UTC date string match on createdAt) ----
function sameUtcDate(iso, dateStr) {
  if (!iso) return false;
  return new Date(iso).toISOString().slice(0, 10) === dateStr;
}
function filterByDate(list, dateStr) {
  if (!dateStr) return list;
  return list.filter(o => sameUtcDate(o.createdAt, dateStr));
}

// ---- Route handlers ----
async function handlerHealth(req, res) {
  // Lightweight liveness/readiness probe for monitoring and load balancers.
  sendJson(res, 200, {
    success: true,
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    orders: orders.length,
    activeSessions: sessions.size,
    time: new Date().toISOString()
  });
}

async function handlerMenu(req, res) {
  sendJson(res, 200, { success: true, menu: menuItems });
}

async function handlerLogin(req, res, ctx) {
  const body = await readBody(req);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return sendError(res, 400, 'Invalid JSON payload.'); }
  const { username, password } = payload || {};
  if (!username || !password) return sendError(res, 400, 'username and password are required.');

  const rateKey = loginRateKey(clientIp(req), username);
  if (loginRateLimited(rateKey)) {
    return sendError(res, 429, 'Too many login attempts. Please try again later.');
  }

  const user = staffUsers.get(username);
  if (!user || !safeEqual(user.password, password)) {
    recordLoginFailure(rateKey);
    return sendError(res, 401, 'Invalid credentials.');
  }
  clearLoginFailures(rateKey);
  const { token, expiresAt } = createSession(user.username, user.role);
  return sendJson(res, 200, {
    success: true, token, role: user.role, username: user.username,
    expiresIn: Math.round((expiresAt - Date.now()) / 1000)
  });
}

async function handlerCreateOrder(req, res) {
  const body = await readBody(req);
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return sendError(res, 400, 'Invalid JSON payload.'); }
  const built = buildOrderFromRequest(payload || {});
  if (built.error) return sendError(res, 400, built.error);
  const b = built.order;
  const orderId = makeOrderId();
  const trackingToken = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  const order = {
    orderId,
    trackingToken, // stored, only returned to the owning guest
    items: b.validated,
    subtotal: b.subtotal,
    tax: b.tax,
    total: b.total,
    totalPrepTime: b.totalPrepTime,
    fulfillment: b.fulfillment,
    tableNumber: b.tableNumber,
    paymentMethod: b.paymentMethod,
    paymentStatus: 'SIMULATED',
    status: 'PENDING',
    createdAt: now,
    statusTimestamps: { PENDING: now },
    actors: {}
  };
  orders.push(order);
  await saveOrders();
  return sendJson(res, 201, {
    success: true,
    orderId,
    trackingToken,
    status: order.status,
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    totalPrepTime: order.totalPrepTime,
    message: 'Order placed. Payment is simulated, not charged.'
  });
}

async function handlerGetOrder(req, res, ctx) {
  const id = ctx.params.id;
  const order = findOrder(id);
  if (!order) return sendError(res, 404, 'Order not found.');
  // Staff token grants read; otherwise require matching guest tracking token.
  const auth = getHeader(req, 'authorization') || '';
  const staffToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = getSession(staffToken);
  if (session) {
    return sendJson(res, 200, { success: true, order: orderForStaff(order) });
  }
  const guestToken = getHeader(req, 'x-order-token');
  if (!guestToken) return sendError(res, 401, 'Missing order tracking token.');
  if (!safeEqual(guestToken, order.trackingToken)) return sendError(res, 403, 'Invalid tracking token for this order.');
  return sendJson(res, 200, { success: true, order: orderForGuest(order) });
}

async function handlerKitchenQueue(req, res) {
  const session = requireStaff(req, res, ['CHEF']);
  if (!session) return;
  const pending = orders.filter(o => o.status === 'PENDING').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const preparing = orders.filter(o => o.status === 'PREPARING').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sendJson(res, 200, {
    success: true,
    queue: pending.map(orderForStaff),
    preparing: preparing.map(orderForStaff),
    counts: { PENDING: pending.length, PREPARING: preparing.length }
  });
}

async function handlerKitchenStart(req, res, ctx) {
  const session = requireStaff(req, res, ['CHEF']);
  if (!session) return;
  return transition(res, ctx.params.id, 'PREPARING', session);
}

async function handlerKitchenReady(req, res, ctx) {
  const session = requireStaff(req, res, ['CHEF']);
  if (!session) return;
  return transition(res, ctx.params.id, 'READY', session);
}

async function handlerKitchenHistory(req, res, ctx) {
  const session = requireStaff(req, res, ['CHEF']);
  if (!session) return;
  const dateStr = ctx.url.searchParams.get('date') || undefined;
  const history = filterByDate(orders, dateStr)
    .filter(o => o.statusTimestamps && o.statusTimestamps.PREPARING)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sendJson(res, 200, { success: true, date: dateStr || null, history: history.map(orderForStaff) });
}

async function handlerTopPrepared(req, res, ctx) {
  const session = requireStaff(req, res, ['CHEF']);
  if (!session) return;
  const dateStr = ctx.url.searchParams.get('date') || undefined;
  const scope = filterByDate(orders, dateStr)
    .filter(o => o.statusTimestamps && o.statusTimestamps.PREPARING);
  const totals = new Map();
  for (const o of scope) {
    for (const it of o.items) {
      const cur = totals.get(it.id) || { id: it.id, name: it.name, quantity: 0 };
      cur.quantity += it.quantity;
      totals.set(it.id, cur);
    }
  }
  const topPrepared = [...totals.values()].sort((a, b) => b.quantity - a.quantity);
  return sendJson(res, 200, { success: true, date: dateStr || null, topPrepared });
}

async function handlerServiceOrders(req, res) {
  const session = requireStaff(req, res, ['WAITER']);
  if (!session) return;
  const relevant = orders.filter(o => ['PREPARING', 'READY', 'PICKED_UP'].includes(o.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const counts = { PREPARING: 0, READY: 0, PICKED_UP: 0 };
  for (const o of relevant) counts[o.status]++;
  return sendJson(res, 200, { success: true, orders: relevant.map(orderForStaff), counts });
}

async function handlerServicePickup(req, res, ctx) {
  const session = requireStaff(req, res, ['WAITER']);
  if (!session) return;
  return transition(res, ctx.params.id, 'PICKED_UP', session);
}

async function handlerServiceServe(req, res, ctx) {
  const session = requireStaff(req, res, ['WAITER']);
  if (!session) return;
  return transition(res, ctx.params.id, 'SERVED', session);
}

async function handlerServiceHistory(req, res, ctx) {
  const session = requireStaff(req, res, ['WAITER']);
  if (!session) return;
  const dateStr = ctx.url.searchParams.get('date') || undefined;
  const history = filterByDate(orders, dateStr)
    .filter(o => o.statusTimestamps && o.statusTimestamps.SERVED)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sendJson(res, 200, { success: true, date: dateStr || null, history: history.map(orderForStaff) });
}

// ---- Route table ----
const routes = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: handlerHealth },
  { method: 'GET', pattern: /^\/api\/menu$/, handler: handlerMenu },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, handler: handlerLogin },
  { method: 'POST', pattern: /^\/api\/orders$/, handler: handlerCreateOrder },
  { method: 'GET', pattern: /^\/api\/orders\/([^/]+)$/, handler: handlerGetOrder, param: 'id' },
  { method: 'GET', pattern: /^\/api\/kitchen\/queue$/, handler: handlerKitchenQueue },
  { method: 'PATCH', pattern: /^\/api\/kitchen\/orders\/([^/]+)\/start$/, handler: handlerKitchenStart, param: 'id' },
  { method: 'PATCH', pattern: /^\/api\/kitchen\/orders\/([^/]+)\/ready$/, handler: handlerKitchenReady, param: 'id' },
  { method: 'GET', pattern: /^\/api\/kitchen\/history$/, handler: handlerKitchenHistory },
  { method: 'GET', pattern: /^\/api\/stats\/top-prepared$/, handler: handlerTopPrepared },
  { method: 'GET', pattern: /^\/api\/service\/orders$/, handler: handlerServiceOrders },
  { method: 'PATCH', pattern: /^\/api\/service\/orders\/([^/]+)\/pickup$/, handler: handlerServicePickup, param: 'id' },
  { method: 'PATCH', pattern: /^\/api\/service\/orders\/([^/]+)\/serve$/, handler: handlerServiceServe, param: 'id' },
  { method: 'GET', pattern: /^\/api\/service\/history$/, handler: handlerServiceHistory }
];

// ---- Status transition (durable: persists before responding) ----
async function transition(res, id, targetStatus, session) {
  const order = findOrder(id);
  if (!order) return sendError(res, 404, 'Order not found.');
  const expected = NEXT_STATUS[order.status];
  if (expected !== targetStatus) {
    return sendError(res, 409, `Cannot move ${order.status} to ${targetStatus}.`);
  }
  const now = new Date().toISOString();
  order.status = targetStatus;
  order.statusTimestamps[targetStatus] = now;
  order.actors[targetStatus] = session.username;
  await saveOrders(); // persist before responding so a crash can't lose it
  return sendJson(res, 200, { success: true, order: orderForStaff(order) });
}

// ---- Router ----
async function handleRequest(req, res) {
  setCors(res);
  const start = process.hrtime.bigint();
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    if (IS_MAIN && config.logRequests) logRequest(req, res, start, requestId);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.pattern);
      if (!m) continue;
      const ctx = { url, params: {} };
      if (r.param) ctx.params[r.param] = decodeURIComponent(m[1]);
      await r.handler(req, res, ctx);
      if (IS_MAIN && config.logRequests) logRequest(req, res, start, requestId);
      return;
    }
    sendError(res, 404, 'Not Found');
  } catch (err) {
    console.error(`[${requestId}] Unhandled error:`, err);
    if (!res.headersSent) sendError(res, 500, 'Internal server error.');
  }
  if (IS_MAIN && config.logRequests) logRequest(req, res, start, requestId);
}

function logRequest(req, res, start, requestId) {
  const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`[${requestId}] ${req.method} ${req.url} -> ${res.statusCode} (${durationMs.toFixed(1)}ms)`);
}

// ---- Graceful shutdown ----
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received. Flushing pending writes and shutting down...`);
  if (sessionSweeper) clearInterval(sessionSweeper);
  if (attemptSweeper) clearInterval(attemptSweeper);
  server.close(async () => {
    try { await writeChain; } catch (e) { /* best-effort flush */ }
    console.log('Shutdown complete.');
    process.exit(0);
  });
  // Force exit if connections don't close in time.
  setTimeout(() => { console.log('Forcing shutdown after grace period.'); process.exit(0); }, config.shutdownGraceMs).unref();
}

const server = http.createServer((req, res) => { handleRequest(req, res); });

// Background sweepers (created here, cleared on shutdown).
const sessionSweeper = setInterval(sweepExpiredSessions, config.sessionSweepMs);
sessionSweeper.unref();
const attemptSweeper = setInterval(sweepLoginAttempts, config.loginWindowMs);
attemptSweeper.unref();

if (IS_MAIN) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  loadOrders();
  if (usingDefaultCreds) {
    console.warn('WARNING: Using default demo staff credentials. Set STAFF_USERS before running in production.');
  }
  server.listen(config.port, () => {
    console.log(`Cafe backend running on http://localhost:${config.port}`);
    console.log(`Health check: http://localhost:${config.port}/api/health`);
  });
}

module.exports = {
  server, handleRequest, loadOrders, normalizeStatus,
  // Test hooks: flush pending writes and reload from disk (simulates restart).
  _flush: () => writeChain,
  _reload: () => { loadOrders(); return orders; },
  _state: { sessions },
  _config: config
};
