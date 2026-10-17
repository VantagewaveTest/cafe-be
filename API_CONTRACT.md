# Café API contract

Agreed between **cafe-be#10** (this repo) and **cafe-fe#15**.

Base URL: `http://localhost:5000/api`
(The old frontend/backend mismatch was 5001 vs 5000; **5000 is canonical**.)

Everything is JSON. No framework is required on either side: the backend is plain
`node:http`, the frontend is plain HTML + a small `api.js` helper.

---

## 1. Conventions

| Rule | Detail |
| --- | --- |
| Statuses | **Uppercase only**: `PENDING`, `PREPARING`, `READY`, `PICKED_UP`, `SERVED` |
| Success shape | `{ "success": true, ... }` |
| Error shape | `{ "success": false, "message": "<human text>", "code": "<SLUG>" }` |
| Money | Numbers rounded to 2 decimals. `5%` tax, server-computed. |
| Dates | ISO-8601 UTC strings. Date filters use `YYYY-MM-DD` in **UTC**. |
| Payment | Always simulated. `payment.status` is always `"SIMULATED"`. No real payment is ever confirmed. |

### Error codes

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Bad payload: unknown menu id, non-positive-integer quantity, malformed JSON, bad date |
| 401 | `UNAUTHENTICATED` | No / expired / unknown session, or a missing tracking token |
| 403 | `FORBIDDEN` | Wrong role for the action, or a tracking token that does not match the order |
| 404 | `NOT_FOUND` | Unknown order id, or unknown route |
| 409 | `INVALID_TRANSITION` | Skipped or repeated status move |
| 503 | `STORAGE_ERROR` | The order store could not be written |
| 500 | `INTERNAL_ERROR` | Unexpected server fault |

---

## 2. Security model

* **Client input is never trusted for pricing.** The browser sends item ids and
  quantities only. `unitPrice`, `subtotal`, `tax`, `total` and `prepTime` are all
  computed server-side from the hardcoded `menuItems` array, which is the single
  source of truth. A client-supplied `totalAmount` is ignored.
* **Client input is never trusted for roles.** The role comes from a
  server-issued session looked up by token. A `role` in the URL or body grants
  nothing.
* **Guest tracking needs two factors.** Checkout returns `orderId` **and**
  `trackingToken`. Reading an order requires both; an order id alone is not
  enough. The token travels in the `X-Tracking-Token` header and is never placed
  in a URL.
* Order ids and tracking tokens are `crypto`-random, not `Date.now()`.

---

## 3. Authentication

### Staff login

```
POST /api/auth/login
{ "username": "chef", "password": "chef123" }
```

`200`:

```json
{
  "success": true,
  "token": "…64 hex chars…",
  "role": "CHEF",
  "username": "chef",
  "displayName": "Kitchen Chef",
  "expiresAt": "2026-10-16T20:00:00.000Z"
}
```

`401` when the username/password pair is not recognised. Both `CHEF` and
`WAITER` use this endpoint; the **server** decides the role.

Protected requests send:

```
Authorization: Bearer <token>
```

### Staff logout

```
POST /api/auth/logout            (Bearer, role CHEF|WAITER)
```

`200 { "success": true, "message": "Signed out." }`. Invalidates the session
server-side. Unknown/expired tokens → `401`.

### Demo accounts

Seeded for the demo (override with the `CAFE_STAFF_JSON` env var):

| Username | Password | Role |
| --- | --- | --- |
| `chef` | `chef123` | `CHEF` |
| `waiter` | `waiter123` | `WAITER` |

---

## 4. Public endpoints

### `GET /api/menu`

`200 { "success": true, "menu": [ { "id", "name", "category", "price", "prepTime", "description", "image" } ] }`

### `POST /api/orders` — checkout

Request (client sends **only** ids + quantities):

```json
{
  "items": [ { "id": "c1", "quantity": 2 } ],
  "fulfilment": { "type": "DINE_IN", "tableNumber": 7 },
  "payment": { "method": "card" }
}
```

* `fulfilment.type` is `DINE_IN` or `PICKUP`. `DINE_IN` requires an integer
  `tableNumber` in `1…999`. `PICKUP` ignores `tableNumber`.
* `payment.method` is one of `card`, `upi`, `cash` (default `card`). The server
  always records `payment.status = "SIMULATED"`.

`201`:

```json
{
  "success": true,
  "order": { "…public order view, see §6…" },
  "trackingToken": "…48 hex chars…"
}
```

Validation failures → `400`. The form of `items` is checked before anything is
stored, and duplicate ids in one cart are rejected.

