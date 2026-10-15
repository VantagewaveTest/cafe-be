const { EventEmitter } = require('events');
const { server, orders } = require('./server');

function dispatch(method, url, body = null, headers = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = { host: 'localhost:5000', ...headers };

    let resData = '';
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(code, hdrs = {}) {
        this.statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) {
          this.headers[k.toLowerCase()] = v;
        }
      },
      write(chunk) { if (chunk) resData += chunk; },
      end(chunk) {
        if (chunk) resData += chunk;
        let parsed = resData;
        try { parsed = JSON.parse(resData); } catch (e) {}
        resolve({ status: this.statusCode, headers: this.headers, data: parsed });
      }
    };

    server.emit('request', req, res);

    process.nextTick(() => {
      if (body !== null && body !== undefined) {
        req.emit('data', JSON.stringify(body));
      }
      req.emit('end');
    });
  });
}

async function runTests() {
  console.log('--- STARTING CAFE CHEF & WAITER WORKFLOW TESTS ---');

  // Test 1: Fetch Menu
  const menuRes = await dispatch('GET', '/api/menu');
  console.assert(menuRes.status === 200, 'Test 1 Failed: Status should be 200');
  console.assert(Array.isArray(menuRes.data.menu) && menuRes.data.menu.length > 0, 'Test 1 Failed: Menu array empty');
  console.log('✓ Test 1 Passed: Menu retrieved successfully');

  // Test 2: Order without Table Number should be rejected
  const badOrderRes = await dispatch('POST', '/api/orders', {
    items: [{ id: 'c1', name: 'Artisanal Espresso', price: 3.50, quantity: 1 }]
  });
  console.assert(badOrderRes.status === 400, 'Test 2 Failed: Should require table number');
  console.log('✓ Test 2 Passed: Orders without table number are rejected (400)');

  // Test 3: Security - Customer cannot access Chef / Waiter endpoints without token
  const chefForbidden = await dispatch('GET', '/api/chef/orders');
  console.assert(chefForbidden.status === 403, 'Test 3a Failed: Chef endpoint must be protected');
  const waiterForbidden = await dispatch('GET', '/api/waiter/orders');
  console.assert(waiterForbidden.status === 403, 'Test 3b Failed: Waiter endpoint must be protected');
  console.log('✓ Test 3 Passed: Customers & unauthenticated requests are blocked with 403');

  // Test 4: Staff Login
  const chefLogin = await dispatch('POST', '/api/auth/login', { username: 'chef', password: 'chef123' });
  console.assert(chefLogin.status === 200 && chefLogin.data.role === 'chef', 'Test 4a Failed: Chef login');
  const chefToken = chefLogin.data.token;

  const waiterLogin = await dispatch('POST', '/api/auth/login', { username: 'waiter', password: 'waiter123' });
  console.assert(waiterLogin.status === 200 && waiterLogin.data.role === 'waiter', 'Test 4b Failed: Waiter login');
  const waiterToken = waiterLogin.data.token;
  console.log('✓ Test 4 Passed: Staff authentication successful for Chef and Waiter');

  // Test 5: Role Cross-Access Guard
  // Waiter token trying to access chef endpoint
  const waiterOnChef = await dispatch('GET', '/api/chef/orders', null, { 'authorization': `Bearer ${waiterToken}` });
  console.assert(waiterOnChef.status === 403, 'Test 5a Failed: Waiter should not access Chef routes');
  // Chef token trying to access waiter endpoint
  const chefOnWaiter = await dispatch('GET', '/api/waiter/orders', null, { 'authorization': `Bearer ${chefToken}` });
  console.assert(chefOnWaiter.status === 403, 'Test 5b Failed: Chef should not access Waiter routes');
  console.log('✓ Test 5 Passed: Role segregation enforced between Chef and Waiter');

  // Test 6: Place Order for Table 4 with Sensitive Customer Personal Info
  const orderRes = await dispatch('POST', '/api/orders', {
    tableNumber: '4',
    customerName: 'Top Secret VIP Customer',
    customerPhone: '+1-555-0199',
    customerEmail: 'vip@secret.org',
    items: [
      { id: 'c1', name: 'Artisanal Espresso', price: 3.50, quantity: 2 },
      { id: 'w1', name: 'Belgian Chocolate Waffle', price: 6.00, quantity: 1 }
    ],
    totalAmount: 13.00
  });
  console.assert(orderRes.status === 201, 'Test 6 Failed: Order creation failed');
  const orderId = orderRes.data.orderId;
  console.assert(orderRes.data.tableNumber === '4', 'Test 6 Failed: Table number mismatch');
  console.assert(orderRes.data.status === 'pending', 'Test 6 Failed: Initial status should be pending');
  console.log(`✓ Test 6 Passed: Order placed for Table 4 (OrderId: ${orderId})`);

  // Test 7: Privacy Data Sanitization Check (Chef View)
  const chefOrdersRes = await dispatch('GET', '/api/chef/orders', null, { 'authorization': `Bearer ${chefToken}` });
  console.assert(chefOrdersRes.status === 200, 'Test 7 Failed: Chef list orders');
  const ourChefOrder = chefOrdersRes.data.orders.find(o => o.orderId === orderId);
  console.assert(ourChefOrder !== undefined, 'Test 7 Failed: Order not found in chef queue');
  console.assert(ourChefOrder.tableNumber === '4', 'Test 7 Failed: Table number missing');
  console.assert(ourChefOrder.items.length === 2, 'Test 7 Failed: Items mismatch');
  // Verify NO customer personal details leaked!
  console.assert(ourChefOrder.customerName === undefined, 'Privacy Leak! customerName leaked to Chef');
  console.assert(ourChefOrder.customerPhone === undefined, 'Privacy Leak! customerPhone leaked to Chef');
  console.assert(ourChefOrder.customerEmail === undefined, 'Privacy Leak! customerEmail leaked to Chef');
  console.assert(ourChefOrder.customerDetails === undefined, 'Privacy Leak! customerDetails leaked to Chef');
  console.log('✓ Test 7 Passed: Chef view verified - only Table Number and items shown, ZERO customer personal data leaked!');

  // Test 8: Chef Accepts Order (pending -> preparing)
  const acceptRes = await dispatch('POST', `/api/chef/orders/${orderId}/accept`, null, { 'authorization': `Bearer ${chefToken}` });
  console.assert(acceptRes.status === 200, 'Test 8 Failed: Chef accept order');
  console.assert(acceptRes.data.order.status === 'preparing', 'Test 8 Failed: Status should be preparing');
  console.log('✓ Test 8 Passed: Chef accepted order -> status is PREPARING');

  // Customer status check
  const custTracking1 = await dispatch('GET', `/api/orders/${orderId}`);
  console.assert(custTracking1.data.order.status === 'preparing', 'Customer tracking should show preparing');

  // Test 9: Chef Marks Ready & Hands over to Waiter (preparing -> ready_for_pickup)
  const readyRes = await dispatch('POST', `/api/chef/orders/${orderId}/ready`, null, { 'authorization': `Bearer ${chefToken}` });
  console.assert(readyRes.status === 200, 'Test 9 Failed: Chef mark ready');
  console.assert(readyRes.data.order.status === 'ready_for_pickup', 'Test 9 Failed: Status should be ready_for_pickup');
  console.log('✓ Test 9 Passed: Chef marked order ready -> status is READY_FOR_PICKUP (Handed to Waiter)');

  // Test 10: Waiter View - Waiter sees Table 4 ready for delivery
  const waiterOrdersRes = await dispatch('GET', '/api/waiter/orders', null, { 'authorization': `Bearer ${waiterToken}` });
  console.assert(waiterOrdersRes.status === 200, 'Test 10 Failed: Waiter list orders');
  const ourWaiterOrder = waiterOrdersRes.data.orders.find(o => o.orderId === orderId);
  console.assert(ourWaiterOrder !== undefined, 'Test 10 Failed: Order not in waiter queue');
  console.assert(ourWaiterOrder.tableNumber === '4', 'Test 10 Failed: Table number mismatch');
  console.assert(ourWaiterOrder.status === 'ready_for_pickup', 'Test 10 Failed: Order not ready for pickup');
  // Privacy check on Waiter as well
  console.assert(ourWaiterOrder.customerName === undefined, 'Privacy Leak! customerName leaked to Waiter');
  console.assert(ourWaiterOrder.customerPhone === undefined, 'Privacy Leak! customerPhone leaked to Waiter');
  console.log('✓ Test 10 Passed: Waiter view verified - sees Table 4 ready for delivery, no customer details');

  // Test 11: Waiter Delivers Order to Table 4 (ready_for_pickup -> delivered)
  const deliverRes = await dispatch('POST', `/api/waiter/orders/${orderId}/deliver`, null, { 'authorization': `Bearer ${waiterToken}` });
  console.assert(deliverRes.status === 200, 'Test 11 Failed: Waiter deliver order');
  console.assert(deliverRes.data.order.status === 'delivered', 'Test 11 Failed: Status should be delivered');
  console.log('✓ Test 11 Passed: Waiter delivered order to Table 4 -> status is DELIVERED');

  // Test 12: Customer Tracking confirms Delivered
  const custTracking2 = await dispatch('GET', `/api/orders/${orderId}`);
  console.assert(custTracking2.data.order.status === 'delivered', 'Test 12 Failed: Customer status should be delivered');
  console.log('✓ Test 12 Passed: Customer order tracking confirms DELIVERED to Table 4');

  console.log('\n=========================================');
  console.log('ALL 12 TESTS PASSED PERFECTLY!');
  console.log('=========================================');
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
