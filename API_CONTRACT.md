# Daily Grind Cafe — Backend API Contract

**Base URL:** `http://localhost:5000/api`  
**Auth:** HMAC Bearer token from `POST /staff/login` (role verified server-side)  
**Guest orders:** `orderAccessToken` returned at checkout; send as `X-Order-Token` header  

---

## Canonical Status Values

`PENDING → PREPARING → READY → PICKED_UP → SERVED`

No `CANCELLED`/`REJECTED` unless scope is separately approved.

---

## Endpoints

### 1. POST /staff/login
Staff login. Server verifies credentials and issues a token with a **server-assigned role**.

**Request:**
```json
{ "username": "chef01", "password": "chef01", "role": "CHEF" }
```

**Response 200:**
```json
{ "success": true, "token": "hmac.base64url.signature", "role": "CHEF", "username": "chef01", "expiresInMs": 3600000 }
```

**Response 400:** missing fields or invalid role  
**Response 401:** invalid credentials

> The `role` in the token is set by the server. A role sent in the URL or request body is never trusted for authorization.

---

### 2. POST /api/orders (guest checkout)
Guest places an order. Server validates menu IDs and quantities, calculates totals, ignores client-supplied prices/totals.

**Request:**
```json
{
  "items": [{ "id": "c1", "quantity": 2 }],
  "paymentMethod": "card",
  "tableNumber": "6",
  "tipPercent": 10,
  "idempotencyKey": "unique-key-123"
}
```

**Response 201:**
```json
{
  "success": true,
  "message": "Order placed successfully (payment simulated).",
  "orderId": "ORD-1792...",
  "orderAccessToken": "abc123secret...",
  "grandTotal": 15.50,
  "status": "PENDING",
  "totalPrepTime": 10
}
```

**Response 400:** empty cart, invalid menu ID, invalid quantity (zero/negative/non-integer/>100), invalid JSON  
**Note:** Payment is labeled **simulated**; never claimed as verified.

---

### 3. GET /api/orders/:id
Read a single order. Customer needs `X-Order-Token`; staff needs `Authorization: Bearer <token>`. Order ID alone is **not** authorization.

**Headers (customer):**
```
X-Order-Token: <orderAccessToken from checkout>
```

**Headers (staff):**
```
Authorization: Bearer <staff login token>
```

**Response 200:**
```json
{
  "success": true,
  "order": {
    "orderId": "ORD-1792...",
    "status": "PREPARING",
    "items": [{ "id": "c1", "name": "Artisanal Espresso", "quantity": 2, "price": 3.50 }],
    "totalAmount": 7.00,
    "tableNumber": "6",
    "createdAt": "2026-10-16T10:00:00.000Z",
    "statusHistory": [...]
  }
}
```

**Response 401:** invalid or missing token  
**Response 404:** order not found  
**No public order list.**

---

### 4. PATCH /api/chef/orders/:id/status (CHEF only)
Chef starts prep or marks ready.

**Request:**
```json
{ "status": "PREPARING", "reason": "started cooking" }
```

**Valid transitions:** `PENDING → PREPARING`, `PREPARING → READY`

**Response 200:**
```json
{ "success": true, "message": "Order moved to PREPARING.", "status": "PREPARING" }
```

**Response 401:** missing/invalid token or wrong role  
**Response 403:** not CHEF  
**Response 404:** order not found  
**Response 409:** invalid or skipped transition

---

### 5. PATCH /api/waiter/orders/:id/pickup (WAITER only)
**Valid transition:** `READY → PICKED_UP`

**Response 200:** `{ "success": true, "message": "Order marked PICKED_UP.", "status": "PICKED_UP" }`  
**Response 403:** not WAITER  
**Response 409:** invalid transition

---

### 6. PATCH /api/waiter/orders/:id/serve (WAITER only)
**Valid transition:** `PICKED_UP → SERVED`

**Response 200:** `{ "success": true, "message": "Order marked SERVED.", "status": "SERVED" }`  
**Response 403:** not WAITER  
**Response 409:** invalid transition

---

### 7. GET /api/chef/queue (CHEF only)
FIFO oldest PENDING first; concurrent PREPARING allowed; status counts.

**Response 200:**
```json
{
  "success": true,
  "queue": [...],
  "preparing": [...],
  "ready": [...],
  "counts": { "pending": 2, "preparing": 1, "ready": 0 }
}
```

---

### 8. GET /api/waiter/orders (WAITER only)
Preparing and ready queues with table/counter identifier.

**Response 200:**
```json
{
  "success": true,
  "preparing": [...],
  "ready": [...],
  "counts": { "preparing": 1, "ready": 1 }
}
```

---

### 9. GET /api/chef/history?date=YYYY-MM-DD (CHEF only)
Date-filtered preparation history. Zero results returns `[]`, not an error.

---

### 10. GET /api/waiter/history?date=YYYY-MM-DD (WAITER only)
Date-filtered service history. Zero results returns `[]`, not an error.

---

### 11. GET /api/chef/top-items (CHEF only)
Popularity = sum of quantities on orders reaching READY/PICKED_UP/SERVED.

**Response 200:**
```json
{ "success": true, "topItems": [{ "id": "c1", "name": "Artisanal Espresso", "quantity": 5 }] }
```

---

## CORS

Allowed methods: `GET, POST, PATCH, OPTIONS`  
Allowed headers: `Content-Type, Authorization, X-Order-Token`

---

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Invalid input, missing fields, invalid JSON, bad quantity/menu ID |
| 401 | Missing or invalid authentication (token or order token) |
| 403 | Authenticated but forbidden role/action |
| 404 | Order not found |
| 409 | Invalid status transition or conflict |

---

## Persistence

- Single-process `orders.json` (no external database)
- Atomic writes via temp file + rename + in-memory write lock
- Old lowercase statuses (`pending`, `preparing`, `ready`, `delivered`) normalized to uppercase on server start
- History and timestamps survive restart
