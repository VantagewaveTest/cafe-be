const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 5000);
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');
const INVENTORY_FILE = path.join(__dirname, 'inventory.json');
const LOW_STOCK_THRESHOLD = 3;
const MAX_STOCK = 30;

const MENU = [
  { id: 'c1', name: 'Artisanal Espresso', category: 'Coffees', price: 3.50, prepTime: 5, stock: 0, description: 'Rich, bold single origin espresso shot.', image: '\u2615' },
  { id: 'c2', name: 'Caramel Macchiato', category: 'Coffees', price: 4.50, prepTime: 7, stock: 8, description: 'Espresso with vanilla, steamed milk, and caramel drizzle.', image: '\u2615' },
  { id: 'c3', name: 'Iced Cold Brew', category: 'Coffees', price: 4.00, prepTime: 6, stock: 6, description: 'Steeped for 24 hours, smooth and refreshing over ice.', image: '\u2615' },
  { id: 'c4', name: 'Classic Cappuccino', category: 'Coffees', price: 4.25, prepTime: 6, stock: 14, description: 'Equal parts espresso, steamed milk and cloud foam.', image: '\u2615' },
  { id: 'c5', name: 'Flat White', category: 'Coffees', price: 4.00, prepTime: 5, stock: 14, description: 'Silky microfoam over a rich double ristretto.', image: '\u2615' },
  { id: 'c6', name: 'Caffe Mocha', category: 'Coffees', price: 4.75, prepTime: 7, stock: 0, description: 'Chocolate and espresso blended with steamed milk.', image: '\u2615' },
  { id: 'c7', name: 'Americano', category: 'Coffees', price: 3.00, prepTime: 4, stock: 20, description: 'Espresso shots topped with hot water.', image: '\u2615' },
  { id: 't1', name: 'Masala Chai', category: 'Teas', price: 3.00, prepTime: 6, stock: 12, description: 'Spiced black tea brewed with cardamom, ginger and milk.', image: '\uD83C\uDF75' },
  { id: 't2', name: 'Jasmine Green Tea', category: 'Teas', price: 3.25, prepTime: 3, stock: 15, description: 'Light floral jasmine green tea.', image: '\uD83C\uDF75' },
  { id: 't3', name: 'Peach Iced Tea', category: 'Teas', price: 3.50, prepTime: 4, stock: 10, description: 'Chilled black tea with fresh peach infusion.', image: '\uD83C\uDF75' },
  { id: 'w1', name: 'Belgian Chocolate Waffle', category: 'Waffles', price: 6.00, prepTime: 9, stock: 10, description: 'Crispy golden waffle drizzled with melted Belgian chocolate.', image: '\uD83E\uDDC7' },
  { id: 'w2', name: 'Berry Blast Waffle', category: 'Waffles', price: 6.50, prepTime: 10, stock: 7, description: 'Topped with fresh strawberries, blueberries, and whipped cream.', image: '\uD83E\uDDC7' },
  { id: 'w3', name: 'Banana Nut Waffle', category: 'Waffles', price: 6.25, prepTime: 9, stock: 8, description: 'Banana slices and caramelised walnuts on waffle base.', image: '\uD83E\uDDC7' },
  { id: 'k1', name: 'Red Velvet Slice', category: 'Cakes', price: 5.00, prepTime: 6, stock: 5, description: 'Classic red velvet sponge with cream cheese frosting.', image: '\uD83C\uDF70' },
  { id: 'k2', name: 'Molten Lava Cake', category: 'Cakes', price: 5.50, prepTime: 8, stock: 4, description: 'Warm chocolate cake with a gooey flowing center.', image: '\uD83C\uDF70' },
  { id: 'k3', name: 'Blueberry Cheesecake', category: 'Cakes', price: 5.75, prepTime: 6, stock: 6, description: 'Creamy cheesecake topped with blueberry compote.', image: '\uD83C\uDF70' },
  { id: 'b1', name: 'Butter Croissant', category: 'Biscuits', price: 3.00, prepTime: 5, stock: 15, description: 'Flaky, buttery French pastry baked golden brown.', image: '\uD83E\uDD50' },
  { id: 'b2', name: 'Choco-Chip Cookie', category: 'Biscuits', price: 2.50, prepTime: 5, stock: 20, description: 'Warm, chewy cookie loaded with rich chocolate chunks.', image: '\uD83C\uDF6A' },
  { id: 'b3', name: 'Almond Biscotti', category: 'Biscuits', price: 3.25, prepTime: 4, stock: 12, description: 'Twice-baked almond biscotti, crunchy and light.', image: '\uD83C\uDF6A' },
  { id: 'b4', name: 'Strawberry Tart', category: 'Biscuits', price: 4.50, prepTime: 6, stock: 8, description: 'Fresh strawberry tart on a buttery crust.', image: '\uD83E\uDD50' },
  { id: 's1', name: 'Grilled Veg Sandwich', category: 'Sandwiches', price: 5.50, prepTime: 9, stock: 10, description: 'Grilled seasonal vegetables in multigrain bread with pesto.', image: '\uD83E\uDD6A' },
  { id: 's2', name: 'Chicken Caesar Wrap', category: 'Sandwiches', price: 6.25, prepTime: 10, stock: 7, description: 'Wraps of Caesar-grilled chicken, lettuce and parmesan.', image: '\uD83E\uDD6A' }
];

