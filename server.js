const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 5000);
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Canonical status lifecycle: PENDING → PREPARING → READY → PICKED_UP → SERVED
const STATUS_ORDER = ['PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED'];
const VALID_TRANSITIONS = {
  PENDING: new Set(['PREPARING']),
  PREPARING: new Set(['READY']),
  READY: new Set(['PICKED_UP']),
  PICKED_UP: new Set(['SERVED']),
  SERVED: new Set()
};

// ---- Staff accounts (server-side only) ----
// Configure via CHEF_ACCOUNTS and WAITER_ACCOUNTS env vars (JSON arrays of {username, password}).
// Dev fallback only when NODE_ENV is not 'production'.
function parseAccounts(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map(e => ({ username: String((e && e.username) || '').trim(), password: String((e && e.password) || '') }))
      .filter(c => c.username && c.password);
  } catch (_) { return null; }
}

const ENV_CHEF = parseAccounts(process.env.CHEF_ACCOUNTS);
const ENV_WAITER = parseAccounts(process.env.WAITER_ACCOUNTS);
const IS_DEV = process.env.NODE_ENV !== 'production';

const CHEF_ACCOUNTS = ENV_CHEF || (IS_DEV ? [
  { username: 'chef01', password: 'chef01' },
  { username: 'chef02', password: 'chef02' }
] : []);

const WAITER_ACCOUNTS = ENV_WAITER || (IS_DEV ? [
  { username: 'waiter01', password: 'waiter01' },
  { username: 'waiter02', password: 'waiter02' }
] : []);

const TOKEN_SECRET = process.env.TOKEN_SECRET || (IS_DEV ? 'cafe-demo-secret-change-me' : '');
const TOKEN_TTL_MS = 60 * 60 * 1000;

if (!IS_DEV) {
  const unsafe = (!CHEF_ACCOUNTS.length || !WAITER_ACCOUNTS.length || !TOKEN_SECRET || TOKEN_SECRET === 'cafe-demo-secret-change-me');
  if (unsafe) {
    console.error('Refusing to start: set CHEF_ACCOUNTS, WAITER_ACCOUNTS and TOKEN_SECRET for production.');
    process.exit(1);
  }
}

function findAccount(username, role) {
  const list = role === 'CHEF' ? CHEF_ACCOUNTS : WAITER_ACCOUNTS;
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return list.find(c => c.username.toLowerCase() === u) || null;
}

function authenticateAccount(username, password, role) {
  const acc = findAccount(username, role);
  if (!acc) return null;
  return acc.password === String(password) ? acc : null;
}

// ---- Token helpers (HMAC, server-assigned role only) ----
function signToken(username, role) {
  const payload = { user: String(username || '').trim(), role, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch (_) { return null; }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.user || !payload.role || Number(payload.exp) <= Date.now()) return null;
    if (!findAccount(payload.user, payload.role)) return null;
    return payload;
  } catch (_) { return null; }
}

function getBearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function requireAuth(allowedRoles) {
  return (req) => {
    const token = verifyToken(getBearer(req));
    if (!token) return null;
    if (!allowedRoles.includes(token.role)) return null;
    return token;
  };
}

