# Demo & evidence — cafe-be

Two ways to see the backend working: a **one-command scripted demo** (fastest,
fully reproducible) and the **manual browser walkthrough** for the full
frontend + backend story.

---

## 1. Scripted demo (no setup, no mocks)

```bash
cd cafe-be
node scripts/demo.js
```

The script starts the real server on an ephemeral port with a throwaway store,
then performs every step below and prints each request and response. Nothing is
stubbed.

**Result (2026-10-17, Node v24.20.0):**

```
  RESULT: 29 / 29 checks passed
```

The 29 checks:

| # | Check | Why it matters |
| --- | --- | --- |
| 1 | health is ok | server boots |
| 2 | menu has 9 items | catalogue served |
| 3 | order created (201) | guest checkout works |
| 4 | **server computed the total (13.65), ignoring the client** | a tampered `totalAmount` is ignored |
| 5 | status starts PENDING | lifecycle starts correctly |
| 6 | a tracking token was issued | second factor for guest tracking |
| 7 | prep time summed from the menu (2×5 + 9 = 19s) | derived server-side |
| 8 | **no tracking token → 401** | an order id alone is not enough |
| 9 | **wrong tracking token → 403** | cannot read someone else's order |
| 10 | correct token → 200 | owner can track |
| 11 | public view never leaks the token | no secret exposure |
| 12 | public view never leaks the actors | no staff-identity exposure |
| 13 | wrong password → 401 | auth rejects bad credentials |
| 14 | chef login → role CHEF | server assigns the role |
| 15 | **no bearer token → 401** | staff routes are protected |
| 16 | **chef on the waiter API → 403** | role-based authorization |
| 17 | FIFO queue holds the order | oldest-first kitchen queue |
| 18 | **skipping a step → 409** | illegal transition rejected |
| 19 | ready → READY | chef completes prep |
| 20 | the actor was recorded | audit trail |
| 21 | waiter login → role WAITER | second role |
| 22 | waiter board shows the READY order | READY flows to service |
| 23 | serve → SERVED | lifecycle completes |
| 24 | the waiter was recorded | audit trail |
| 25 | customer sees SERVED | tracker reflects the backend |
| 26 | every transition has a timestamp | preparation/service history |
| 27 | kitchen history has the order | history endpoint |
| 28 | top-prepared counts 2 espressos | statistics |
| 29 | stats report ordersCompleted | statistics |

---

## 2. Manual walkthrough (frontend + backend)

Terminal 1 — backend:

```bash
cd cafe-be
npm start                 # http://localhost:5000
```

Terminal 2 — frontend:

```bash
cd cafe-fe
npx http-server -p 3000   # http://localhost:3000
```

Then, in a browser at `http://localhost:3000`:

1. **menu.html** — add a Coffee and a Waffle to the cart.
2. **cart.html** — choose *Dine-in*, table **7**, place the order. Note the
   confirmation shows the **server-computed** total and an order id.
3. **track.html** — the tracker shows `PENDING` and updates on its own (~3 s).
4. **staff-login.html** — sign in as `chef` / `chef123`.
5. **chef.html** — the FIFO queue shows the order; press *Start preparing*, then
   *Mark ready*.
6. Back on **track.html** (another tab) the status becomes `READY` and the
   confetti fires — driven by the backend, not the countdown.
7. **staff-login.html** (a new tab) — sign in as `waiter` / `waiter123`.
8. **waiter.html** — the ready order appears; press *Picked up*, then *Served*.
9. **track.html** — now shows `SERVED`.

### Evidence to capture

* the checkout confirmation (server totals),
* the customer tracker at each of the five statuses,
* the chef queue before/after *Mark ready*,
* the waiter board before/after *Served*,
* `node scripts/demo.js` printing `29 / 29 checks passed`.

> The backend `README.md` documents the known limitations (simulated payment,
> in-memory sessions, demo staff credentials).
