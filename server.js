const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 5000);
const ORDERS_FILE = path.join(__dirname, 'orders.json');

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

// Staff credentials (in production, use hashed passwords and a database)
const STAFF = {
  'chef_boss': { pin: '1234', role: 'CHEF', name: 'Chef Boss' },
  'waiter_1': { pin: '1234', role: 'WAITER', name: 'Waiter One' }
};

// In-memory session tokens
const sessions = {};

// Valid status transitions
const VALID_TRANSITIONS = {
  'PENDING': ['PREPARING'],
  'PREPARING': ['READY'],
  'READY': ['PICKED_UP'],
  'PICKED_UP': ['SERVED'],
  'SERVED': []
};

// Role permissions for transitions
const ROLE_PERMISSIONS = {
  'CHEF': ['PENDING', 'PREPARING', 'READY'],
  'WAITER': ['READY', 'PICKED_UP', 'SERVED']
};

// Load orders from file
let orders = [];
if (fs.existsSync(ORDERS_FILE)) {
  try {
    orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
    // Migrate legacy lowercase statuses to uppercase
    let migrated = false;
    orders.forEach(order => {
      if (order.status && order.status !== order.status.toUpperCase()) {
        order.status = order.status.toUpperCase();
        migrated = true;
      }
      // Ensure timestamps exist
      if (!order.timestamps) {
        order.timestamps = {};
      }
      if (order.createdAt && !order.timestamps.created) {
        order.timestamps.created = order.createdAt;
      }
    });
    if (migrated) {
      saveOrders();
      console.log('Migrated legacy order statuses to uppercase.');
    }
  } catch (err) {
    console.error('Error reading orders.json:', err);
  }
}

function saveOrders() {
  const tmpFile = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(orders, null, 2));
  fs.renameSync(tmpFile, ORDERS_FILE);
}

