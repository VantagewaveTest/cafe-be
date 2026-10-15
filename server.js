const http = require('http');
const fs = require('fs');
const path = require('path');

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

let orders = [];
if (fs.existsSync(ORDERS_FILE)) {
  try {
    orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading orders.json:', err);
  }
}

function saveOrders() {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// Role-scoped order visibility: each role only gets the fields it is allowed to see.
function sanitizeOrder(order, role) {
  if (role === 'chef') {
    // Chef sees WHAT to cook and WHERE (table), but never money or customer identity.
    return {
      orderId: order.orderId,
      tableNumber: order.tableNumber || null,
      items: order.items.map(i => ({ id: i.id, name: i.name, quantity: i.quantity, prepTime: i.prepTime })),
      status: order.status,
      totalPrepTime: order.totalPrepTime,
      createdAt: order.createdAt
    };
  }
  // Customer sees THEIR order (items, price, status, ETA) but never chef/staff details.
  return {
    orderId: order.orderId,
    items: order.items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price })),
    totalAmount: order.totalAmount,
    status: order.status,
    totalPrepTime: order.totalPrepTime,
    createdAt: order.createdAt
  };
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/menu') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, menu: menuItems }));
  } 
  else if (req.method === 'POST' && url.pathname === '/api/orders') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { items, totalAmount, tableNumber, paymentMethod } = JSON.parse(body);
        if (!items || !Array.isArray(items) || items.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Cart is empty or invalid items.' }));
          return;
        }

        const allowedPayments = ['card', 'upi', 'cash'];
        const cleanTable = tableNumber !== undefined && tableNumber !== null && String(tableNumber).trim() !== ''
          ? String(tableNumber).trim().slice(0, 20)
          : null;
        const cleanPayment = allowedPayments.includes(paymentMethod) ? paymentMethod : null;

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
          items: validatedItems,
          totalAmount,
          totalPrepTime,
          tableNumber: cleanTable,
          paymentMethod: cleanPayment,
          status: 'pending',
          createdAt: new Date().toISOString()
        };

        orders.push(newOrder);
        saveOrders();

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          orderId,
          totalPrepTime,
          message: 'Order placed successfully and sent to prep simulation.'
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Invalid JSON payload.' }));
      }
    });
  } 
  else if (req.method === 'GET' && url.pathname === '/api/orders') {
    // Role-scoped list view. Customers cannot browse; they must use GET /api/orders/:id.
    const role = url.searchParams.get('role');
    if (role === 'chef') {
      const kitchenOrders = orders
        .filter(o => ['pending', 'preparing'].includes(o.status))
        .map(o => sanitizeOrder(o, 'chef'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, role: 'chef', orders: kitchenOrders }));
    } else if (role === 'customer') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        message: 'Customers can only view their own order via GET /api/orders/:orderId?role=customer'
      }));
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unknown role. Allowed roles: chef, customer.' }));
    }
  }
  else if (req.method === 'GET' && url.pathname.startsWith('/api/orders/')) {
    const orderId = url.pathname.slice('/api/orders/'.length);
    const role = url.searchParams.get('role');

    if (role !== 'customer' && role !== 'chef') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unknown role. Allowed roles: customer, chef.' }));
      return;
    }

    const order = orders.find(o => o.orderId === orderId);
    if (!order) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Order not found.' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, role, order: sanitizeOrder(order, role) }));
  }
  else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Not Found' }));
  }
});

server.listen(PORT, () => {
  console.log(`Cafe backend running on http://localhost:${PORT}`);
});
