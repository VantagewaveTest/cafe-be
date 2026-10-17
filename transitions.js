'use strict';

const { HttpError } = require('./errors');

/** Canonical lifecycle. Uppercase everywhere, front to back. */
const STATUSES = ['PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'SERVED'];

/**
 * The only four legal moves. Each names the role allowed to make it, the state
 * it must start from, the timestamp it stamps and the actor field it records.
 */
const RULES = {
  start: { role: 'CHEF', from: 'PENDING', to: 'PREPARING', stamp: 'preparingAt', actor: 'startedBy' },
  ready: { role: 'CHEF', from: 'PREPARING', to: 'READY', stamp: 'readyAt', actor: 'readyBy' },
  pickup: { role: 'WAITER', from: 'READY', to: 'PICKED_UP', stamp: 'pickedUpAt', actor: 'pickedUpBy' },
  serve: { role: 'WAITER', from: 'PICKED_UP', to: 'SERVED', stamp: 'servedAt', actor: 'servedBy' }
};

/**
 * Apply one lifecycle move to an order, in place.
 *
 * Order of checks matters:
 *  1. an unknown action is a client error (400);
 *  2. the wrong role is a *permission* problem, so a chef trying to serve is
 *     403 even if the order is in the wrong state too;
 *  3. a skipped or repeated move is a conflict (409).
 *
 * @param {object} order
 * @param {'start'|'ready'|'pickup'|'serve'} action
 * @param {{username: string, role: string}} session
 * @returns {object} the same order, mutated
 */
function applyTransition(order, action, session) {
  const rule = RULES[action];
  if (!rule) {
    throw new HttpError(400, 'Unknown action "' + action + '".', 'VALIDATION_ERROR');
  }

  if (!session || session.role !== rule.role) {
    const actor = session && session.role ? session.role : 'guest';
    throw new HttpError(403, 'A ' + actor + ' is not allowed to ' + action + ' an order.', 'FORBIDDEN');
  }

  if (order.status !== rule.from) {
    throw new HttpError(
      409,
      'Cannot ' + action + ' an order that is ' + order.status + ' (expected ' + rule.from + ').',
      'INVALID_TRANSITION'
    );
  }

  const at = new Date().toISOString();
  order.status = rule.to;
  order.timestamps[rule.stamp] = at;
  order.actors[rule.actor] = { username: session.username, role: session.role, at };
  return order;
}

module.exports = { STATUSES, RULES, applyTransition };
