'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { HttpError } = require('./errors');
const { TAX_RATE, priceItems, round2 } = require('./menu');
const { STATUSES, applyTransition } = require('./transitions');

/** Where orders live. Overridable so tests never touch the real store. */
const ORDERS_FILE = process.env.CAFE_ORDERS_FILE
  ? path.resolve(process.env.CAFE_ORDERS_FILE)
  : path.join(__dirname, 'orders.json');

const PAYMENT_METHODS = ['card', 'upi', 'cash'];

let orders = [];
let loaded = false;

/* ------------------------------------------------------------------ *
 * Persistence: atomic write + startup recovery
 * ------------------------------------------------------------------ */

/** Read the store once. A corrupt file is set aside, never allowed to crash boot. */
function load() {
  if (loaded) return;
  loaded = true;

  if (!fs.existsSync(ORDERS_FILE)) {
    orders = [];
    return;
  }

  let text = '';
  try {
    text = fs.readFileSync(ORDERS_FILE, 'utf8');
  } catch (err) {
    console.error('[orders] could not read ' + ORDERS_FILE + ':', err.message);
    orders = [];
    return;
  }

  if (!text.trim()) {
    orders = [];
    return;
  }

  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('the order store is not an array');
    orders = parsed.map(migrate).filter(Boolean);
  } catch (err) {
    // Crash recovery: keep the damaged file for inspection and start clean.
    const backup = ORDERS_FILE + '.corrupt-' + Date.now();
    try {
      fs.renameSync(ORDERS_FILE, backup);
      console.error('[orders] corrupt store moved to ' + backup + ' (' + err.message + ')');
    } catch (renameErr) {
      console.error('[orders] corrupt store could not be moved aside:', renameErr.message);
    }
    orders = [];
  }
}

/**
 * Write temp file -> fsync -> rename. A crash mid-write leaves the old file
 * intact, so a partial write can never be observed.
 * @throws {HttpError} 503
 */
function persist() {
  const tmp = ORDERS_FILE + '.tmp-' + process.pid;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(orders, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, ORDERS_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (unlinkErr) { /* nothing else to do */ }
    throw new HttpError(503, 'The café could not save that order. Please try again.', 'STORAGE_ERROR');
  }
}

/* ------------------------------------------------------------------ *
 * Normalisation / legacy migration
 * ------------------------------------------------------------------ */

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStatus(raw) {
  const upper = String(raw == null ? 'PENDING' : raw).toUpperCase();
  return STATUSES.indexOf(upper) === -1 ? 'PENDING' : upper;
}

function coerceFulfilment(raw) {
  const source = raw || {};
  if (String(source.type || '').toUpperCase() === 'DINE_IN') {
    const table = Number(source.tableNumber);
    return { type: 'DINE_IN', tableNumber: Number.isInteger(table) && table > 0 ? table : null };
  }
  return { type: 'PICKUP', tableNumber: null };
}

/**
 * Bring any stored record — including legacy lowercase `pending` rows that only
 * had `price` and a browser-computed `totalAmount` — up to the current model.
 * Pricing is always recomputed from the items so the server stays authoritative.
 * Returns null for rows that cannot be a real order.
 */