// ---- Menu ----
const MENU = [
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

function findMenu(id) { return MENU.find(item => item.id === id); }

// ---- Orders persistence (atomic with write lock) ----
let orders = [];
const idempotencyIndex = new Map();
let writeLock = false;

function loadJsonSafe(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (err) {
    console.error('Reading failed:', file, err.message);
  }
  return Array.isArray(fallback) ? fallback : [];
}

function saveJsonAtomic(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function persistOrders() {
  if (writeLock) return;
  writeLock = true;
  try {
    saveJsonAtomic(ORDERS_FILE, orders);
  } finally {
    writeLock = false;
  }
}

function migrateLegacyStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  const map = {
    placed: 'PENDING',
    pending: 'PENDING',
    preparing: 'PREPARING',
    ready: 'READY',
    delivered: 'SERVED'
  };
  return map[s] || status || 'PENDING';
}

function loadOrders() {
  const raw = loadJsonSafe(ORDERS_FILE, []);
  orders = (Array.isArray(raw) ? raw : []).map(o => ({
    ...o,
    status: migrateLegacyStatus(o.status)
  }));
  orders.forEach(o => {
    if (o.idempotencyKey) idempotencyIndex.set(o.idempotencyKey, o.orderId);
  });
}

loadOrders();

// ---- Helpers ----
function nowIso() { return new Date().toISOString(); }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function makeId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function decimal(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
function clamp(n, min, max) { return Math.max(min, Math.max(min, Math.min(max, n))); }

// ---- Server-calculated billing (ignores client totals) ----
function calculateBill(input) {
  if (!input || !Array.isArray(input.items) || !input.items.length) {
    return { error: 'Cart is empty or invalid.' };
  }
  if (input.items.length > 100) return { error: 'Too many line items.' };

  const lines = [];
  let subtotal = 0;
  let prep = 0;

  for (const item of input.items) {
    const menu = findMenu(item.id);
    if (!menu) return { error: `Unknown menu item: ${item.id}.` };
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return { error: `Invalid quantity for ${item.id}.` };
    }
    const lineTotal = round2(menu.price * quantity);
    subtotal = round2(subtotal + lineTotal);
    prep += menu.prepTime * quantity;
    lines.push({
      id: menu.id,
      name: menu.name,
      category: menu.category,
      price: menu.price,
      quantity,
      prepTime: menu.prepTime,
      lineTotal
    });
  }

  const tipPercent = clamp(decimal(input.tipPercent), 0, 100);
  const tipAmount = round2(subtotal * (tipPercent / 100));
  // Simple tax consistent with frontend (5% flat on subtotal)
  const taxAmount = round2(subtotal * 0.05);
  const grandTotal = round2(subtotal + taxAmount + tipAmount);
  const totalPrepTime = prep;

  return {
    valid: true,
    lineItems: lines,
    subtotal,
    taxAmount,
    tipAmount,
    tipPercent,
    grandTotal,
    totalPrepTime
  };
}

// ---- Order-specific access token ----
function generateOrderAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// ---- Status transition helpers ----
function appendStatusHistory(order, fromStatus, toStatus, actor, reason) {
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({
    from: fromStatus,
    to: toStatus,
    actor,
    reason: reason || 'status change',
    at: nowIso()
  });
  order.status = toStatus;
  const stamp = nowIso();
  if (toStatus === 'PREPARING') order.preparingAt = stamp;
  if (toStatus === 'READY') order.readyAt = stamp;
  if (toStatus === 'PICKED_UP') order.pickedUpAt = stamp;
  if (toStatus === 'SERVED') order.servedAt = stamp;
}

// ---- API response helpers ----
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Order-Token');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (_) { reject(new Error('Invalid JSON payload.')); }
    });
    req.on('error', reject);
  });
}

// ---- Role-scoped order DTO ----
function toPublicOrder(order, viewerRole, hasOrderToken) {
  const base = {
    orderId: order.orderId,
    status: order.status,
    items: (order.items || []).map(i => ({ id: i.id, name: i.name, quantity: i.quantity, price: i.price })),
    totalAmount: order.totalAmount || 0,
    tableNumber: order.tableNumber || '',
    createdAt: order.createdAt,
    statusHistory: order.statusHistory || []
  };
  if (viewerRole === 'CHEF' || viewerRole === 'WAITER') {
    base.preparingAt = order.preparingAt;
    base.readyAt = order.readyAt;
    base.pickedUpAt = order.pickedUpAt;
    base.servedAt = order.servedAt;
    base.totalPrepTime = order.totalPrepTime;
  }
  return base;
}