// Each menu item starts fully stocked up to the per-item cap.
MENU.forEach(item => { item.stock = MAX_STOCK; });

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_DEV = NODE_ENV === 'development';
const DEV_TOKEN_SECRET = 'cafe-demo-secret-change-me';
const DEV_CHEF_IDS = ['01', '02', '03', '04', '05', '06'];

// Build the six demo chef accounts (chef01..chef06 with ids 01..06) for local dev only.
function buildDevChefAccounts() {
  return DEV_CHEF_IDS.map(id => ({ username: 'chef' + id, password: id }));
}

// Chef accounts come from CHEF_ACCOUNTS (JSON array of { username, password }).
// They are never returned to the frontend; only the authenticated username is.
function parseChefAccounts(raw) {
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  if (!Array.isArray(parsed)) return null;
  const list = parsed
    .map(entry => ({
      username: String((entry && entry.username) || '').trim(),
      password: String((entry && entry.password) || '')
    }))
    .filter(c => c.username && c.password);
  return list.length ? list : null;
}

const ENV_CHEF_ACCOUNTS = parseChefAccounts(process.env.CHEF_ACCOUNTS);
const CHEF_ACCOUNTS = ENV_CHEF_ACCOUNTS || (IS_DEV ? buildDevChefAccounts() : []);
const TOKEN_SECRET = process.env.CHEF_TOKEN_SECRET || (IS_DEV ? DEV_TOKEN_SECRET : '');

function findChef(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  return CHEF_ACCOUNTS.find(c => c.username.toLowerCase() === u) || null;
}

function authenticateChef(username, password) {
  const chef = findChef(username);
  if (!chef) return null;
  return chef.password === String(password) ? chef : null;
}

if (!IS_DEV) {
  const unsafe = !CHEF_ACCOUNTS.length || !TOKEN_SECRET || TOKEN_SECRET === DEV_TOKEN_SECRET;
  if (unsafe) {
    console.error('Refusing to start: set CHEF_ACCOUNTS and CHEF_TOKEN_SECRET for non-development environments.');
    process.exit(1);
  }
}
if (IS_DEV && !ENV_CHEF_ACCOUNTS) {
  console.warn('[dev] Using default chef accounts (chef01..chef06). Override via CHEF_ACCOUNTS.');
}
if (IS_DEV && !process.env.CHEF_TOKEN_SECRET) {
  console.warn('[dev] Using default token secret. Override via CHEF_TOKEN_SECRET.');
}
const TOKEN_TTL_MS = 60 * 60 * 1000;

const TABLES = [
  { number: 1, capacity: 2 },
  { number: 2, capacity: 2 },
  { number: 3, capacity: 4 },
  { number: 4, capacity: 4 },
  { number: 5, capacity: 4 },
  { number: 6, capacity: 6 },
  { number: 7, capacity: 6 },
  { number: 8, capacity: 2 }
];

const BOOKING_WINDOW_MS = 90 * 60 * 1000;

let orders = loadJson(ORDERS_FILE, []);
let bookings = loadJson(BOOKINGS_FILE, []);
const idempotencyIndex = new Map();

initializeIndex();
loadInventory();

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (error) {
    console.error('Reading failed:', file, error.message);
  }
  return Array.isArray(fallback) ? fallback : [];
}

function saveJson(file, data) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function persistOrders() { saveJson(ORDERS_FILE, orders); }
function persistBookings() { saveJson(BOOKINGS_FILE, bookings); }

