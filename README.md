# Daily Grind Cafe — Backend (`cafe-be`)

Node.js HTTP backend for the Daily Grind Cafe demo: guest checkout, secure order
tracking, staff authentication, and a role-scoped order lifecycle with persistent
storage. No external framework or database — it uses the built-in `http` module
and a JSON file store, preserving the original architecture.

## Setup

```bash
npm install        # optional; the server uses only Node built-ins
npm start          # runs on http://localhost:5000
```

Environment variables (all optional, with local-demo defaults):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `5000` | Server port |
| `ORDERS_FILE` | `./orders.json` | Where orders are persisted |
| `STAFF_USERS` | dev defaults | `user:pass:ROLE,...` staff credentials |
| `SESSION_TTL_SECONDS` | `28800` | Staff session lifetime |

**Staff credentials:** for local demo the server seeds `chef1:chef-secret` (CHEF)
and `waiter1:waiter-secret` (WAITER). For anything non-local, set `STAFF_USERS`
(e.g. `STAFF_USERS="chef1:strongpass:CHEF,waiter1:strongpass:WAITER"`) and never
commit real credentials to the repo.

## API

See **[API_CONTRACT.md](./API_CONTRACT.md)** for the full contract shared with
`cafe-fe`: endpoints, methods, payloads, auth headers, uppercase statuses, and
error codes.

Quick reference:
- `GET /api/menu` — public menu (server-authored prices).
- `POST /api/orders` — guest checkout; server-side pricing + 5% tax; returns
  `orderId`, `trackingToken`, totals, `PENDING`.
- `GET /api/orders/:id` — guest tracking via `X-Order-Token` (staff may read too).
- `POST /api/auth/login` — staff login → `token` + verified `role`.
- `GET /api/kitchen/queue`, `PATCH /api/kitchen/orders/:id/{start,ready}`,
  `GET /api/kitchen/history`, `GET /api/stats/top-prepared` — CHEF.
- `GET /api/service/orders`, `PATCH /api/service/orders/:id/{pickup,serve}`,
  `GET /api/service/history` — WAITER.

Order lifecycle: `PENDING → PREPARING → READY → PICKED_UP → SERVED`. Invalid,
repeated, or skipped transitions return `409`. Role boundaries are enforced
server-side (CHEF cannot pick up/serve; WAITER cannot start/ready).

Payment is **simulated only** — the API records a payment method and a
`SIMULATED` payment status. No real payment is processed or confirmed.

## Tests

```bash
npm test           # runs node --test test/server.test.js
```

Covers: server-side pricing & 5% tax, tampered-total/unknown-item/quantity
rejection, malformed JSON, staff auth (401) and role boundaries (403), guest
tracking isolation, the full lifecycle with actor/timestamp recording, invalid
transitions (409), FIFO ordering with concurrent PREPARING, persistence and
restart recovery, legacy lowercase `pending` compatibility, date-filtered
history, top-prepared statistics, and CORS/PATCH support.

## Persistence & concurrency

Orders are stored in `orders.json`. Writes are serialized through a queue and
applied atomically (temp file + rename) so concurrent updates don't silently
overwrite each other and a crash mid-write can't corrupt the file. Orders and
status history survive server restarts. On load, any legacy lowercase `"pending"`
status is normalized to `PENDING` without losing saved data.

## Known limitations

- Single-process, in-memory session store: staff logins are cleared on restart
  (orders are not). Fine for a local demo.
- `orders.json` grows unbounded; no archival.
- History/statistics filter by the UTC date of order creation.
- No rate limiting or HTTPS (local demo only).

## AI-code review

This backend was generated with AI assistance and then reviewed and verified by
hand: every endpoint in `API_CONTRACT.md` was exercised against a running server,
the full automated suite (`npm test`, 13 tests) passes, and the customer → chef →
waiter lifecycle was walked through manually. The pricing, authorization, and
state-machine logic were read line-by-line to confirm client-supplied prices are
never trusted and role checks are server-side.
