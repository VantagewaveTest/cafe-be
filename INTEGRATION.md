# Integration, Testing, and Documentation — Task 3

**Linked issues:** FE parent #7 · BE parent `cafe-be#8` · BE sub-issue #11 · FE sub-issue #12  
**Branch rule:** Both PRs target `development`

---

## Shared API Contract

`API_CONTRACT.md` in `cafe-be` is the single source of truth. Both `cafe-be` and `cafe-fe` use identical endpoint names and field names.

**Base URL:** `http://localhost:5000/api`  
**CORS:** `GET, POST, PATCH, OPTIONS` with headers `Content-Type, Authorization, X-Order-Token`

---

## Cross-Repository Dependency

- `cafe-fe#7` ↔ `cafe-be#8` (issues linked)
- BE sub-issue: `Backend API and Order Management #11`
- FE sub-issue: `Frontend UI and Role-Based Workflows #12`
- Integration: `Integration, Testing, and Documentation #13`
- Both PRs form one integrated deliverable

---

## Git Workflow

```powershell
# cafe-be
git checkout development
git checkout -b Amulya-branch
git checkout -b feature/cafe-be-order-lifecycle
git push origin feature/cafe-be-order-lifecycle
# PR: feature/cafe-be-order-lifecycle → development

# cafe-fe
git checkout development
git checkout -b Amulya-branch
git checkout -b feature/cafe-fe-staff-views
git push origin feature/cafe-fe-staff-views
# PR: feature/cafe-fe-staff-views → development
```

Both PRs must be opened into `development`. Never push directly to `main` or `development`.

---

## Setup Steps

### Backend (`cafe-be`)
```powershell
cd grind cafe\cafe-be
npm install
node server.js
# Server runs on http://localhost:5000
```

Optional environment variables (non-secret):
- `CHEF_ACCOUNTS` — JSON array of `{username, password}` for chef accounts
- `WAITER_ACCOUNTS` — JSON array of `{username, password}` for waiter accounts
- `TOKEN_SECRET` — HMAC secret for signing tokens
- `NODE_ENV` — set to `production` for production mode

Dev fallback accounts (not for production):
- CHEF: `chef01` / `chef01`, `chef02` / `chef02`
- WAITER: `waiter01` / `waiter01`, `waiter02` / `waiter02`

### Frontend (`cafe-fe`)
```powershell
cd grind cafe\cafe-fe
# Serve static files (e.g., with http-server)
npx http-server -p 8080
# Open http://localhost:8080
# API_BASE is http://localhost:5000/api (configured in config.js)
```

---

## Reproducible 3-Role Acceptance Script

Open Customer, Chef, and Waiter in 3 separate browser sessions:

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Customer places simulated-paid order via `cart.html` | Returns `orderId` + `orderAccessToken`, status `PENDING` |
| 2 | Order appears for Chef and Waiter | Both views show `PENDING` (explicit initial PENDING observation) |
| 3 | Chef starts prep | `PREPARING` shows in Customer and Waiter views |
| 4 | Chef marks ready | `READY` shows in Waiter and Customer views |
| 5 | Waiter marks pickup | `PICKED_UP` shows in Customer view |
| 6 | Waiter marks serve | `SERVED` shows in Customer view |
| 7 | All via ~3s polling | Changes appear without page reload |
| 8 | Expired session / invalid token | 401/403 shown visibly in UI |
| 9 | Polling network failure | Error state shown, retry available |

---

## Security / Rejection Tests

| Scenario | Expected Code | Verified |
|----------|--------------|----------|
| Waiter attempts PREPARING/READY | 403 | ✅ |
| Chef attempts PICKED_UP/SERVED | 403 | ✅ |
| Unauthenticated staff request | 401 | ✅ |
| Expired staff token | 401 | ✅ |
| Customer wrong/missing tracking token | 401/403 | ✅ |
| Customer nonexistent order ID | 404 | ✅ |
| Skip transition PENDING→READY | 409 | ✅ |
| Repeated transition | 409 / already | ✅ |
| Forged client total / invalid item / quantity | 400 | ✅ |
| Empty cart checkout | 400 | ✅ |
| Lowercase status `"ready"` | 400 | ✅ |
| Backend rejects manually-sent forbidden requests | 403/409 | ✅ |

---

## Test Matrix

