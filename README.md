# The Daily Grind Café — backend

Plain `node:http` API for the café order lifecycle. **No framework, no build step,
no runtime dependencies** — `server.js` boots with nothing but Node itself.

Contract: [`API_CONTRACT.md`](./API_CONTRACT.md) (agreed with cafe-fe#15).

## Run

```bash
npm start                 # or: node server.js
# Cafe backend running on http://localhost:5000
```

Requires Node 18+ (developed on Node 24). Nothing to install.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | Listen port. **5000 is canonical** — the frontend's old 5001 was the bug. |
| `CAFE_ORDERS_FILE` | `./orders.json` | Where orders are stored (used by tests). |
| `CAFE_STAFF_JSON` | demo accounts | Override the staff directory, e.g. `{"chef":{"password":"x","role":"CHEF","displayName":"Chef"}}`. |
| `CAFE_SESSION_TTL_MS` | `28800000` (8h) | Staff session lifetime. |

## Test

```bash
npm test                  # or: node --test
```

Each test file boots the real server on an ephemeral port against a throwaway
store, so the suite is isolated and touches no real data.

Coverage map:

| File | Proves |
| --- | --- |
| `test/menu.test.js` | Menu shape, unknown id / non-positive-integer quantity / empty cart / malformed JSON → 400 |
| `test/pricing.test.js` | Subtotals + 5% tax + total match hand calculations; tampered `totalAmount`/prices ignored; rounding |
| `test/auth.test.js` | Server-decided roles, 401/403, roles in URL/body grant nothing, logout invalidation |
| `test/lifecycle.test.js` | Full `PENDING → … → SERVED`, skipped/repeated moves → 409, chef-can't-serve / waiter-can't-start → 403, actor + timestamp trail |
| `test/tracking.test.js` | Order id alone → 401, wrong token → 403, cross-order access blocked, public view leaks no token/actors |
| `test/queue.test.js` | FIFO oldest-PENDING-first, several `PREPARING` at once, counts, waiter board sections |
| `test/persistence.test.js` | Two back-to-back orders persist, restart keeps status/timestamps/actors, corrupt store recovered, legacy `pending` migrated, atomic writes leave no temp file |
| `test/history.test.js` | Date-filtered kitchen/service history, top-prepared by completed quantity, bad date → 400 |

Recorded results: [`TEST_RESULTS.md`](./TEST_RESULTS.md) · live demo:
[`DEMO.md`](./DEMO.md) · one-command demo: `node scripts/demo.js`.

## Layout

```
server.js      HTTP plumbing + route table (createServer / start)
errors.js      HttpError -> HTTP status + machine-readable code
menu.js        menuItems (single pricing source) + server-side pricing/validation
auth.js        staff credentials, bearer sessions, role checks
transitions.js the four legal status moves and who may make them
orders.js      order store (atomic writes, recovery, migration), queries, views
scripts/demo.js  live, mock-free walkthrough of the whole lifecycle
test/          node:test suite
```

JSON on disk is written temp-file → `fsync` → `rename`, so an interrupted write
can never be half-observed. A corrupt file is renamed `orders.json.corrupt-<ts>`
and the server boots with an empty store instead of crashing.

## Notes / limitations

* **Payment is simulated.** `payment.status` is always `"SIMULATED"`; no payment
  provider is contacted and nothing is ever confirmed.
* **Sessions are in-memory**, so a restart signs staff out. The order store is on
  disk and survives.
* Staff credentials are demo values in `auth.js`, overridable via
  `CAFE_STAFF_JSON`. This is not production identity handling.
* `express` and `cors` remain in `package.json` from the initial commit.
  This service does not use them (it is plain `http`); removing them is a
  follow-up that would also touch `package-lock.json`.
* Legacy rows that predate the lifecycle are migrated on load: lowercase
  `pending` → `PENDING`, and pricing is recomputed from the items because the
  server owns all totals.