function migrate(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.orderId !== 'string' || record.orderId.length === 0) return null;

  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items = rawItems.map((item) => {
    const source = item || {};
    const unitPrice = num(source.unitPrice, num(source.price, 0));
    const quantity = num(source.quantity, 1);
    return {
      id: source.id,
      name: source.name || source.id,
      image: source.image || '•',
      unitPrice,
      quantity,
      lineTotal: round2(unitPrice * quantity),
      prepTime: num(source.prepTime, 0)
    };
  });

  const subtotal = round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const tax = round2(subtotal * TAX_RATE);
  const total = round2(subtotal + tax);
  const totalPrepTime = items.reduce((sum, item) => sum + item.prepTime, 0);

  const createdAt = record.createdAt
    || (record.timestamps && record.timestamps.createdAt)
    || new Date().toISOString();

  const timestamps = Object.assign(
    { createdAt, preparingAt: null, readyAt: null, pickedUpAt: null, servedAt: null },
    record.timestamps || {}
  );
  timestamps.createdAt = createdAt;

  const estimateReadyAt = typeof record.estimateReadyAt === 'string'
    ? record.estimateReadyAt
    : new Date(new Date(createdAt).getTime() + totalPrepTime * 1000).toISOString();

  return {
    orderId: record.orderId,
    trackingToken: typeof record.trackingToken === 'string' ? record.trackingToken : null,
    items,
    subtotal,
    tax,
    total,
    totalPrepTime,
    fulfilment: coerceFulfilment(record.fulfilment),
    payment: { status: 'SIMULATED', method: PAYMENT_METHODS.indexOf((record.payment || {}).method) === -1 ? 'cash' : record.payment.method },
    status: normalizeStatus(record.status),
    timestamps,
    actors: record.actors && typeof record.actors === 'object' ? record.actors : {},
    estimateReadyAt,
    createdAt
  };
}

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

function newOrderId() {
  return 'ORD-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function normalizeFulfilmentInput(raw) {
  const source = raw || {};
  const type = String(source.type || 'PICKUP').toUpperCase();
  if (type === 'DINE_IN') {
    const table = Number(source.tableNumber);
    if (!Number.isInteger(table) || table < 1 || table > 999) {
      throw new HttpError(400, 'A table number between 1 and 999 is required for dine-in orders.', 'VALIDATION_ERROR');
    }
    return { type: 'DINE_IN', tableNumber: table };
  }
  return { type: 'PICKUP', tableNumber: null };
}

function normalizePaymentInput(raw) {
  const source = raw || {};
  const method = String(source.method || 'card').toLowerCase();
  // Payment is always simulated: the server never confirms a real payment.
  return { status: 'SIMULATED', method: PAYMENT_METHODS.indexOf(method) === -1 ? 'card' : method };
}

/**
 * Price and store a new order. Only ids and quantities are read from the
 * payload; every amount comes from the server-side menu.
 * @throws {HttpError} 400 validation, 503 storage
 */
