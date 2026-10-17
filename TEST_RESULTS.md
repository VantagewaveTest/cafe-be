# Test results — cafe-be

**Date:** 2026-10-17
**Environment:** Windows, Node **v24.20.0**
**Runner:** the built-in `node --test` — **no dependencies and no mocks**. Every
test boots the real `node:http` server on an ephemeral port against a throwaway
order store, so the tests exercise the same code path the browser hits.

## How to reproduce

```bash
cd cafe-be
npm test            # == node --test
```

## Result

```
ℹ tests 48
ℹ pass 48
ℹ fail 0
```

47 assertions across 8 files, plus the shared `test/helpers.js` file (which the
runner counts as one passing file entry).

| File | Tests | What it proves |
| --- | --- | --- |
| `test/menu.test.js` | 9 | menu shape; unknown id, non-positive/non-integer quantity, empty cart, duplicate id, malformed JSON → `400`; dine-in requires a table |
| `test/pricing.test.js` | 5 | subtotal + 5% tax + total match hand calculations; client prices/`totalAmount` ignored; 2-dp rounding; payment recorded `SIMULATED` |
| `test/auth.test.js` | 8 | the **server** decides the role; a role in the URL/body grants nothing; `401`/`403`; logout invalidates server-side |
| `test/lifecycle.test.js` | 6 | full `PENDING → … → SERVED`; skipped/repeated moves → `409`; chef can't serve / waiter can't start → `403`; actors + timestamps recorded |
| `test/tracking.test.js` | 6 | order id alone → `401`; wrong token → `403`; cross-order access blocked; public view leaks no token/actors; ids + tokens are random and unique |
| `test/queue.test.js` | 4 | FIFO oldest-PENDING-first; several `PREPARING` at once; counts for all five statuses; waiter board sections |
| `test/persistence.test.js` | 4 | back-to-back orders both persist; a restart preserves status/timestamps/actors; corrupt store recovered; legacy `pending` migrated |
| `test/history.test.js` | 5 | date-filtered kitchen/service history; top-prepared by completed quantity; bad date → `400` |

### Coverage of the assignment's test requirements

| Required scenario | Where |
| --- | --- |
| Invalid files / malformed input | `menu.test.js` (malformed JSON, bad quantities) |
| Forged / tampered values | `pricing.test.js` (tampered `totalAmount` and per-line prices) |
| Unauthorized access | `auth.test.js`, `tracking.test.js` |
| Mismatched details | `tracking.test.js` (wrong token → `403`) |
| Unavailable / failed verification | `lifecycle.test.js` (illegal transition → `409`), `errors.js` codes |
| Role escalation | `auth.test.js` (URL/body role grants nothing), `lifecycle.test.js` (cross-role → `403`) |

## Live demo (integration evidence)

`scripts/demo.js` boots the **real** server (no mocks) and walks one guest order
through the whole lifecycle, asserting 29 checks:

```bash
cd cafe-be
node scripts/demo.js
```

Result on 2026-10-17:

```
  RESULT: 29 / 29 checks passed
```

See [`DEMO.md`](./DEMO.md) for the full walkthrough and the frontend steps.