### `GET /api/orders/:orderId` — guest tracking

Requires header `X-Tracking-Token: <token>`.

* No token → `401`
* Token that does not match the order → `403`
* Unknown order id → `404`
* Otherwise `200 { "success": true, "order": { …public view… } }`

### `GET /api/health`

`200 { "success": true, "status": "ok", "uptime": <seconds> }` — used by the demo
and the tests to wait for boot.

---

## 5. Staff endpoints

### Kitchen (role `CHEF`)

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/kitchen/queue` | `{ pending: [staffView], preparing: [staffView], counts: {...} }` — `pending` is **FIFO, oldest first**; several orders may be `PREPARING` at once |
| `PATCH` | `/api/kitchen/orders/:id/start` | `PENDING → PREPARING` |
| `PATCH` | `/api/kitchen/orders/:id/ready` | `PREPARING → READY` |
| `GET` | `/api/kitchen/history?date=YYYY-MM-DD` | `{ date, orders: [staffView] }` — orders that became `READY` on `date` |
| `GET` | `/api/stats/top-prepared?date=YYYY-MM-DD` | `{ date, items: [{id,name,image,quantity}], ordersCompleted }` — by completed item quantity |

### Service (role `WAITER`)

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/service/orders` | `{ preparing: [staffView], ready: [staffView], pickedUp: [staffView], counts: {...} }` |
| `PATCH` | `/api/service/orders/:id/pickup` | `READY → PICKED_UP` |
| `PATCH` | `/api/service/orders/:id/serve` | `PICKED_UP → SERVED` |
| `GET` | `/api/service/history?date=YYYY-MM-DD` | `{ date, orders: [staffView] }` — orders `SERVED` on `date` |

Every staff route re-derives the role server-side:
`401` without a valid session, `403` for the wrong role.

`counts` is an object with all five statuses, counted across every stored order.

---

## 6. Order model

```jsonc
{
  "orderId": "ORD-9F3A1C7B20",
  "status": "PENDING",
  "items": [
    {
      "id": "c1",
      "name": "Artisanal Espresso",
      "image": "☕",
      "unitPrice": 3.5,
      "quantity": 2,
      "lineTotal": 7.0,
      "prepTime": 10          // seconds for this line (menu prepTime × quantity)
    }
  ],
  "subtotal": 7.0,
  "tax": 0.35,
  "total": 7.35,
  "totalPrepTime": 10,
  "fulfilment": { "type": "DINE_IN", "tableNumber": 7 },
  "payment": { "status": "SIMULATED" },
  "estimateReadyAt": "2026-10-16T12:34:56.000Z",
  "createdAt": "2026-10-16T12:34:46.000Z",
  "timestamps": {
    "createdAt": "…", "preparingAt": null, "readyAt": null,
    "pickedUpAt": null, "servedAt": null
  }
}
```

**Public view** (guest tracking) is exactly the above — it never contains
`trackingToken` or `actors`.

**Staff view** (`staffView`) is the same plus:

```jsonc
"actors": {
  "startedBy": { "username": "chef", "role": "CHEF", "at": "…" },
  "readyBy":   { "username": "chef", "role": "CHEF", "at": "…" },
  "pickedUpBy": { "username": "waiter", "role": "WAITER", "at": "…" },
  "servedBy":  { "username": "waiter", "role": "WAITER", "at": "…" }
}
```

The `trackingToken` is returned **only** once, at checkout.

---

## 7. Status machine

```
PENDING ──start(CHEF)──▶ PREPARING ──ready(CHEF)──▶ READY
   └───────────────── WAITER cannot move PENDING ──────────────┘

READY ──pickup(WAITER)──▶ PICKED_UP ──serve(WAITER)──▶ SERVED
```

| Actor | Allowed | Everything else |
| --- | --- | --- |
| `CHEF` | `PENDING→PREPARING`, `PREPARING→READY` | `403` (wrong role) |
| `WAITER` | `READY→PICKED_UP`, `PICKED_UP→SERVED` | `403` (wrong role) |

* A move from the wrong state (skipped or repeated) → `409`.
* Every legal move records the actor's username, role and a timestamp.
* `READY` is decided by the backend only. The frontend countdown is an
  **estimate** and must never announce readiness on its own.

---

## 8. Notes for the frontend

* `api.js` uses `X-Tracking-Token` (never a query string) and
  `Authorization: Bearer`.
* Polling every ~3 s is *near-real-time*. On a failed poll the client keeps the
  last known status rather than inventing one; on `401` it returns to sign-in.
* The client stores `orderId` + `trackingToken` after checkout and hides
  buttons the current role cannot use.