function generateId() {
  return 'ORD-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateSecret() {
  return crypto.randomBytes(12).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getStaffFromToken(token) {
  const session = sessions[token];
  if (!session) return null;
  return session;
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/menu
  if (req.method === 'GET' && url.pathname === '/api/menu') {
    return sendJSON(res, 200, { success: true, menu: menuItems });
  }

  // POST /api/orders - Guest checkout
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    try {
      const body = await readBody(req);
      const { items, tableNo, payment } = body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return sendJSON(res, 400, { success: false, message: 'Cart is empty or invalid items.' });
      }

      // Validate and calculate server-side
      let totalAmount = 0;
      let totalPrepTime = 0;
      const validatedItems = [];

      for (const item of items) {
        if (!item.id || typeof item.quantity !== 'number' || item.quantity <= 0 || !Number.isInteger(item.quantity)) {
          return sendJSON(res, 400, { success: false, message: 'Invalid item ID or quantity.' });
        }
        const menuItem = menuItems.find(m => m.id === item.id);
        if (!menuItem) {
          return sendJSON(res, 400, { success: false, message: `Menu item not found: ${item.id}` });
        }
        const itemTotal = menuItem.price * item.quantity;
        totalAmount += itemTotal;
        totalPrepTime += menuItem.prepTime * item.quantity;
        validatedItems.push({
          id: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          quantity: item.quantity,
          prepTime: menuItem.prepTime * item.quantity
        });
      }

      const orderId = generateId();
      const secret = generateSecret();
      const now = new Date().toISOString();

      const newOrder = {
        orderId,
        secret,
        items: validatedItems,
        totalAmount: Math.round(totalAmount * 100) / 100,
        totalPrepTime,
        tableNo: tableNo || null,
        payment: payment || { method: 'simulated', status: 'paid' },
        status: 'PENDING',
        timestamps: { created: now },
        actors: {},
        createdAt: now
      };

      orders.push(newOrder);
      saveOrders();

      return sendJSON(res, 201, {
        success: true,
        orderId,
        secret,
        status: 'PENDING',
        totalAmount: newOrder.totalAmount,
        totalPrepTime,
        message: 'Order placed successfully (simulated payment).'
      });
    } catch (err) {
      return sendJSON(res, 400, { success: false, message: 'Invalid JSON payload.' });
    }
  }

  // GET /api/orders/:id - Customer tracking (requires secret)
  if (req.method === 'GET' && url.pathname.match(/^\/api\/orders\/[^/]+$/)) {
    const orderId = url.pathname.split('/').pop();
    const secret = url.searchParams.get('secret');

    const order = orders.find(o => o.orderId === orderId);
    if (!order) {
      return sendJSON(res, 404, { success: false, message: 'Order not found.' });
    }
    if (!secret || secret !== order.secret) {
      return sendJSON(res, 403, { success: false, message: 'Unauthorized: invalid tracking secret.' });
    }

    return sendJSON(res, 200, {
      success: true,
      order: {
        orderId: order.orderId,
        status: order.status,
        items: order.items,
        totalAmount: order.totalAmount,
        tableNo: order.tableNo,
        payment: order.payment,
        timestamps: order.timestamps,
        createdAt: order.createdAt
      }
    });
  }

  // POST /api/staff/login
  if (req.method === 'POST' && url.pathname === '/api/staff/login') {
    try {
      const body = await readBody(req);
      const { username, pin } = body;

      if (!username || !pin) {
        return sendJSON(res, 400, { success: false, message: 'Username and PIN are required.' });
      }

      const staff = STAFF[username];
      if (!staff || staff.pin !== pin) {
        return sendJSON(res, 401, { success: false, message: 'Invalid credentials.' });
      }

      const token = generateToken();
      sessions[token] = { username, role: staff.role, name: staff.name };

      return sendJSON(res, 200, {
        success: true,
        token,
        role: staff.role,
        name: staff.name
      });
    } catch (err) {
      return sendJSON(res, 400, { success: false, message: 'Invalid JSON payload.' });
    }
  }

  // GET /api/staff/orders - Staff order queue
  if (req.method === 'GET' && url.pathname === '/api/staff/orders') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendJSON(res, 401, { success: false, message: 'Unauthorized: missing token.' });
    }
    const token = authHeader.split(' ')[1];
    const session = getStaffFromToken(token);
    if (!session) {
      return sendJSON(res, 401, { success: false, message: 'Unauthorized: invalid or expired token.' });
    }

    // Filter orders based on role
    let filteredOrders;
    if (session.role === 'CHEF') {
      // Chef sees PENDING and PREPARING orders (FIFO: oldest PENDING first)
      const pending = orders.filter(o => o.status === 'PENDING').sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const preparing = orders.filter(o => o.status === 'PREPARING').sort((a, b) => new Date(a.timestamps.started) - new Date(b.timestamps.started));
      filteredOrders = [...pending, ...preparing];
    } else if (session.role === 'WAITER') {
      // Waiter sees READY and PICKED_UP orders
      const ready = orders.filter(o => o.status === 'READY').sort((a, b) => new Date(a.timestamps.ready) - new Date(b.timestamps.ready));
      const pickedUp = orders.filter(o => o.status === 'PICKED_UP').sort((a, b) => new Date(a.timestamps.pickedUp) - new Date(b.timestamps.pickedUp));
      filteredOrders = [...ready, ...pickedUp];
    } else {
      return sendJSON(res, 403, { success: false, message: 'Forbidden: invalid role.' });
    }

    return sendJSON(res, 200, {
      success: true,
      orders: filteredOrders.map(o => ({
        orderId: o.orderId,
        status: o.status,
        items: o.items,
        totalAmount: o.totalAmount,
        tableNo: o.tableNo,
        timestamps: o.timestamps,
        createdAt: o.createdAt
      }))
    });
  }

  // PATCH /api/staff/orders/:id/status - Staff status update
  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/staff\/orders\/[^/]+\/status$/)) {
    const parts = url.pathname.split('/');
    const orderId = parts[4];

    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendJSON(res, 401, { success: false, message: 'Unauthorized: missing token.' });
    }
    const token = authHeader.split(' ')[1];
    const session = getStaffFromToken(token);
    if (!session) {
      return sendJSON(res, 401, { success: false, message: 'Unauthorized: invalid or expired token.' });
    }

    try {
      const body = await readBody(req);
      const { status } = body;

      if (!status || !VALID_TRANSITIONS[status]) {
        return sendJSON(res, 400, { success: false, message: 'Invalid status value.' });
      }

      const order = orders.find(o => o.orderId === orderId);
      if (!order) {
        return sendJSON(res, 404, { success: false, message: 'Order not found.' });
      }

      // Check if transition is valid
      const currentStatus = order.status;
      if (!VALID_TRANSITIONS[currentStatus].includes(status)) {
        return sendJSON(res, 409, { success: false, message: `Invalid transition: ${currentStatus} -> ${status}` });
      }

      // Check role permission
      if (!ROLE_PERMISSIONS[session.role].includes(status)) {
        return sendJSON(res, 403, { success: false, message: `Forbidden: ${session.role} cannot set status to ${status}` });
      }

      // Update order
      order.status = status;
      const now = new Date().toISOString();
      order.timestamps[status.toLowerCase()] = now;
      order.actors[status.toLowerCase()] = session.username;

      saveOrders();

      return sendJSON(res, 200, {
        success: true,
        orderId: order.orderId,
        status: order.status,
        timestamps: order.timestamps,
        actors: order.actors
      });
    } catch (err) {
      return sendJSON(res, 400, { success: false, message: 'Invalid JSON payload.' });
    }
  }

  // GET /api/staff/history - Date-filtered history and stats
  if (req.method === 'GET' && url.pathname === '/api/staff/history') {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendJSON(res, 401, { success: false, message: 'Unauthorized: missing token.' });
    }
    const token = authHeader.split(' ')[1];
    const session = getStaffFromToken(token);
    if (!session) {
      return sendJSON(res, 401, { success: false, message: 'Unauthorized: invalid or expired token.' });
    }

    const dateFilter = url.searchParams.get('date'); // YYYY-MM-DD

    let filteredOrders = orders;
    if (dateFilter) {
      filteredOrders = orders.filter(o => {
        const orderDate = o.createdAt.split('T')[0];
        return orderDate === dateFilter;
      });
    }

    // Calculate top prepared items
    const itemCounts = {};
    filteredOrders.forEach(order => {
      if (order.status === 'SERVED' || order.status === 'PICKED_UP' || order.status === 'READY') {
        order.items.forEach(item => {
          itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
        });
      }
    });
    const topItems = Object.entries(itemCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return sendJSON(res, 200, {
      success: true,
      orders: filteredOrders.map(o => ({
        orderId: o.orderId,
        status: o.status,
        items: o.items,
        totalAmount: o.totalAmount,
        tableNo: o.tableNo,
        timestamps: o.timestamps,
        createdAt: o.createdAt
      })),
      topItems
    });
  }

  // 404
  sendJSON(res, 404, { success: false, message: 'Not Found' });
});

server.listen(PORT, () => {
  console.log(`Cafe backend running on http://localhost:${PORT}`);
});
