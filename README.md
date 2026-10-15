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
  "totalAmount": 7.35
}
```

Response:
```json
{ "success": true, "orderId": "ORD-...", "totalPrepTime": 10, "message": "Order placed successfully and sent to prep simulation." }
```

- `201` — order created
- `400` — empty/invalid items or invalid JSON
- `404` — unknown route

## Persistence

Orders are appended to `orders.json` in the project root (created automatically on first order).

## Notes

- CORS is enabled for all origins (`*`).
- Prep time is validated server-side against the menu's `prepTime` per item.