// ---- Request router ----
function route(req, res) {
  if (sendCors(req, res)) return true;

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ---- GET /api/menu ----
  if (req.method === 'GET' && url.pathname === '/api/menu') {
    return sendJson(res, 200, { success: true, menu: MENU });
  }

  // ---- POST /staff/login (also /api/staff/login for frontend API_BASE compatibility) ----
  const isStaffLogin = req.method === 'POST' && (url.pathname === '/staff/login' || url.pathname === '/api/staff/login');
  if (isStaffLogin) {
    readBody(req).then(body => {
      const { username, password, role: clientRole } = body;
      if (!username || !password) {
        return sendJson(res, 400, { success: false, message: 'Username and password are required.' });
      }

      // Auto-detect role: check which account list the username exists in
      // (role is server-verified, never trusted from client)
      let detectedRole = null;
      if (authenticateAccount(username, password, 'CHEF')) {
        detectedRole = 'CHEF';
      } else if (authenticateAccount(username, password, 'WAITER')) {
        detectedRole = 'WAITER';
      }

      if (!detectedRole) {
        return sendJson(res, 401, { success: false, message: 'Invalid credentials.' });
      }

      const token = signToken(username, detectedRole);
      return sendJson(res, 200, {
        success: true,
        token,
        role: detectedRole,
        username,
        expiresInMs: TOKEN_TTL_MS
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  // ---- POST /api/orders (guest checkout) ----
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    readBody(req).then(body => {
      const bill = calculateBill(body);
      if (bill.error) {
        return sendJson(res, 400, { success: false, message: bill.error });
      }

      const idKey = String(body.idempotencyKey || '').trim().slice(0, 100);
      if (idKey && idempotencyIndex.has(idKey)) {
        const existing = orders.find(o => o.orderId === idempotencyIndex.get(idKey));
        if (existing) {
          return sendJson(res, 200, {
            success: true,
            orderId: existing.orderId,
            orderAccessToken: existing.orderAccessToken,
            grandTotal: existing.grandTotal,
            status: existing.status,
            idempotent: true
          });
        }
      }

      // Server-calculated totals; ignore client-supplied price/total
      const orderId = 'ORD-' + makeId('');
      const orderAccessToken = generateOrderAccessToken();
      const order = {
        orderId,
        orderAccessToken,
        items: bill.lineItems,
        subtotal: bill.subtotal,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        grandTotal: bill.grandTotal,
        totalPrepTime: bill.totalPrepTime,
        tableNumber: String(body.tableNumber || '').trim(),
        paymentMethod: String(body.paymentMethod || 'simulated'),
        status: 'PENDING',
        createdAt: nowIso(),
        statusHistory: [{ from: null, to: 'PENDING', actor: 'customer', reason: 'order submitted', at: nowIso() }]
      };

      if (idKey) idempotencyIndex.set(idKey, orderId);
      orders.push(order);
      persistOrders();

      return sendJson(res, 201, {
        success: true,
        message: 'Order placed successfully (payment simulated).',
        orderId,
        orderAccessToken,
        grandTotal: order.grandTotal,
        status: order.status,
        totalPrepTime: order.totalPrepTime
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  // ---- GET /api/orders/:id (secure, order-specific) ----
  const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === 'GET' && orderMatch) {
    const orderId = decodeURIComponent(orderMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) {
      return sendJson(res, 404, { success: false, message: 'Order not found.' });
    }

    const staff = requireAuth(['CHEF', 'WAITER'])(req);
    const orderToken = String(req.headers['x-order-token'] || '').trim();

    if (staff) {
      return sendJson(res, 200, {
        success: true,
        order: toPublicOrder(order, staff.role, false)
      });
    }

    if (orderToken && orderToken === order.orderAccessToken) {
      return sendJson(res, 200, {
        success: true,
        order: toPublicOrder(order, null, true)
      });
    }

    return sendJson(res, 401, { success: false, message: 'Invalid or missing order access token.' });
  }

  // ---- PATCH /api/chef/orders/:id/status (CHEF only) ----
  const chefStatusMatch = url.pathname.match(/^\/api\/chef\/orders\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && chefStatusMatch) {
    const staff = requireAuth(['CHEF'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: CHEF role required.' });
    }

    const orderId = decodeURIComponent(chefStatusMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) {
      return sendJson(res, 404, { success: false, message: 'Order not found.' });
    }

    readBody(req).then(body => {
      const { status: nextStatus, reason } = body;
      if (!nextStatus || typeof nextStatus !== 'string' || !STATUS_ORDER.includes(nextStatus)) {
        return sendJson(res, 400, { success: false, message: `Invalid status: '${nextStatus || 'undefined'}'. Must be one of ${STATUS_ORDER.join(', ')}.` });
      }
      if (!VALID_TRANSITIONS[order.status] || !VALID_TRANSITIONS[order.status].has(nextStatus)) {
        return sendJson(res, 409, { success: false, message: `Cannot move '${order.status}' → '${nextStatus}'.` });
      }
      if (order.status === nextStatus) {
        return sendJson(res, 200, { success: true, message: `Already ${nextStatus}.`, status: order.status });
      }

      appendStatusHistory(order, order.status, nextStatus, staff.username, reason || 'chef action');
      persistOrders();
      return sendJson(res, 200, {
        success: true,
        message: `Order moved to ${nextStatus}.`,
        status: order.status,
        previousStatus: order.statusHistory.length > 1 ? order.statusHistory[order.statusHistory.length - 2].to : order.status
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  // ---- PATCH /api/waiter/orders/:id/pickup (WAITER only) ----
  const waiterPickupMatch = url.pathname.match(/^\/api\/waiter\/orders\/([^/]+)\/pickup$/);
  if (req.method === 'PATCH' && waiterPickupMatch) {
    const staff = requireAuth(['WAITER'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: WAITER role required.' });
    }

    const orderId = decodeURIComponent(waiterPickupMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) {
      return sendJson(res, 404, { success: false, message: 'Order not found.' });
    }

    readBody(req).then(body => {
      const { reason } = body;
      if (!STATUS_ORDER.includes('PICKED_UP')) {
        return sendJson(res, 400, { success: false, message: 'Invalid status.' });
      }
      if (!VALID_TRANSITIONS[order.status] || !VALID_TRANSITIONS[order.status].has('PICKED_UP')) {
        return sendJson(res, 409, { success: false, message: `Cannot move '${order.status}' → 'PICKED_UP'.` });
      }
      appendStatusHistory(order, order.status, 'PICKED_UP', staff.username, reason || 'waiter action');
      persistOrders();
      return sendJson(res, 200, {
        success: true,
        message: 'Order marked PICKED_UP.',
        status: order.status
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  // ---- PATCH /api/waiter/orders/:id/serve (WAITER only) ----
  const waiterServeMatch = url.pathname.match(/^\/api\/waiter\/orders\/([^/]+)\/serve$/);
  if (req.method === 'PATCH' && waiterServeMatch) {
    const staff = requireAuth(['WAITER'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: WAITER role required.' });
    }

    const orderId = decodeURIComponent(waiterServeMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) {
      return sendJson(res, 404, { success: false, message: 'Order not found.' });
    }

    readBody(req).then(body => {
      const { reason } = body;
      if (!VALID_TRANSITIONS[order.status] || !VALID_TRANSITIONS[order.status].has('SERVED')) {
        return sendJson(res, 409, { success: false, message: `Cannot move '${order.status}' → 'SERVED'.` });
      }
      appendStatusHistory(order, order.status, 'SERVED', staff.username, reason || 'waiter action');
      persistOrders();
      return sendJson(res, 200, {
        success: true,
        message: 'Order marked SERVED.',
        status: order.status
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  // ---- GET /api/chef/queue (CHEF only) ----
  if (req.method === 'GET' && url.pathname === '/api/chef/queue') {
    const staff = requireAuth(['CHEF'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: CHEF role required.' });
    }

    const pending = orders.filter(o => o.status === 'PENDING')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const preparing = orders.filter(o => o.status === 'PREPARING');
    const ready = orders.filter(o => o.status === 'READY');

    return sendJson(res, 200, {
      success: true,
      queue: pending.map(o => toPublicOrder(o, 'CHEF', false)),
      preparing: preparing.map(o => toPublicOrder(o, 'CHEF', false)),
      ready: ready.map(o => toPublicOrder(o, 'CHEF', false)),
      counts: { pending: pending.length, preparing: preparing.length, ready: ready.length }
    });
  }

  // ---- GET /api/waiter/orders (WAITER only) ----
  if (req.method === 'GET' && url.pathname === '/api/waiter/orders') {
    const staff = requireAuth(['WAITER'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: WAITER role required.' });
    }

    const preparing = orders.filter(o => o.status === 'PREPARING');
    const ready = orders.filter(o => o.status === 'READY');

    return sendJson(res, 200, {
      success: true,
      preparing: preparing.map(o => toPublicOrder(o, 'WAITER', false)),
      ready: ready.map(o => toPublicOrder(o, 'WAITER', false)),
      counts: { preparing: preparing.length, ready: ready.length }
    });
  }

  // ---- GET /api/chef/history?date= (CHEF only) ----
  if (req.method === 'GET' && url.pathname === '/api/chef/history') {
    const staff = requireAuth(['CHEF'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: CHEF role required.' });
    }

    const { date } = url.searchParams;
    let filtered = orders;
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      filtered = orders.filter(o => {
        const created = new Date(o.createdAt);
        return created >= d && created < next;
      });
    }

    return sendJson(res, 200, {
      success: true,
      history: filtered.map(o => toPublicOrder(o, 'CHEF', false)).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      )
    });
  }

  // ---- GET /api/waiter/history?date= (WAITER only) ----
  if (req.method === 'GET' && url.pathname === '/api/waiter/history') {
    const staff = requireAuth(['WAITER'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: WAITER role required.' });
    }

    const { date } = url.searchParams;
    let filtered = orders;
    if (date) {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      const next = new Date(d);
      next.setDate(next.getDate() + 1);
      filtered = orders.filter(o => {
        const created = new Date(o.createdAt);
        return created >= d && created < next;
      });
    }

    return sendJson(res, 200, {
      success: true,
      history: filtered.map(o => toPublicOrder(o, 'WAITER', false)).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      )
    });
  }

  // ---- GET /api/chef/top-items (CHEF only) ----
  if (req.method === 'GET' && url.pathname === '/api/chef/top-items') {
    const staff = requireAuth(['CHEF'])(req);
    if (!staff) {
      return sendJson(res, 401, { success: false, message: 'Unauthorized: CHEF role required.' });
    }

    const itemCounts = {};
    orders.forEach(o => {
      if (o.status === 'READY' || o.status === 'PICKED_UP' || o.status === 'SERVED') {
        (o.items || []).forEach(i => {
          itemCounts[i.id] = (itemCounts[i.id] || 0) + (i.quantity || 0);
        });
      }
    });

    const topItems = Object.entries(itemCounts)
      .map(([id, qty]) => {
        const menu = findMenu(id);
        return { id, name: menu ? menu.name : id, quantity: qty };
      })
      .sort((a, b) => b.quantity - a.quantity);

    return sendJson(res, 200, { success: true, topItems });
  }

  return sendJson(res, 404, { success: false, message: 'Not Found' });
}

function handleRequest(req, res) {
  route(req, res);
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('Request handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Internal server error.' }));
    }
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Cafe backend running on http://localhost:${PORT}`));
}

module.exports = { handleRequest, calculateBill, MENU, STATUS_ORDER, VALID_TRANSITIONS };
