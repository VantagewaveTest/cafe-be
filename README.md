# Cafe Backend (cafe-be)

Backend for **The Daily Grind Café** — a Node.js HTTP server exposing the menu and order APIs.

## Getting Started

```bash
npm install
npm start        # runs on http://localhost:5000 (or $PORT)
```

## API

### `GET /api/menu`
Returns the full menu (id, name, category, price, prepTime, description, image).

```json
{ "success": true, "menu": [ ... ] }
```

### `POST /api/orders`
Places an order.

Request body:
```json
{
  "items": [ { "id": "c1", "quantity": 2 } ],
  "totalAmount": 7.35,
  "tableNumber": "5",
  "paymentMethod": "card"
}
```

Response:
```json
{ "success": true, "orderId": "ORD-...", "totalPrepTime": 10, "message": "Order placed successfully and sent to prep simulation." }
```

- `201` — order created
- `400` — empty/invalid items or invalid JSON
- `404` — unknown route

`tableNumber` (optional, max 20 chars) and `paymentMethod` (optional, one of `card` | `upi` | `cash`) are stored on the order.

### `GET /api/orders/:orderId?role=customer|chef`
Role-scoped lookup of a single order. Each role receives a **sanitized** view:

| Role | Sees | Hidden |
|------|------|--------|
| `customer` | orderId, items (name/qty/price), totalAmount, status, prep ETA | chef/staff details, other orders |
| `chef` | orderId, **tableNumber**, items (id/name/qty/prepTime), status, ETA | prices, total, payment method, customer identity |

- `200` — sanitized order
- `403` — unknown/missing role
- `404` — order not found

### `GET /api/orders?role=...`
Role-scoped list view:

- `role=chef` — only `pending` / `preparing` orders, chef-sanitized (no money, no customer data)
- `role=customer` — `403`; customers must query their own order by ID (privacy rule enforced server-side)
- other roles — `403`

## Persistence

Orders are appended to `orders.json` in the project root (created automatically on first order).

## Notes

- CORS is enabled for all origins (`*`).
- Prep time is validated server-side against the menu's `prepTime` per item.
