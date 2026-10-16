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
| `SESSION_SWEEP_MS` | `60000` | How often expired sessions are purged |
| `BODY_LIMIT_BYTES` | `1000000` | Max request body size |
| `LOGIN_WINDOW_MS` | `900000` | Failed-login rate-limit window |
| `LOGIN_MAX_ATTEMPTS` | `10` | Failed logins before 429 |
| `SHUTDOWN_GRACE_MS` | `5000` | Grace period before forced exit on shutdown |
| `LOG_REQUESTS` | `true` | Set `false` to disable per-request logging |

**Staff credentials:** for local demo the server seeds `chef1:chef-secret` (CHEF)
and `waiter1:waiter-secret` (WAITER). For anything non-local, set `STAFF_USERS`
(e.g. `STAFF_USERS="chef1:strongpass:CHEF,waiter1:strongpass:WAITER"`) and never
commit real credentials to the repo.

## API

See **[API_CONTRACT.md](./API_CONTRACT.md)** for the full contract shared with
`cafe-fe`: endpoints, methods, payloads, auth headers, uppercase statuses, and
error codes.

Quick reference:
- `GET /api/health` — liveness/health probe (public).
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
history, top-prepared statistics, the health endpoint, and CORS/PATCH support.
(14 tests.)

## Persistence & concurrency

Orders are stored in `orders.json`. Writes are serialized through a queue and
applied atomically (temp file + rename) so concurrent updates don't silently
overwrite each other and a crash mid-write can't corrupt the file. Orders and
status history survive server restarts. On load, any legacy lowercase `"pending"`
status is normalized to `PENDING` without losing saved data.

## Operational notes

The server process is built for safe, observable operation:

- **Durable transitions:** every status change is written to disk *before* the
  response is returned, so a crash can't lose a confirmed transition.
- **Graceful shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting
  connections, flushes any pending writes, and exits cleanly (with a forced-exit
  fallback after `SHUTDOWN_GRACE_MS`).
- **Health check:** `GET /api/health` reports status, uptime, order count, and
  active sessions for monitoring / load balancers.
- **Request logging:** each request is logged with a request ID, method, path,
  status code, and duration; the ID is also returned in the `X-Request-Id`
  header. Disable with `LOG_REQUESTS=false`.
- **Session hygiene:** expired staff sessions and stale login-rate-limit buckets
  are swept periodically so memory doesn't grow unbounded.
- **Login brute-force protection:** repeated failed logins per user/IP are
  throttled (`429` after `LOGIN_MAX_ATTEMPTS` within `LOGIN_WINDOW_MS`).
- **Timing-safe comparisons:** staff passwords and guest tracking tokens are
  compared with `crypto.timingSafeEqual` to reduce timing-attack leakage.
- **Startup warning:** running with the default demo credentials logs a warning
  to set `STAFF_USERS` before production.

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
