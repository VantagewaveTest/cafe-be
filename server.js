const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 5000);
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// Staff Accounts and Valid Tokens
const STAFF_TOKENS = {
  'token-chef-cafe-2026': { username: 'chef', role: 'chef', name: 'Kitchen Head Chef' },
  'token-waiter-cafe-2026': { username: 'waiter', role: 'waiter', name: 'Floor Waiter' }
};

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

let orders = [];
if (fs.existsSync(ORDERS_FILE)) {
  try {
    orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading orders.json:', err);
  }
}

function saveOrders() {
  try {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error('Error writing orders.json:', err);
  }
}

// Helper to sanitize orders for Chef & Waiter.
// Strips all customer-identifying information (name, phone, email, payment details).
// Chef and Waiter ONLY see: tableNumber, items, orderId, prepTime, status, and timestamps.
function sanitizeOrderForStaff(order) {
  return {
    orderId: order.orderId,
    tableNumber: order.tableNumber,
    items: (order.items || []).map(item => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      prepTime: item.prepTime
    })),
    totalPrepTime: order.totalPrepTime || 0,
    status: order.status,
    createdAt: order.createdAt,
    acceptedAt: order.acceptedAt || null,
    readyAt: order.readyAt || null,
    deliveredAt: order.deliveredAt || null
  };
}

