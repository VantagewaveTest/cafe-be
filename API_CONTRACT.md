# API Contract — Daily Grind Café

Shared contract between **cafe-be** (`VantagewaveTest/cafe-be#10`) and **cafe-fe**
(`VantagewaveTest/cafe-fe#15`). Both PRs are one integrated deliverable.

> **Status:** draft for agreement. No implementation starts on either side until
> this document is agreed.

---

## 1. Conventions

| Item | Value |
|---|---|
| Base URL | `http://localhost:5000/api` |
| Content type | `application/json` |
| Encoding | UTF-8 |
| CORS | `OPTIONS` preflight enabled; `GET`, `POST`, `PATCH` allowed; headers `Content-Type`, `Authorization`, `X-Tracking-Token` |
| Port | `5000` — backend `PORT` env var; the frontend must use the same base |

Every response body is JSON. Every response includes a `success` boolean.

---

## 2. Authentication

Two independent mechanisms. **A role is never accepted from a query string or a
request body — only from a verified session.**

### 2.1 Staff (CHEF / WAITER)

```
POST /api/auth/login
Content-Type: application/json

{ "username": "chef1", "password": "••••••" }
```

```json
201 Created
{ "success": true, "token": "<opaque-session-token>", "role": "CHEF", "expiresAt": "2026-10-16T10:30:00.000Z" }
```

All staff requests then send:

```
Authorization: Bearer <opaque-session-token>
```

The server re-derives the role from the session on **every** protected request.
A `?role=CHEF` query parameter or a `role` body field is ignored.

### 2.2 Guest (customer) — order-specific access

Checkout returns **two** values: `orderId` **and** `trackingToken`.

```
GET /api/orders/:orderId
X-Tracking-Token: <trackingToken>
```

**An order ID alone must not authorize access.** Both are required, the token is
crypto-random, and a customer can read only their own order. No endpoint returns
a public list of all orders.

---

## 3. Status lifecycle

Statuses are **uppercase only**: `PENDING`, `PREPARING`, `READY`, `PICKED_UP`, `SERVED`.

```
PENDING ──chef──> PREPARING ──chef──> READY ──waiter──> PICKED_UP ──waiter──> SERVED
```

| From | To | Actor | Endpoint |
|---|---|---|---|
| `PENDING` | `PREPARING` | CHEF | `PATCH /api/kitchen/orders/:id/start` |
| `PREPARING` | `READY` | CHEF | `PATCH /api/kitchen/orders/:id/ready` |
| `READY` | `PICKED_UP` | WAITER | `PATCH /api/service/orders/:id/pickup` |
| `PICKED_UP` | `SERVED` | WAITER | `PATCH /api/service/orders/:id/serve` |

- Skipped, repeated or backward transitions → `409 Conflict`.
- Every successful transition records an **actor ID** and a **timestamp**.
- FIFO = oldest `PENDING` first, while more than one `PREPARING` may exist at once.

---

## 4. Pricing

The **server** is the only authority on price. Client-supplied `totalAmount`,
`price` or `subtotal` values are ignored.

```
unitPrice  = menuItems[id].price          (integer cents)
subtotal   = Σ unitPrice × quantity
tax        = round(subtotal × 0.05)       (5%, round half up)
total      = subtotal + tax
```

All money is computed in integer cents and rounded half-up to avoid floating
point drift. Sample item prices:

| ID | Item | Price | Prep |
|---|---|---|---|
| `c1` | Artisanal Espresso | 3.50 | 5s |
| `c2` | Caramel Macchiato | 4.50 | 7s |
| `c3` | Iced Cold Brew | 4.00 | 6s |
| `w1` | Belgian Chocolate Waffle | 6.00 | 9s |
| `w2` | Berry Blast Waffle | 6.50 | 10s |
| `k1` | Red Velvet Slice | 5.00 | 6s |
| `k2` | Molten Lava Cake | 5.50 | 8s |
| `b1` | Butter Croissant | 3.00 | 5s |
| `b2` | Choco-Chip Cookie | 2.50 | 5s |

**Worked example:** 1 × `c1` (3.50) + 2 × `w1` (6.00)
→ subtotal `15.50`, tax `0.78`, total `16.28`.

**Payment is simulated only.** Responses label it `SIMULATED`. No response may
claim that a real payment was confirmed.

---

## 5. Error format

```json
{ "success": false, "error": "INVALID_TRANSITION", "message": "Order ORD-... cannot move from READY to PREPARING." }
```

| Code | Meaning |
|---|---|
| `400` | Validation failed — unknown menu ID, non-positive-integer quantity, malformed JSON |
| `401` | Unauthenticated — missing/invalid session token or tracking token |
| `403` | Forbidden — valid session but wrong role, or wrong tracking token for that order |
| `404` | Unknown order ID or route |
| `409` | Invalid status transition |
| `503` | Persistence failure — order not saved |

