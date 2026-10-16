# Daily Grind Cafe - API Contract

## Base URL
`http://localhost:5000`

## Status Lifecycle
`PENDING` -> `PREPARING` -> `READY` -> `PICKED_UP` -> `SERVED`

## Endpoints

### GET /api/menu
Returns all menu items with prices.

**Response 200:**
```json
{
  "success": true,
  "menu": [{ "id": "c1", "name": "Artisanal Espresso", "price": 3.50, "prepTime": 5, ... }]
}
```

### POST /api/orders
Creates a new order (guest checkout, simulated payment).

**Request:**
```json
{
  "items": [{ "id": "c1", "quantity": 2 }],
  "tableNo": "Table 3",
  "payment": { "method": "simulated", "status": "paid" }
}
```

**Response 201:**
```json
{
  "success": true,
  "orderId": "ORD-...",
  "secret": "abc123...",
  "status": "PENDING",
  "totalAmount": 7.00,
  "totalPrepTime": 10
}
```

**Errors:** 400 (invalid items/quantities)

### GET /api/orders/:id?secret=...
Customer order tracking. Requires valid secret.

**Response 200:**
```json
{
  "success": true,
  "order": { "orderId": "...", "status": "PREPARING", "items": [...], "timestamps": {...} }
}
```

**Errors:** 403 (wrong secret), 404 (not found)

### POST /api/staff/login
Staff authentication.

**Request:** `{ "username": "chef_boss", "pin": "1234" }`

**Response 200:**
```json
{ "success": true, "token": "...", "role": "CHEF", "name": "Chef Boss" }
```

**Errors:** 400 (missing fields), 401 (invalid credentials)

### GET /api/staff/orders
Staff order queue. Requires `Authorization: Bearer <token>`.

**Response 200:**
```json
{ "success": true, "orders": [...] }
```

**Errors:** 401 (missing/invalid token), 403 (invalid role)

### PATCH /api/staff/orders/:id/status
Update order status. Requires `Authorization: Bearer <token>`.

**Request:** `{ "status": "PREPARING" }`

**Response 200:**
```json
{ "success": true, "orderId": "...", "status": "PREPARING", "timestamps": {...}, "actors": {...} }
```

**Errors:** 400 (invalid status), 401 (unauthorized), 403 (wrong role), 404 (not found), 409 (invalid transition)

### GET /api/staff/history?date=YYYY-MM-DD
Date-filtered history and top items. Requires `Authorization: Bearer <token>`.

**Response 200:**
```json
{ "success": true, "orders": [...], "topItems": [{ "name": "...", "count": 5 }] }
```

**Errors:** 401 (unauthorized)

## Error Codes
- `400` - Bad Request (invalid input)
- `401` - Unauthorized (missing/invalid credentials)
- `403` - Forbidden (wrong role or invalid secret)
- `404` - Not Found
- `409` - Conflict (invalid state transition)
