# Daily Grind Cafe — Shared API Contract

This is the agreed contract between `cafe-be` (backend) and `cafe-fe` (frontend).
Both PRs must conform to it. The frontend must not implement any pricing,
authorization, or order-state logic — it only consumes this API.

- **Local base URL:** `http://localhost:5000/api`
- **Status values (uppercase, fixed):** `PENDING`, `PREPARING`, `READY`, `PICKED_UP`, `SERVED`
- **Order lifecycle:** `PENDING → PREPARING → READY → PICKED_UP → SERVED`
- **Currency:** USD. **Tax rate:** 5% applied server-side.

## Authentication

| Who | Mechanism | Header |
|-----|-----------|--------|
| Guest (customer) | Order-specific secret returned at checkout | `X-Order-Token: <token>` |
| Staff (CHEF / WAITER) | Server-verified login session | `Authorization: Bearer <staff-token>` |

- Guest tracking is scoped to a single order. An ID alone never grants access.
- Staff identity/role is verified server-side from the token. A role supplied in
  a URL, query string, or request body is never trusted.
- Guest tracking tokens are never exposed through staff queues, history, or logs.

## CORS

Allowed methods: `GET, POST, PATCH, OPTIONS`.
Allowed headers: `Content-Type, Authorization, X-Order-Token`.
`OPTIONS` returns `204`.

## Endpoints

### GET /api/health
**Who:** Public (monitoring / liveness probe). No auth.
Response `200`:
```json
{ "success": true, "status": "ok", "uptimeSeconds": 12,
  "orders": 0, "activeSessions": 1, "time": "2026-10-16T10:00:00.000Z" }
```

### GET /api/menu
**Who:** Guest (public). Returns server-authored prices. Prices here are the only
source of truth for checkout.

Response `200`:
```json
{
  "success": true,
  "menu": [
    { "id": "c1", "name": "Artisanal Espresso", "category": "Coffees",
      "price": 3.5, "prepTime": 5, "description": "...", "image": "☕" }
  ]
}
```

### POST /api/orders
**Who:** Guest. Validates item IDs and quantities against the trusted menu,
computes item prices, subtotal, 5% tax, and total server-side. **Client-supplied
prices and totals are ignored** (tampering is rejected).

Request:
```json
{
  "items": [ { "id": "c1", "quantity": 2 }, { "id": "w1", "quantity": 1 } ],
  "fulfillment": "table",
  "tableNumber": "T4",
  "paymentMethod": "card"
}
```
- `items[].id` must exist in the menu; `quantity` must be a positive integer.
- `fulfillment`: `"table"` or `"counter"`. If `"table"`, `tableNumber` is required.
- `paymentMethod`: `"card" | "upi" | "cash"`. Payment is **SIMULATED ONLY** — no
  real payment is processed and no payment confirmation is implied.

Response `201`:
```json
{
  "success": true,
  "orderId": "ORD-1712345678901-ab12cd",
  "trackingToken": "3f6b1c...",
  "status": "PENDING",
  "subtotal": 14.0,
  "tax": 0.7,
  "total": 14.7,
  "totalPrepTime": 19,
  "message": "Order placed. Payment is simulated, not charged."
}
```

Errors: `400` malformed JSON / empty items / unknown id / non-positive or
non-integer quantity / missing table number for table service.

### GET /api/orders/:orderId
**Who:** Guest with a matching `X-Order-Token`. Staff may also read an order.
Returns only fields authorized for the requester.

Guest response `200`:
```json
{
  "success": true,
  "order": {
    "orderId": "ORD-...",
    "status": "READY",
    "fulfillment": "table",
    "tableNumber": "T4",
    "subtotal": 14.0, "tax": 0.7, "total": 14.7,
    "items": [ { "name": "Artisanal Espresso", "quantity": 2 } ],
    "createdAt": "2026-10-16T10:00:00.000Z",
    "estimatedPrepTime": 19,
    "statusTimestamps": { "PENDING": "...", "READY": "..." }
  }
}
```
Errors: `401` missing tracking token, `403` token does not match this order,
`404` unknown order.