---

## 6. Endpoints

### 6.1 Public / guest

#### `GET /api/menu`

```json
200 OK
{ "success": true, "menu": [ { "id": "c1", "name": "Artisanal Espresso", "category": "Coffees", "price": 3.5, "prepTime": 5, "description": "...", "image": "☕" } ] }
```

#### `POST /api/orders`

```json
{
  "items": [ { "id": "c1", "quantity": 1 }, { "id": "w1", "quantity": 2 } ],
  "fulfilment": { "type": "table", "tableNumber": 7 },
  "payment": { "method": "card" }
}
```

`fulfilment.type` is `table` (requires `tableNumber`) or `counter`.

```json
201 Created
{
  "success": true,
  "orderId": "ORD-8f3c1a2b9d",
  "trackingToken": "<crypto-random-token>",
  "subtotal": 15.50,
  "tax": 0.78,
  "total": 16.28,
  "totalPrepTime": 23,
  "status": "PENDING",
  "payment": { "status": "SIMULATED", "method": "card" },
  "createdAt": "2026-10-16T09:00:00.000Z"
}
```

`totalPrepTime` is retained in seconds so the frontend can show an **estimate**.

#### `GET /api/orders/:orderId` — requires `X-Tracking-Token`

```json
200 OK
{ "success": true, "order": { "...": "full order object, see §7" } }
```

### 6.2 Staff — CHEF

| Endpoint | Purpose |
|---|---|
| `GET /api/kitchen/queue` | oldest PENDING first, plus all PREPARING |
| `PATCH /api/kitchen/orders/:id/start` | `PENDING → PREPARING` |
| `PATCH /api/kitchen/orders/:id/ready` | `PREPARING → READY` |
| `GET /api/kitchen/history?date=YYYY-MM-DD` | date-filtered preparation history |
| `GET /api/stats/top-prepared?date=YYYY-MM-DD` | popularity by **completed item quantity** |

```json
200 OK  GET /api/kitchen/queue
{
  "success": true,
  "pending":   [ { "orderId": "ORD-...", "createdAt": "...", "items": [ { "id": "c1", "name": "Artisanal Espresso", "quantity": 1 } ], "totalPrepTime": 23 } ],
  "preparing": [ { "orderId": "ORD-...", "startedAt": "...", "items": [ ] } ]
}
```

### 6.3 Staff — WAITER

| Endpoint | Purpose |
|---|---|
| `GET /api/service/orders` | ready + picked-up queues with table/counter id |
| `PATCH /api/service/orders/:id/pickup` | `READY → PICKED_UP` |
| `PATCH /api/service/orders/:id/serve` | `PICKED_UP → SERVED` |
| `GET /api/service/history?date=YYYY-MM-DD` | date-filtered service history |

---

## 7. Order object

```json
{
  "orderId": "ORD-8f3c1a2b9d",
  "items": [ { "id": "c1", "name": "Artisanal Espresso", "quantity": 1, "unitPrice": 3.50, "prepTime": 5, "lineTotal": 3.50 } ],
  "subtotal": 15.50,
  "tax": 0.78,
  "total": 16.28,
  "totalPrepTime": 23,
  "fulfilment": { "type": "table", "tableNumber": 7 },
  "payment": { "status": "SIMULATED", "method": "card" },
  "status": "PENDING",
  "timestamps": { "createdAt": "...", "startedAt": null, "readyAt": null, "pickedUpAt": null, "servedAt": null },
  "actors": { "startedBy": null, "pickedUpBy": null, "servedBy": null }
}
```

`trackingToken` is returned **only** at checkout. It is never included in staff
responses or list endpoints.

---

## 8. Persistence

- `orders.json` is retained for the single-process demo; no database is introduced.
- Writes are atomic: write to a temp file, then `rename`.
- A partial or corrupt file on startup is handled without crashing.
- A failed write returns `503` and leaves the running server healthy.
- Legacy records stored with lowercase `pending` are normalised to `PENDING` on load.
  Legacy `ORD-<timestamp>` IDs remain readable.

---

## 9. Decisions locked

| Decision | Value |
|---|---|
| Port | `5000` |
| Statuses | uppercase, five values |
| Staff credential storage | environment variables, never committed |
| Order ID / tracking token | crypto-random, non-colliding, unguessable |
| Payment | `SIMULATED`, clearly labelled at all times |
| Framework / database | none added |

## 10. Still to confirm

| Item | Impact |
|---|---|
| Does "completed" for top-prepared mean `SERVED` or `PICKED_UP`? | statistics endpoint |
| FIFO tie-break when two orders share a `createdAt` | kitchen queue ordering |
| Date filter uses UTC day or local day? | history endpoints |
| Exact permitted CORS origins | local dev setup |
