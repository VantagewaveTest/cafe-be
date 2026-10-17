'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers');
h.useTempStore();

const { before, after } = require('node:test');
let server;
let chef;
let waiter;

before(async () => {
  server = await h.startServer();
  chef = await h.login(server.base, 'chef', 'chef123');
  waiter = await h.login(server.base, 'waiter', 'waiter123');
});
after(async () => { await server.close(); });

test('the server decides the role: chef -> CHEF, waiter -> WAITER', () => {
  assert.equal(chef.role, 'CHEF');
  assert.equal(waiter.role, 'WAITER');
  assert.equal(typeof chef.token, 'string');
  assert.ok(chef.expiresAt);
});

test('a role in the request body never grants access', async () => {
  const res = await h.request(server.base, 'POST', '/auth/login', {
    body: { username: 'waiter', password: 'waiter123', role: 'CHEF', token: 'chef' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'WAITER');
});

test('a role in the query string never grants access', async () => {
  const res = await h.request(server.base, 'GET', '/kitchen/queue?role=CHEF', { token: waiter.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('wrong credentials are a 401', async () => {
  for (const body of [
    { username: 'chef', password: 'wrong' },
    { username: 'nobody', password: 'chef123' },
    { username: 'chef' }
  ]) {
    const res = await h.request(server.base, 'POST', '/auth/login', { body });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'UNAUTHENTICATED');
  }
});

test('protected routes need a token', async () => {
  const res = await h.request(server.base, 'GET', '/kitchen/queue');
  assert.equal(res.status, 401);
});

test('an unknown or forged token is a 401', async () => {
  const res = await h.request(server.base, 'GET', '/kitchen/queue', { token: 'not-a-real-token' });
  assert.equal(res.status, 401);
});

test('the wrong role gets a 403 on the other dashboard', async () => {
  const kitchen = await h.request(server.base, 'GET', '/kitchen/queue', { token: waiter.token });
  assert.equal(kitchen.status, 403);

  const service = await h.request(server.base, 'GET', '/service/orders', { token: chef.token });
  assert.equal(service.status, 403);
});

test('logout invalidates the session server-side', async () => {
  const temp = await h.login(server.base, 'waiter', 'waiter123');
  const out = await h.request(server.base, 'POST', '/auth/logout', { token: temp.token, body: {} });
  assert.equal(out.status, 200);

  const after = await h.request(server.base, 'GET', '/service/orders', { token: temp.token });
  assert.equal(after.status, 401);
});
