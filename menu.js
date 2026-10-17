'use strict';

const { HttpError } = require('./errors');

/** Single source of truth for tax, mirrored by the frontend as a display hint. */
const TAX_RATE = 0.05;

/**
 * The one and only pricing source. The browser may echo prices back, but the
 * server ignores them and re-derives every amount from this array.
 */
const menuItems = [
  { id: 'c1', name: 'Artisanal Espresso', category: 'Coffees', price: 3.50, prepTime: 5, description: 'Rich, bold single origin espresso shot.', image: '☕' },
  { id: 'c2', name: 'Caramel Macchiato', category: 'Coffees', price: 4.50, prepTime: 7, description: 'Espresso with vanilla, steamed milk, and caramel drizzle.', image: '☕' },
  { id: 'c3', name: 'Iced Cold Brew', category: 'Coffees', price: 4.00, prepTime: 6, description: 'Steeped for 24 hours, smooth and refreshing over ice.', image: '🧋' },
  { id: 'w1', name: 'Belgian Chocolate Waffle', category: 'Waffles', price: 6.00, prepTime: 9, description: 'Crispy golden waffle drizzled with melted Belgian chocolate.', image: '🧇' },
  { id: 'w2', name: 'Berry Blast Waffle', category: 'Waffles', price: 6.50, prepTime: 10, description: 'Topped with fresh strawberries, blueberries, and whipped cream.', image: '🍓' },
  { id: 'k1', name: 'Red Velvet Slice', category: 'Cakes', price: 5.00, prepTime: 6, description: 'Classic red velvet sponge with smooth cream cheese frosting.', image: '🍰' },
  { id: 'k2', name: 'Molten Lava Cake', category: 'Cakes', price: 5.50, prepTime: 8, description: 'Warm chocolate cake with a gooey flowing center.', image: '🍫' },
  { id: 'b1', name: 'Butter Croissant', category: 'Biscuits', price: 3.00, prepTime: 5, description: 'Flaky, buttery French pastry baked golden brown.', image: '🥐' },
  { id: 'b2', name: 'Choco-Chip Cookie', category: 'Biscuits', price: 2.50, prepTime: 5, description: 'Warm, chewy cookie loaded with rich chocolate chunks.', image: '🍪' }
];

/** Copy of the public menu (customers never see internal pricing logic). */
function getMenu() {
  return menuItems.map((item) => Object.assign({}, item));
}

function findMenuItem(id) {
  return menuItems.find((item) => item.id === id) || null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Validate a client cart and price it entirely server-side.
 *
 * Only `id` and `quantity` are read. Everything else is derived here, so a
 * tampered `totalAmount` in the request body has no effect.
 *
 * @param {Array<{id: string, quantity: number}>} rawItems
 * @returns {{items: Array, subtotal: number, tax: number, total: number, totalPrepTime: number}}
 * @throws {HttpError} 400 for any validation problem
 */
function priceItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new HttpError(400, 'Your cart is empty.', 'VALIDATION_ERROR');
  }

  const seen = new Set();

  const items = rawItems.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new HttpError(400, 'Each cart item must be an object.', 'VALIDATION_ERROR');
    }

    const id = raw.id;
    const quantity = raw.quantity;

    if (typeof id !== 'string' || id.length === 0) {
      throw new HttpError(400, 'Each cart item needs a menu id.', 'VALIDATION_ERROR');
    }

    // Positive whole numbers only — no zero, negatives, fractions or strings.
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new HttpError(400, 'Quantity must be a positive whole number.', 'VALIDATION_ERROR');
    }

    if (seen.has(id)) {
      throw new HttpError(400, 'Duplicate menu item "' + id + '" in the cart.', 'VALIDATION_ERROR');
    }
    seen.add(id);

    const menuItem = findMenuItem(id);
    if (!menuItem) {
      throw new HttpError(400, 'Unknown menu item "' + id + '".', 'VALIDATION_ERROR');
    }

    return {
      id: menuItem.id,
      name: menuItem.name,
      image: menuItem.image,
      unitPrice: menuItem.price,
      quantity,
      lineTotal: round2(menuItem.price * quantity),
      prepTime: menuItem.prepTime * quantity
    };
  });

  const subtotal = round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const tax = round2(subtotal * TAX_RATE);
  const total = round2(subtotal + tax);
  const totalPrepTime = items.reduce((sum, item) => sum + item.prepTime, 0);

  return { items, subtotal, tax, total, totalPrepTime };
}

module.exports = { TAX_RATE, menuItems, getMenu, findMenuItem, priceItems, round2 };