function createOrder(payload) {
  load();
  const body = payload && typeof payload === 'object' ? payload : {};

  const pricing = priceItems(body.items);
  const fulfilment = normalizeFulfilmentInput(body.fulfilment);
  const payment = normalizePaymentInput(body.payment);

  const createdAt = new Date().toISOString();

  const order = {
    orderId: newOrderId(),
    trackingToken: crypto.randomBytes(24).toString('hex'),
    items: pricing.items,
    subtotal: pricing.subtotal,
    tax: pricing.tax,
    total: pricing.total,
    totalPrepTime: pricing.totalPrepTime,
    fulfilment,
    payment,
    status: 'PENDING',
    timestamps: { createdAt, preparingAt: null, readyAt: null, pickedUpAt: null, servedAt: null },
    actors: {},
    estimateReadyAt: new Date(Date.now() + pricing.totalPrepTime * 1000).toISOString(),
    createdAt
  };

  orders.push(order);
  try {
    persist();
  } catch (err) {
    orders.pop(); // never keep an order we could not save
    throw err;
  }
  return order;
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/**
 * Find an order and apply one lifecycle move, rolling the in-memory change back
 * if it cannot be persisted.
 * @throws {HttpError} 404 unknown, 403 wrong role, 409 bad transition, 503 storage
 */
function transitionOrder(orderId, action, session) {
  load();
  const order = orders.find((candidate) => candidate.orderId === orderId);
  if (!order) {
    throw new HttpError(404, 'No order with that id.', 'NOT_FOUND');
  }

  const snapshot = JSON.parse(JSON.stringify(order));
  applyTransition(order, action, session); // throws 403 / 409 before anything is written

  try {
    persist();
  } catch (err) {
    Object.keys(order).forEach((key) => delete order[key]);
    Object.assign(order, snapshot);
    throw err;
  }
  return order;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

function all() {
  load();
  return orders;
}

function findById(orderId) {
  load();
  return orders.find((order) => order.orderId === orderId) || null;
}

function byStatus(status) {
  return all().filter((order) => order.status === status);
}

function counts() {
  const result = { PENDING: 0, PREPARING: 0, READY: 0, PICKED_UP: 0, SERVED: 0 };
  all().forEach((order) => {
    if (Object.prototype.hasOwnProperty.call(result, order.status)) result[order.status] += 1;
  });
  return result;
}

function byTime(a, b, field) {
  return new Date(a[field]).getTime() - new Date(b[field]).getTime();
}

/** Oldest PENDING first; several PREPARING tickets may be open at once. */
function kitchenQueue() {
  const pending = byStatus('PENDING').sort((a, b) => byTime(a, b, 'createdAt'));
  const preparing = byStatus('PREPARING')
    .sort((a, b) => byTime(a.timestamps, b.timestamps, 'preparingAt'));
  return { pending, preparing, counts: counts() };
}

/** What the waiter needs: what is coming, what is ready, what is on the way. */
function serviceOrders() {
  return {
    preparing: byStatus('PREPARING').sort((a, b) => byTime(a.timestamps, b.timestamps, 'preparingAt')),
    ready: byStatus('READY').sort((a, b) => byTime(a.timestamps, b.timestamps, 'readyAt')),
    pickedUp: byStatus('PICKED_UP').sort((a, b) => byTime(a.timestamps, b.timestamps, 'pickedUpAt')),
    counts: counts()
  };
}

/** UTC calendar day of an ISO string, matching the client's YYYY-MM-DD. */
function utcDate(iso) {
  if (!iso) return null;
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10);
}

/** Orders that became READY on `date`. */
function kitchenHistory(date) {
  return all()
    .filter((order) => utcDate(order.timestamps.readyAt) === date)
    .sort((a, b) => byTime(a.timestamps, b.timestamps, 'readyAt'));
}

/** Orders that were SERVED on `date`. */
function serviceHistory(date) {
  return all()
    .filter((order) => utcDate(order.timestamps.servedAt) === date)
    .sort((a, b) => byTime(a.timestamps, b.timestamps, 'servedAt'));
}

/** Popularity by completed item quantity for orders that went READY on `date`. */
function topPrepared(date) {
  const completed = kitchenHistory(date);
  const tally = new Map();

  completed.forEach((order) => {
    order.items.forEach((item) => {
      const entry = tally.get(item.id) || { id: item.id, name: item.name, image: item.image || '•', quantity: 0 };
      entry.quantity += item.quantity;
      tally.set(item.id, entry);
    });
  });

  const items = Array.from(tally.values()).sort(
    (a, b) => b.quantity - a.quantity || String(a.name).localeCompare(String(b.name))
  );

  return { items, ordersCompleted: completed.length };
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

function cloneItem(item) {
  return {
    id: item.id,
    name: item.name,
    image: item.image,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
    prepTime: item.prepTime
  };
}

/** Guest-facing view: never exposes the tracking token or staff actors. */
function publicView(order) {
  return {
    orderId: order.orderId,
    status: order.status,
    items: order.items.map(cloneItem),
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    totalPrepTime: order.totalPrepTime,
    fulfilment: Object.assign({}, order.fulfilment),
    payment: { status: order.payment.status },
    estimateReadyAt: order.estimateReadyAt,
    createdAt: order.createdAt,
    timestamps: Object.assign({}, order.timestamps)
  };
}

/** Staff-facing view: adds the actor trail. Still no tracking token. */
function staffView(order) {
  return Object.assign(publicView(order), {
    actors: Object.assign({}, order.actors)
  });
}

module.exports = {
  ORDERS_FILE,
  load,
  persist,
  migrate,
  createOrder,
  transitionOrder,
  findById,
  all,
  counts,
  kitchenQueue,
  serviceOrders,
  kitchenHistory,
  serviceHistory,
  topPrepared,
  publicView,
  staffView
};