function loadInventory() {
  try {
    if (fs.existsSync(INVENTORY_FILE)) {
      const raw = fs.readFileSync(INVENTORY_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.items)) {
        for (const it of data.items) {
          const m = MENU.find(x => String(x.id) === String(it.id));
          if (m && Number.isFinite(Number(it.stock))) {
            m.stock = Math.max(0, Math.min(MAX_STOCK, Number(it.stock)));
          }
        }
      }
    }
  } catch (_) {
    // ignore inventory load errors
  }
}

function saveInventory() {
  try {
    const data = {
      items: MENU.map(x => ({ id: x.id, stock: x.stock }))
    };
    fs.writeFileSync(INVENTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {
    // ignore inventory save errors
  }
}

function initializeIndex() {
  orders.forEach(order => {
    if (order.idempotencyKey) idempotencyIndex.set(order.idempotencyKey, order.orderId);
  });
}

function now() { return new Date(); }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function makeId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function findMenu(id) { return MENU.find(item => item.id === id); }

function replenish(items) {
  (items || []).forEach(item => {
    const menu = findMenu(item.id);
    if (menu) menu.stock = Math.min(MAX_STOCK, menu.stock + (item.quantity || 0));
  });
}

function b64(text) { return Buffer.from(text, 'utf8').toString('base64url'); }

function signToken(username) {
  const user = String(username || '').trim();
  const body = b64(JSON.stringify({ user, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }));
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return false;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  } catch (_) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return !!findChef(payload.user) && Number(payload.exp) > Date.now();
  } catch (_) {
    return false;
  }
}

function getBearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function toChefOrder(order) {
  if (!order || typeof order !== 'object') return order;
  return {
    orderId: order.orderId,
    tableNumber: order.tableNumber || '',
    guestName: order.guestName || '',
    partySize: order.partySize || 0,
    bookingCode: order.bookingCode || '',
    items: Array.isArray(order.items) ? order.items.map(i => ({
      id: i.id || '',
      name: i.name || '',
      category: i.category || '',
      quantity: i.quantity || 0,
      prepTime: i.prepTime || 0,
      lineTotal: Number(i.lineTotal) || 0
    })) : [],
    status: order.status || '',
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expectedDeliveredAt: order.expectedDeliveredAt,
    totalPrepTime: order.totalPrepTime || 0,
    rejectionReason: order.rejectionReason || ''
  };
}