// Authentication & Role verification helper
function authenticateStaff(req, requiredRole) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-staff-token'] || '').trim();
  
  if (!token || !STAFF_TOKENS[token]) {
    return { authenticated: false, error: 'Unauthorized: Staff credentials required.' };
  }

  const staff = STAFF_TOKENS[token];
  if (requiredRole && staff.role !== requiredRole && staff.role !== 'admin') {
    return { authenticated: false, error: `Forbidden: Access restricted to ${requiredRole} role.` };
  }

  return { authenticated: true, staff };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Staff-Token'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Staff-Token'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  try {
    // -------------------------------------------------------------
    // PUBLIC / CUSTOMER ENDPOINTS
    // -------------------------------------------------------------

    // 1. Get Menu
    if (method === 'GET' && pathname === '/api/menu') {
      return sendJson(res, 200, { success: true, menu: menuItems });
    }

    // 2. Staff Login (Chef / Waiter authentication)
    if (method === 'POST' && pathname === '/api/auth/login') {
      const { username, password } = await parseJsonBody(req);
      if (username === 'chef' && password === 'chef123') {
        return sendJson(res, 200, {
          success: true,
          token: 'token-chef-cafe-2026',
          role: 'chef',
          name: 'Kitchen Chef'
        });
      }
      if (username === 'waiter' && password === 'waiter123') {
        return sendJson(res, 200, {
          success: true,
          token: 'token-waiter-cafe-2026',
          role: 'waiter',
          name: 'Floor Waiter'
        });
      }
      return sendJson(res, 401, { success: false, message: 'Invalid staff username or password.' });
    }

    // 3. Customer Place Order (Requires Table Number)
    if (method === 'POST' && pathname === '/api/orders') {
      const { items, totalAmount, tableNumber, customerName, customerPhone } = await parseJsonBody(req);
      
      if (!tableNumber) {
        return sendJson(res, 400, {
          success: false,
          message: 'Table number is required to place an order.'
        });
      }

      if (!items || !Array.isArray(items) || items.length === 0) {
        return sendJson(res, 400, { success: false, message: 'Cart is empty or invalid items.' });
      }

      let totalPrepTime = 0;
      const validatedItems = items.map(cartItem => {
        const menuItem = menuItems.find(m => m.id === cartItem.id);
        const prepTime = menuItem ? menuItem.prepTime * (cartItem.quantity || 1) : 5 * (cartItem.quantity || 1);
        totalPrepTime += prepTime;
        return {
          id: cartItem.id,
          name: cartItem.name,
          price: cartItem.price,
          quantity: cartItem.quantity,
          prepTime
        };
      });

      const orderId = 'ORD-' + Date.now();
      const newOrder = {
        orderId,
        tableNumber: String(tableNumber).trim(),
        items: validatedItems,
        totalAmount: Number(totalAmount) || 0,
        totalPrepTime,
        status: 'pending', // Lifecycle: pending -> preparing -> ready_for_pickup -> delivered
        // Customer private details stored securely in database, but NEVER sent to staff
        customerDetails: {
          name: customerName || null,
          phone: customerPhone || null
        },
        createdAt: new Date().toISOString()
      };

      orders.push(newOrder);
      saveOrders();

      return sendJson(res, 201, {
        success: true,
        orderId,
        tableNumber: newOrder.tableNumber,
        totalPrepTime,
        status: newOrder.status,
        message: `Order #${orderId} for Table ${newOrder.tableNumber} placed successfully!`
      });
    }

    // 4. Customer Check Specific Order Status
    const customerOrderMatch = pathname.match(/^\/api\/orders\/([A-Za-z0-9_-]+)$/);
    if (method === 'GET' && customerOrderMatch) {
      const orderId = customerOrderMatch[1];
      const order = orders.find(o => o.orderId === orderId);
      if (!order) {
        return sendJson(res, 404, { success: false, message: 'Order not found.' });
      }
      return sendJson(res, 200, {
        success: true,
        order: {
          orderId: order.orderId,
          tableNumber: order.tableNumber,
          status: order.status,
          totalPrepTime: order.totalPrepTime,
          createdAt: order.createdAt,
          acceptedAt: order.acceptedAt || null,
          readyAt: order.readyAt || null,
          deliveredAt: order.deliveredAt || null
        }
      });
    }

    // -------------------------------------------------------------
    // CHEF ENDPOINTS (Protected: Chef role only)
    // Chef only sees: tableNumber, items, prepTime, orderId, status.
    // Chef accepts orders and marks them ready/handover to waiter.
    // -------------------------------------------------------------

    // 5. Chef: List Orders (Pending & In-Kitchen)
    if (method === 'GET' && pathname === '/api/chef/orders') {
      const auth = authenticateStaff(req, 'chef');
      if (!auth.authenticated) {
        return sendJson(res, 403, { success: false, message: auth.error });
      }

      // Filter relevant kitchen orders: pending, preparing, ready_for_pickup
      const kitchenOrders = orders
        .filter(o => ['pending', 'preparing', 'ready_for_pickup'].includes(o.status))
        .map(sanitizeOrderForStaff);

      return sendJson(res, 200, { success: true, orders: kitchenOrders });
    }

    // 6. Chef: Accept Order (pending -> preparing)
    const chefAcceptMatch = pathname.match(/^\/api\/chef\/orders\/([A-Za-z0-9_-]+)\/accept$/);
    if (method === 'POST' && chefAcceptMatch) {
      const auth = authenticateStaff(req, 'chef');
      if (!auth.authenticated) {
        return sendJson(res, 403, { success: false, message: auth.error });
      }

      const orderId = chefAcceptMatch[1];
      const order = orders.find(o => o.orderId === orderId);
      if (!order) {
        return sendJson(res, 404, { success: false, message: 'Order not found.' });
      }

      if (order.status !== 'pending') {
        return sendJson(res, 400, {
          success: false,
          message: `Cannot accept order in '${order.status}' status.`
        });
      }

      order.status = 'preparing';
      order.acceptedAt = new Date().toISOString();
      saveOrders();

      return sendJson(res, 200, {
        success: true,
        message: `Order #${orderId} accepted. Kitchen is now preparing food for Table ${order.tableNumber}.`,
        order: sanitizeOrderForStaff(order)
      });
    }

    // 7. Chef: Mark Ready & Handover to Waiter (preparing -> ready_for_pickup)
    const chefReadyMatch = pathname.match(/^\/api\/chef\/orders\/([A-Za-z0-9_-]+)\/ready$/);
    if (method === 'POST' && chefReadyMatch) {
      const auth = authenticateStaff(req, 'chef');
      if (!auth.authenticated) {
        return sendJson(res, 403, { success: false, message: auth.error });
      }

      const orderId = chefReadyMatch[1];
      const order = orders.find(o => o.orderId === orderId);
      if (!order) {
        return sendJson(res, 404, { success: false, message: 'Order not found.' });
      }

      if (order.status !== 'preparing') {
        return sendJson(res, 400, {
          success: false,
          message: `Cannot mark order as ready from '${order.status}' status. Must be 'preparing'.`
        });
      }

      order.status = 'ready_for_pickup';
      order.readyAt = new Date().toISOString();
      saveOrders();

      return sendJson(res, 200, {
        success: true,
        message: `Order #${orderId} is prepared and handed over to waiter for Table ${order.tableNumber}!`,
        order: sanitizeOrderForStaff(order)
      });
    }

    // -------------------------------------------------------------
    // WAITER ENDPOINTS (Protected: Waiter role only)
    // Waiter sees tableNumber prominently, picks up prepared food,
    // and marks delivered to the table.
    // -------------------------------------------------------------

    // 8. Waiter: List Orders for Floor / Delivery
    if (method === 'GET' && pathname === '/api/waiter/orders') {
      const auth = authenticateStaff(req, 'waiter');
      if (!auth.authenticated) {
        return sendJson(res, 403, { success: false, message: auth.error });
      }

      // Waiter sees orders ready for pickup, preparing, and recently delivered
      const waiterOrders = orders
        .filter(o => ['ready_for_pickup', 'preparing', 'delivered'].includes(o.status))
        .map(sanitizeOrderForStaff);

      return sendJson(res, 200, { success: true, orders: waiterOrders });
    }

    // 9. Waiter: Deliver Order to Table (ready_for_pickup -> delivered)
    const waiterDeliverMatch = pathname.match(/^\/api\/waiter\/orders\/([A-Za-z0-9_-]+)\/deliver$/);
    if (method === 'POST' && waiterDeliverMatch) {
      const auth = authenticateStaff(req, 'waiter');
      if (!auth.authenticated) {
        return sendJson(res, 403, { success: false, message: auth.error });
      }

      const orderId = waiterDeliverMatch[1];
      const order = orders.find(o => o.orderId === orderId);
      if (!order) {
        return sendJson(res, 404, { success: false, message: 'Order not found.' });
      }

      if (order.status !== 'ready_for_pickup') {
        return sendJson(res, 400, {
          success: false,
          message: `Order #${orderId} is in status '${order.status}', not ready for delivery yet.`
        });
      }

      order.status = 'delivered';
      order.deliveredAt = new Date().toISOString();
      saveOrders();

      return sendJson(res, 200, {
        success: true,
        message: `Order #${orderId} has been successfully delivered to Table ${order.tableNumber}!`,
        order: sanitizeOrderForStaff(order)
      });
    }

    // 404 Fallback
    return sendJson(res, 404, { success: false, message: 'Route Not Found' });

  } catch (error) {
    console.error('Server error:', error);
    return sendJson(res, 500, { success: false, message: 'Internal Server Error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Cafe backend running on http://localhost:${PORT}`);
  });
}

module.exports = {
  server,
  sanitizeOrderForStaff,
  orders,
  saveOrders,
  STAFF_TOKENS,
  menuItems
};