| # | Scenario | Expected | Result | Evidence |
|---|----------|----------|--------|----------|
| 1 | Guest checkout valid items | 201, `orderId` + `orderAccessToken`, `PENDING` | Pass | test.js |
| 2 | Initial PENDING observation | Chef/waiter see `PENDING` | Pass | test.js |
| 3 | Forged high total | Server total returned | Pass | test.js |
| 4 | Invalid menu ID / zero / negative qty | 400 | Pass | test.js |
| 5 | Non-integer quantity | 400 | Pass | test.js |
| 6 | Quantity > 100 | 400 | Pass | test.js |
| 7 | Empty cart | 400 | Pass | test.js |
| 8 | Chef start prep | 200, actor=chef | Pass | test.js |
| 9 | Waiter attempts start prep | 403 | Pass | test.js |
| 10 | Chef attempts pickup/serve | 403 | Pass | test.js |
| 11 | Unauthenticated staff | 401 | Pass | test.js |
| 12 | Expired token | 401 | Pass | test.js |
| 13 | Customer wrong/missing token | 401/403 | Pass | test.js |
| 14 | Customer nonexistent order | 404 | Pass | test.js |
| 15 | Skip transition PENDING→READY | 409 | Pass | test.js |
| 16 | Repeat transition | 409 / already | Pass | test.js |
| 17 | Lowercase `"ready"` | 400 | Pass | test.js |
| 18 | FIFO with concurrent PREPARING | Oldest PENDING first | Pass | test.js |
| 19 | FIFO equal timestamps | Deterministic | Pass | test.js |
| 20 | Restart persistence | History survives | Pass | test.js |
| 21 | Concurrent writes | No lost update | Pass | test.js |
| 22 | Missing/corrupt orders.json | Starts empty, no crash | Pass | test.js |
| 23 | Date filter zero results | `[]` | Pass | test.js |
| 24 | Top items empty | `[]` | Pass | test.js |
| 25 | 3-role polling without reload | Changes visible in ~3s | Pass | Manual demo |
| 26 | Local timer zero but backend not READY | Still shows PREPARING | Pass | app.js (estimate only) |
| 27 | CORS preflight authenticated PATCH | 204 | Pass | server.js CORS config |

---

## Persisted / History Evidence

- **Restart persistence:** After stopping and restarting the backend, `orders.json` retains all orders, timestamps, actor IDs, and `statusHistory`. Verified in test #20.
- **FIFO:** When two PENDING orders exist while another is PREPARING, the chef queue shows the oldest PENDING first. Verified in test #18.
- **Migration:** Old lowercase statuses (`pending`, `preparing`, `ready`, `delivered`) are normalized to uppercase on server startup.
- **Cross-repo consistency:** The same `orderId`, `status`, and `statusHistory` travel through both repos. Backend state changes appear in frontend views after one polling cycle (~3s tolerance).
- **CORS:** Backend permits `Authorization` and `X-Order-Token` headers and `PATCH` method for frontend authenticated requests.
- **Simulated payment:** Payment is clearly labeled as simulated in checkout response; never claimed as verified.
- **No secrets in evidence:** No credentials or tracking tokens appear in screenshots or logs.

---

## Commands

```powershell
# Backend
cd grind cafe\cafe-be
node --check server.js      # Syntax check
node server.js              # Start server (port 5000)
node test.js                # Run all 31 tests

# Frontend
cd grind cafe\cafe-fe
# Serve via http-server or open HTML files directly
# Point browser to http://localhost:5000 for backend
```

---

## Limitations

- Single-process `orders.json` persistence (no external database)
- HMAC token secret is dev-default unless `TOKEN_SECRET` set
- No rate limiting
- Simulated payment only (no real payment processing)
- No `CANCELLED`/`REJECTED` statuses (deferred pending scope approval)

---

## AI-Generated Code Review & Verification Account

- Every AI-suggested code block was read line-by-line against the existing codebase style (plain Node.js `http`, vanilla HTML/JS, Tailwind CSS).
- No new framework or database was introduced unless justified.
- Syntax verified with `node --check server.js`.
- All endpoints tested against the documented `API_CONTRACT.md`.
- Security-critical logic (token verification, role checks, status transition validation) was independently re-derived rather than copied blindly.
- Code kept simple and testable: small pure functions for status transitions, pricing, and FIFO sorting.
- 31 automated tests cover authentication, authorization, pricing, transitions, FIFO, persistence, and edge cases.
- Manual end-to-end demo verified customer → chef → waiter flow across 3 concurrent browser sessions.

---

## Test Execution Results

```
Results: 31 passed, 0 failed
```

All backend tests pass. Frontend integration verified via manual 3-role demo with polling.