function isChef(req) {
  return verifyToken(getBearer(req));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key');
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

function decimal(n) { return Number.isFinite(Number(n)) ? Number(n) : 0; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function nextStatus(current, next) {
  const allowed = {
    placed: new Set(['preparing', 'cancelled', 'rejected']),
    preparing: new Set(['ready', 'cancelled']),
    ready: new Set(['delivered']),
    delivered: new Set([]),
    cancelled: new Set([]),
    rejected: new Set([])
  };
  return allowed[current] ? allowed[current].has(next) : false;
}

function appendStatus(order, status, actor, reason) {
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({
    from: order.status,
    to: status,
    actor,
    reason: reason || 'status change',
    at: new Date().toISOString()
  });
  order.status = status;
  order.auditTrail = order.auditTrail || [];
  order.auditTrail.push({ at: new Date().toISOString(), by: actor, event: status, reason: reason || 'status change' });
  const stamp = new Date().toISOString();
  if (status === 'preparing') order.preparingAt = stamp;
  if (status === 'ready') order.readyAt = stamp;
  if (status === 'delivered') order.deliveredAt = stamp;
  if (status === 'cancelled') order.cancelledAt = stamp;
  if (status === 'rejected') order.rejectedAt = stamp;
}

function calculateBill(input) {
  if (!input || !Array.isArray(input.items) || !input.items.length) return { error: 'Cart is empty or invalid.' };
  if (input.items.length > 100) return { error: 'Too many line items.' };

  const lines = [];
  let subtotal = 0;
  let prep = 0;
  for (const item of input.items) {
    const menu = MENU.find(m => m.id === item.id);
    if (!menu) return { error: `Unknown menu item: ${item.id}.` };
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return { error: `Invalid quantity for ${item.id}.` };
    if (menu.stock < quantity) return { error: `Insufficient stock for ${menu.name}.` };
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
  const cgst = round2(subtotal * 0.025);
  const sgst = round2(subtotal * 0.025);
  const taxAmount = round2(cgst + sgst);
  const grandTotal = round2(subtotal + taxAmount + tipAmount);

  const pending = orders.filter(order => ['placed', 'preparing', 'ready'].includes(order.status)).length;
  const expected = Math.max(5, prep + pending * 2);

  return {
    valid: true,
    lineItems: lines,
    subtotal,
    cgst,
    sgst,
    taxAmount,
    tipAmount,
    tipPercent,
    grandTotal,
    totalPrepTime: expected,
    expectedDeliveredAt: new Date(Date.now() + expected * 1000).toISOString()
  };
}

function autoTable(partySize, arrivalIso) {
  const arrival = Date.parse(arrivalIso || new Date().toISOString());
  const reserved = bookings.filter(b => ['confirmed', 'seated'].includes(b.status))
    .filter(b => Math.abs(Date.parse(b.expectedArrival) - arrival) < 90 * 60 * 1000)
    .map(b => b.tableNumber);
  const busy = new Set(reserved);
  return TABLES
    .filter(t => t.capacity >= (partySize || 1))
    .sort((a, b) => a.capacity - b.capacity)
    .find(t => !busy.has(t.number)) || null;
}

function createBooking(body) {
  const guestName = String(body.guestName || '').trim();
  if (!guestName) return { error: 'Guest name is required.' };
  const partySize = Number(body.partySize || 1);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 12) return { error: 'Party size must be between 1 and 12.' };
  const rawArrival = body.expectedArrival ? new Date(body.expectedArrival).toISOString() : new Date(Date.now() + 30 * 60 * 1000).toISOString();
  if (Date.parse(rawArrival) < Date.now() - 10 * 60 * 1000) return { error: 'Booking must not be in the past.' };

  let tableNumber = null;
  if (body.tableNumber) {
    const table = TABLES.find(t => t.number === Number(body.tableNumber));
    if (!table) return { error: 'Unknown table.' };
    if (partySize > table.capacity) return { error: `Table ${table.number} only seats ${table.capacity}.` };
    tableNumber = table.number;
  } else {
    const chosen = autoTable(partySize, rawArrival);
    if (!chosen) return { error: 'No suitable table is free at that time.' };
    tableNumber = chosen.number;
  }

  const conflicting = bookings.some(b =>
    b.tableNumber === tableNumber &&
    ['confirmed', 'seated'].includes(b.status) &&
    Math.abs(new Date(b.expectedArrival).getTime() - new Date(rawArrival).getTime()) < 90 * 60 * 1000
  );
  if (conflicting) return { error: 'That table is already reserved for this time.' };

  const booking = {
    bookingCode: 'BKG' + makeId(''),
    guestName,
    phone: String(body.phone || '').trim(),
    partySize,
    tableNumber,
    expectedArrival: rawArrival,
    notes: String(body.notes || '').trim(),
    status: 'confirmed',
    createdAt: new Date().toISOString()
  };
  bookings.push(booking);
  persistBookings();
  return { success: true, booking: publicBooking(booking) };
}

function publicBooking(booking) {
  return {
    code: booking.bookingCode,
    guestName: booking.guestName,
    partySize: booking.partySize,
    tableNumber: booking.tableNumber,
    expectedArrival: booking.expectedArrival,
    status: booking.status,
    notes: booking.notes
  };
}

function route(req, res) {
  if (sendCors(req, res)) return true;

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/menu') {
    return sendJson(res, 200, { success: true, menu: MENU });
  }

  if (req.method === 'POST' && url.pathname === '/api/bookings') {
    readBody(req).then(body => {
      const result = createBooking(body);
      if (result.error) sendJson(res, 409, { success: false, message: result.error });
      else sendJson(res, 201, result);
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  if (req.method === 'GET' && /^\/api\/bookings\/[^/]+$/.test(url.pathname)) {
    const code = decodeURIComponent(url.pathname.split('/')[3]);
    const booking = bookings.find(b => b.bookingCode === code);
    if (!booking) return sendJson(res, 404, { success: false, message: 'Booking not found.' });
    return sendJson(res, 200, { success: true, booking: publicBooking(booking) });
  }

  if (req.method === 'POST' && /^\/api\/bookings\/[^/]+\/seated$/.test(url.pathname)) {
    const code = decodeURIComponent(url.pathname.split('/')[3]);
    const booking = bookings.find(b => b.bookingCode === code);
    if (!booking) return sendJson(res, 404, { success: false, message: 'Booking not found.' });
    booking.status = 'seated';
    booking.seatedAt = new Date().toISOString();
    persistBookings();
    return sendJson(res, 200, { success: true, status: booking.status });
  }

  if (req.method === 'POST' && url.pathname === '/api/bills/preview') {
    readBody(req).then(body => {
      const bill = calculateBill(body);
      if (bill.error) sendJson(res, 400, { success: false, message: bill.error });
      else sendJson(res, 200, { success: true, bill });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    readBody(req).then(body => {
      const bill = calculateBill(body);
      if (bill.error) return sendJson(res, 400, { success: false, message: bill.error });

      const idKey = String(body.idempotencyKey || '').trim().slice(0, 100);
      if (idKey && idempotencyIndex.has(idKey)) {
        const existing = orders.find(o => o.orderId === idempotencyIndex.get(idKey));
        if (existing) {
          return sendJson(res, 200, {
            success: true,
            orderId: existing.orderId,
            totalPrepTime: existing.totalPrepTime,
            grandTotal: existing.totalAmount,
            idempotent: true
          });
        }
      }

      if (resultHasInsufficientStock(bill.lineItems)) {
        return sendJson(res, 409, { success: false, message: 'Insufficient stock for one or more items.' });
      }

      let booking = null;
      const bookingCode = String(body.bookingCode || '').trim();
      if (bookingCode) {
        booking = bookings.find(b => b.bookingCode === bookingCode);
        if (!booking) return sendJson(res, 400, { success: false, message: 'Unknown booking code.' });
        if (['cancelled', 'no_show'].includes(booking.status)) return sendJson(res, 409, { success: false, message: 'Booking is no longer available.' });
        if (booking.status === 'confirmed') {
          booking.status = 'seated';
          booking.seatedAt = booking.seatedAt || new Date().toISOString();
          persistBookings();
        }
      }

      for (const line of bill.lineItems) {
        const menu = MENU.find(m => m.id === line.id);
        menu.stock = Math.max(0, menu.stock - line.quantity);
      }
      saveInventory();

      const orderId = 'ORD-' + makeId('');
      const order = {
        orderId,
        bookingCode: booking ? booking.bookingCode : '',
        tableNumber: body.tableNumber || booking?.tableNumber || '',
        guestName: body.guestName || booking?.guestName || '',
        partySize: Number(body.partySize || booking?.partySize || 0),
        items: bill.lineItems,
        subtotal: bill.subtotal,
        cgst: bill.cgst,
        sgst: bill.sgst,
        taxAmount: bill.taxAmount,
        tipAmount: bill.tipAmount,
        totalAmount: bill.grandTotal,
        totalPrepTime: bill.totalPrepTime,
        expectedDeliveredAt: bill.expectedDeliveredAt,
        status: 'placed',
        deliveryAcked: false,
        paymentMethod: body.paymentMethod || 'cash',
        loyaltyPoints: Math.floor(bill.grandTotal),
        createdAt: new Date().toISOString(),
        auditTrail: [{ at: new Date().toISOString(), by: 'customer', event: 'placed', reason: 'order submitted' }],
        statusHistory: [{ status: 'placed', at: new Date().toISOString() }]
      };

      if (idKey) idempotencyIndex.set(idKey, orderId);
      orders.push(order);
      persistOrders();

      return sendJson(res, 201, {
        success: true,
        message: 'Order placed successfully.',
        orderId,
        totalPrepTime: order.totalPrepTime,
        expectedDeliveredAt: order.expectedDeliveredAt,
        grandTotal: order.totalAmount
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === 'GET' && orderMatch) {
    const orderId = decodeURIComponent(orderMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) return sendJson(res, 404, { success: false, message: 'Order not found.' });
    return sendJson(res, 200, {
      success: true,
      order: {
        orderId: order.orderId,
        status: order.status,
        subtotal: order.subtotal,
        cgst: order.cgst,
        sgst: order.sgst,
        taxAmount: round2(order.cgst + order.sgst),
        tipAmount: order.tipAmount,
        totalAmount: order.totalAmount,
        totalPrepTime: order.totalPrepTime,
        tableNumber: order.tableNumber,
        partySize: order.partySize,
        guestName: order.guestName,
        bookingCode: order.bookingCode,
        createdAt: order.createdAt,
        expectedDeliveredAt: order.expectedDeliveredAt,
        deliveryAcked: order.deliveryAcked,
        statusHistory: order.statusHistory,
        items: order.items.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, price: item.price }))
      }
    });
  }

  const receiptMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/receipt$/);
  if (req.method === 'GET' && receiptMatch) {
    const orderId = decodeURIComponent(receiptMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) return sendJson(res, 404, { success: false, message: 'Order not found.' });
    const html = buildReceipt(order);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  const cancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const orderId = decodeURIComponent(cancelMatch[1]);
    const order = orders.find(o => o.orderId === orderId);
    if (!order) return sendJson(res, 404, { success: false, message: 'Order not found.' });
    if (order.status !== 'placed') return sendJson(res, 409, { success: false, message: `Cannot cancel order in '${order.status}' state.` });
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();
    order.auditTrail.push({ at: order.cancelledAt, by: 'customer', event: 'cancelled', reason: 'customer request before preparation' });
    order.statusHistory.push({ status: 'cancelled', at: order.cancelledAt });
    replenish(order.items);
    persistOrders();
    return sendJson(res, 200, { success: true, message: 'Order cancelled.' });
  }

  if (req.method === 'GET' && url.pathname === '/api/chef/inventory') {
    if (!isChef(req)) return sendJson(res, 401, { success: false, message: 'Unauthorized.' });
    return sendJson(res, 200, {
      success: true,
      items: MENU.map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        price: item.price,
        prepTime: item.prepTime,
        description: item.description,
        image: item.image,
        stock: item.stock,
        maxStock: MAX_STOCK,
        warning: item.stock <= LOW_STOCK_THRESHOLD
      }))
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chef/login') {
    readBody(req).then(body => {
      const user = String(body.username || '').trim();
      const pass = String(body.password || '').trim();
      const chef = authenticateChef(user, pass);
      if (!chef) return sendJson(res, 401, { success: false, message: 'Invalid credentials.' });
      return sendJson(res, 200, { success: true, token: signToken(chef.username), username: chef.username, expiresInMs: TOKEN_TTL_MS });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/chef/orders') {
    if (!isChef(req)) return sendJson(res, 401, { success: false, message: 'Unauthorized.' });
    const sorted = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return sendJson(res, 200, { success: true, orders: sorted.map(toChefOrder) });
  }

  const rejectMatch = url.pathname.match(/^\/api\/chef\/orders\/([^/]+)\/reject$/);
  if (req.method === 'POST' && rejectMatch) {
    if (!isChef(req)) return sendJson(res, 401, { success: false, message: 'Unauthorized.' });
    readBody(req).then(body => {
      const orderId = decodeURIComponent(rejectMatch[1]);
      const order = orders.find(o => o.orderId === orderId);
      if (!order) return sendJson(res, 404, { success: false, message: 'Order not found.' });
      if (order.status !== 'placed') return sendJson(res, 409, { success: false, message: `Cannot reject order in '${order.status}' state.` });
      const reason = String(body.reason || '').trim();
      if (!reason) return sendJson(res, 400, { success: false, message: 'Reason required.' });

      if (order.status === 'rejected') {
        return sendJson(res, 200, { success: true, message: 'Already rejected.', status: order.status });
      }
      order.status = 'rejected';
      order.rejectedAt = new Date().toISOString();
      order.rejectionReason = reason;
      order.auditTrail.push({ at: order.rejectedAt, by: 'chef', event: 'rejected', reason });
      order.statusHistory.push({ status: 'rejected', at: order.rejectedAt });
      replenish(order.items);
      persistOrders();
      return sendJson(res, 200, { success: true, status: order.status });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  const statusMatch = url.pathname.match(/^\/api\/chef\/orders\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    if (!isChef(req)) return sendJson(res, 401, { success: false, message: 'Unauthorized.' });
    readBody(req).then(body => {
      const orderId = decodeURIComponent(statusMatch[1]);
      const order = orders.find(o => o.orderId === orderId);
      if (!order) return sendJson(res, 404, { success: false, message: 'Order not found.' });

      const next = String(body.status || '').trim();
      if (!['preparing', 'ready', 'delivered'].includes(next)) return sendJson(res, 400, { success: false, message: 'Invalid status.' });
      if (!nextStatus(order.status, next)) return sendJson(res, 409, { success: false, message: `Cannot move '${order.status}' → '${next}'.` });
      if (order.status === next) return sendJson(res, 200, { success: true, message: `Already ${next}.`, status: order.status });

      appendStatus(order, next, 'chef', body.reason || 'chef action');
      if (next === 'delivered') order.deliveryAcked = true;
      persistOrders();
      return sendJson(res, 200, { success: true, message: `Order moved to ${next}.`, status: order.status, previousStatus: order.statusHistory.at(-2)?.status || 'placed' });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return true;
  }

  const restockMatch = req.method === 'POST' && url.pathname.match(/^\/api\/chef\/inventory\/([^/]+)\/restock$/);
  if (restockMatch) {
    if (!isChef(req)) return sendJson(res, 401, { success: false, message: 'Unauthorized.' });
    readBody(req).then(body => {
      const id = decodeURIComponent(restockMatch[1]).trim();
      const item = MENU.find(x => String(x.id) === id);
      if (!item) return sendJson(res, 404, { success: false, message: 'Item not found.' });
      const amount = Number.isFinite(Number(body.amount)) ? Math.floor(Number(body.amount)) : 10;
      if (amount < 1 || amount > 500) return sendJson(res, 400, { success: false, message: 'Quantity must be between 1 and 500.' });
      item.stock = Math.min(MAX_STOCK, Math.max(0, item.stock + amount));
      saveInventory();
      sendJson(res, 200, {
        success: true,
        message: `${item.name} restocked by ${amount}. New stock: ${item.stock}.`,
        item: { id: item.id, name: item.name, category: item.category, price: item.price, prepTime: item.prepTime, description: item.description, image: item.image, stock: item.stock, maxStock: MAX_STOCK, warning: item.stock <= LOW_STOCK_THRESHOLD }
      });
    }).catch(err => sendJson(res, 400, { success: false, message: err.message }));
    return;
  }

  return sendJson(res, 404, { success: false, message: 'Not Found' });
}

function resultHasInsufficientStock(lines) {
  return (lines || []).some(line => {
    const menu = findMenu(line.id);
    return !menu || menu.stock < line.quantity;
  });
}

function buildReceipt(order) {
  const lines = order.items.map(item => `
    <tr>
      <td>${item.name}</td>
      <td align="center">${item.quantity}</td>
      <td align="right">${item.price.toFixed(2)}</td>
      <td align="right">${(item.price * item.quantity).toFixed(2)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Receipt #${order.orderId}</title>
  <style>
    body { font-family: "Courier New", monospace; width: 340px; margin: 0 auto; padding: 16px; color: #111; }
    h1 { margin: 0 0 4px; text-align: center; font-size: 18px; }
    p { margin: 2px 0; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { padding: 2px 0; font-size: 12px; border-bottom: 1px dashed #999; }
    .total { font-size: 16px; margin-top: 8px; }
    .print { margin-top: 16px; text-align: center; }
    @media print { button { display: none; } body { width: auto; } }
  </style>
</head>
<body>
  <h1>The Daily Grind CafAc</h1>
  <p style="text-align:center">GST Receipt</p>
  <p><strong>Receipt #:</strong> ${order.orderId}</p>
  <p><strong>Created:</strong> ${new Date(order.createdAt).toLocaleString()}</p>
  ${order.tableNumber ? `<p><strong>Table:</strong> ${order.tableNumber}</p>` : ''}
  ${order.bookingCode ? `<p><strong>Booking:</strong> ${order.bookingCode}</p>` : ''}
  <table>
    <thead>
      <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
    </thead>
    <tbody>${lines}</tbody>
  </table>
  <p>Subtotal: ₹${order.subtotal.toFixed(2)}</p>
  <p>CGST 2.5%: ₹${order.cgst.toFixed(2)}</p>
  <p>SGST 2.5%: ₹${order.sgst.toFixed(2)}</p>
  <p>Tip: ₹${order.tipAmount.toFixed(2)}</p>
  <p class="total"><strong>Grand Total: ₹${order.totalAmount.toFixed(2)}</strong></p>
  <p>Payment: ${String(order.paymentMethod || 'cash')}</p>
  <p>Status: ${order.status}</p>
  <div class="print"><button onclick="window.print()">Print receipt</button></div>
</body>
</html>`;
}

function handleRequest(req, res) {
  if (sendCors(req, res)) return;
  route(req, res);
}

const server = http.createServer((req, res) => handleRequest(req, res));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Cafe backend running on http://localhost:${PORT}`));
}

module.exports = {
  handleRequest,
  calculateBill,
  nextStatus,
  MENU
};