### POST /api/auth/login
**Who:** Staff. Verifies credentials server-side.

Request:
```json
{ "username": "chef1", "password": "secret" }
```
Response `200`:
```json
{ "success": true, "token": "st_...", "role": "CHEF", "username": "chef1",
  "expiresIn": 28800 }
```
Errors: `400` missing fields, `401` invalid credentials.

### GET /api/kitchen/queue
**Who:** CHEF. Oldest `PENDING` first. Multiple `PREPARING` tickets may coexist.

Response `200`:
```json
{ "success": true,
  "queue": [ { "orderId": "ORD-...", "items": [...], "fulfillment": "table",
               "tableNumber": "T4", "estimatedPrepTime": 19,
               "status": "PENDING", "createdAt": "..." } ],
  "preparing": [ ... ],
  "counts": { "PENDING": 3, "PREPARING": 2 } }
```
Errors: `401` no/invalid token, `403` not a CHEF.

### PATCH /api/kitchen/orders/:id/start
**Who:** CHEF. `PENDING → PREPARING`. Records actor + timestamp.
Response `200`: `{ "success": true, "order": { ... "status": "PREPARING" } }`
Errors: `404` unknown order, `409` invalid/repeated/skipped transition, `401`/`403` auth.

### PATCH /api/kitchen/orders/:id/ready
**Who:** CHEF. `PREPARING → READY`. Records actor + timestamp.
Errors: `404`, `409`, `401`/`403`.

### GET /api/kitchen/history?date=YYYY-MM-DD
**Who:** CHEF. Prep history filtered to the given date (UTC). Omit `date` for all.
Response `200`: `{ "success": true, "date": "2026-10-16", "history": [ { ...order } ] }`

### GET /api/stats/top-prepared?date=YYYY-MM-DD
**Who:** CHEF. Aggregated quantities of completed/prepared items for the date.
Response `200`:
```json
{ "success": true, "date": "2026-10-16",
  "topPrepared": [ { "id": "c1", "name": "Artisanal Espresso", "quantity": 7 } ] }
```

### GET /api/service/orders
**Who:** WAITER. `PREPARING`/`READY`/in-service orders with table/counter data.
Response `200`:
```json
{ "success": true,
  "orders": [ { "orderId": "ORD-...", "status": "READY", "fulfillment": "table",
                "tableNumber": "T4", "items": [...], "createdAt": "..." } ],
  "counts": { "PREPARING": 1, "READY": 2, "PICKED_UP": 0 } }
```
Errors: `401`/`403` (not a WAITER).

### PATCH /api/service/orders/:id/pickup
**Who:** WAITER. `READY → PICKED_UP`. Records actor + timestamp.
Errors: `404`, `409`, `401`/`403`.

### PATCH /api/service/orders/:id/serve
**Who:** WAITER. `PICKED_UP → SERVED`. Records actor + timestamp.
Errors: `404`, `409`, `401`/`403`.

### GET /api/service/history?date=YYYY-MM-DD
**Who:** WAITER. Service history filtered to the given date (UTC).
Response `200`: `{ "success": true, "date": "...", "history": [ ... ] }`

## Error shape

All errors use:
```json
{ "success": false, "message": "human readable" }
```

| Code | Meaning |
|------|---------|
| 400 | Malformed request / invalid item or quantity / missing field |
| 401 | No/expired staff login, or absent guest tracking token |
| 403 | Forbidden staff role, or invalid/mismatched guest token |
| 404 | Unknown order |
| 409 | Skipped / repeated / invalid status transition |
| 429 | Too many failed login attempts (rate limited) |
| 5xx | Persistence or internal failure |

## Compatibility notes

- Legacy orders saved with lowercase `"pending"` are read as `PENDING` without
  losing saved data.
- `POST /api/orders` keeps returning `orderId` and a success flag so the existing
  checkout keeps working; it now additionally returns `trackingToken`, `subtotal`,
  `tax`, and `total`.
- The existing customer countdown is an **estimate only**. It must never change
  order status or celebrate readiness; readiness comes only from the backend
  reporting `READY`.
