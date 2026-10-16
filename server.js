const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 5000);
const ORDERS_FILE = process.env.ORDERS_FILE || path.join(__dirname, 'orders.json');
const TAX_RATE = 0.05;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 8 * 60 * 60);

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
// Overridable via env for production. Demo defaults below are for local dev only.
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
const staffUsers = parseStaffEnv() || new Map([
  ['chef1', { username: 'chef1', password: 'chef-secret', role: 'CHEF' }],
  ['waiter1', { username: 'waiter1', password: 'waiter-secret', role: 'WAITER' }]
]);

// ---- In-memory sessions (staff tokens) ----
const sessions = new Map(); // token -> { username, role, expiresAt }
function createSession(username, role) {
  const token = 'st_' + crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
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

// ---- Order store with serialized, atomic persistence ----
let orders = [];
function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) { orders = []; return; }
  try {
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Normalize legacy lowercase statuses in-place without losing data.
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
    const tmp = ORDERS_FILE + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('orders.json write failed:', err.message); return resolve(); }
      fs.rename(tmp, ORDERS_FILE, (err2) => {
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
      if (body.length > 1e6) { tooLarge = true; req.destroy(); }
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
  const tax = round2(subtotal * TAX_RATE);
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
  return 'ORD-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex');
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

// ---- Router ----
async function handleRequest(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // GET /api/menu
    if (method === 'GET' && pathname === '/api/menu') {
      return sendJson(res, 200, { success: true, menu: menuItems });
    }

    // POST /api/auth/login
    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendError(res, 400, 'Invalid JSON payload.'); }
      const { username, password } = payload || {};
      if (!username || !password) return sendError(res, 400, 'username and password are required.');
      const user = staffUsers.get(username);
      if (!user || user.password !== password) return sendError(res, 401, 'Invalid credentials.');
      const { token, expiresAt } = createSession(user.username, user.role);
      return sendJson(res, 200, {
        success: true, token, role: user.role, username: user.username,
        expiresIn: Math.round((expiresAt - Date.now()) / 1000)
      });
    }

    // POST /api/orders  (guest checkout)
    if (method === 'POST' && pathname === '/api/orders') {
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

    // GET /api/orders/:orderId  (guest tracking, staff read)
    if (method === 'GET' && pathname.startsWith('/api/orders/')) {
      const id = pathname.slice('/api/orders/'.length);
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
      if (guestToken !== order.trackingToken) return sendError(res, 403, 'Invalid tracking token for this order.');
      return sendJson(res, 200, { success: true, order: orderForGuest(order) });
    }

    // GET /api/kitchen/queue  (CHEF)
    if (method === 'GET' && pathname === '/api/kitchen/queue') {
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

    // PATCH /api/kitchen/orders/:id/start  (CHEF: PENDING -> PREPARING)
    if (method === 'PATCH' && /^\/api\/kitchen\/orders\/[^/]+\/start$/.test(pathname)) {
      const session = requireStaff(req, res, ['CHEF']);
      if (!session) return;
      const id = pathname.split('/')[4];
      return transition(res, id, 'PREPARING', session);
    }

    // PATCH /api/kitchen/orders/:id/ready  (CHEF: PREPARING -> READY)
    if (method === 'PATCH' && /^\/api\/kitchen\/orders\/[^/]+\/ready$/.test(pathname)) {
      const session = requireStaff(req, res, ['CHEF']);
      if (!session) return;
      const id = pathname.split('/')[4];
      return transition(res, id, 'READY', session);
    }

    // GET /api/kitchen/history?date=
    if (method === 'GET' && pathname === '/api/kitchen/history') {
      const session = requireStaff(req, res, ['CHEF']);
      if (!session) return;
      const dateStr = url.searchParams.get('date') || undefined;
      const history = filterByDate(orders, dateStr)
        .filter(o => o.statusTimestamps && o.statusTimestamps.PREPARING)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return sendJson(res, 200, { success: true, date: dateStr || null, history: history.map(orderForStaff) });
    }

    // GET /api/stats/top-prepared?date=
    if (method === 'GET' && pathname === '/api/stats/top-prepared') {
      const session = requireStaff(req, res, ['CHEF']);
      if (!session) return;
      const dateStr = url.searchParams.get('date') || undefined;
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

    // GET /api/service/orders  (WAITER)
    if (method === 'GET' && pathname === '/api/service/orders') {
      const session = requireStaff(req, res, ['WAITER']);
      if (!session) return;
      const relevant = orders.filter(o => ['PREPARING', 'READY', 'PICKED_UP'].includes(o.status))
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const counts = { PREPARING: 0, READY: 0, PICKED_UP: 0 };
      for (const o of relevant) counts[o.status]++;
      return sendJson(res, 200, { success: true, orders: relevant.map(orderForStaff), counts });
    }

    // PATCH /api/service/orders/:id/pickup  (WAITER: READY -> PICKED_UP)
    if (method === 'PATCH' && /^\/api\/service\/orders\/[^/]+\/pickup$/.test(pathname)) {
      const session = requireStaff(req, res, ['WAITER']);
      if (!session) return;
      const id = pathname.split('/')[4];
      return transition(res, id, 'PICKED_UP', session);
    }

    // PATCH /api/service/orders/:id/serve  (WAITER: PICKED_UP -> SERVED)
    if (method === 'PATCH' && /^\/api\/service\/orders\/[^/]+\/serve$/.test(pathname)) {
      const session = requireStaff(req, res, ['WAITER']);
      if (!session) return;
      const id = pathname.split('/')[4];
      return transition(res, id, 'SERVED', session);
    }

    // GET /api/service/history?date=
    if (method === 'GET' && pathname === '/api/service/history') {
      const session = requireStaff(req, res, ['WAITER']);
      if (!session) return;
      const dateStr = url.searchParams.get('date') || undefined;
      const history = filterByDate(orders, dateStr)
        .filter(o => o.statusTimestamps && o.statusTimestamps.SERVED)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return sendJson(res, 200, { success: true, date: dateStr || null, history: history.map(orderForStaff) });
    }

    return sendError(res, 404, 'Not Found');
  } catch (err) {
    console.error('Unhandled error:', err);
    return sendError(res, 500, 'Internal server error.');
  }
}

function transition(res, id, targetStatus, session) {
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
  saveOrders();
  return sendJson(res, 200, { success: true, order: orderForStaff(order) });
}

const server = http.createServer((req, res) => { handleRequest(req, res); });

if (require.main === module) {
  loadOrders();
  server.listen(PORT, () => {
    console.log(`Cafe backend running on http://localhost:${PORT}`);
  });
}

module.exports = {
  server, handleRequest, loadOrders, normalizeStatus,
  // Test hooks: flush pending writes and reload from disk (simulates restart).
  _flush: () => writeChain,
  _reload: () => { loadOrders(); return orders; },
  _state: { sessions }
};
