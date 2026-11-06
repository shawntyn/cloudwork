import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerComputer } from '../src/computer-routes.ts';
import type { ComputerService } from '../src/computer.ts';

test('computer worker queue is not accessible with a run token or absent service credential', async () => {
  const previous = process.env.COMPUTER_RUNNER_TOKEN;
  process.env.COMPUTER_RUNNER_TOKEN = 'independent-worker-test-token-123456789';
  let claims = 0;
  const app = Fastify();
  registerComputer(app, { claim: async () => { claims++; return null; } } as unknown as ComputerService);
  try {
    for (const authorization of ['', 'Bearer forged-run-token']) {
      const response = await app.inject({ method: 'POST', url: '/computer/worker/claim', headers: { authorization }, payload: { runnerId: 'runner_a' } });
      assert.equal(response.statusCode, 401);
    }
    assert.equal(claims, 0);
    const response = await app.inject({ method: 'POST', url: '/computer/worker/claim', headers: { authorization: 'Bearer ' + process.env.COMPUTER_RUNNER_TOKEN }, payload: { runnerId: 'runner_a' } });
    assert.equal(response.statusCode, 200); assert.equal(claims, 1);
  } finally { await app.close(); if (previous === undefined) delete process.env.COMPUTER_RUNNER_TOKEN; else process.env.COMPUTER_RUNNER_TOKEN = previous; }
});

test('desktop input is bounded and explicit; ordinary desktop status is read only', async () => {
  let ensured = 0, views = 0, inputs = 0;
  const app = Fastify();
  registerComputer(app, {
    ensure: async () => { ensured++; }, view: async () => { views++; return { status: 'stopped' }; },
    manualInput: async (_u: string, _w: string, _c: string, text: string) => { inputs++; return { text }; },
  } as unknown as ComputerService);
  try {
    const base = '/internal/users/alice/workspaces/ws_a/desktop';
    assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, 200);
    assert.equal(views, 1); assert.equal(ensured, 0);
    assert.equal((await app.inject({ method: 'POST', url: base, payload: { operation: 'input', clientId: 'tab_a', text: 'a'.repeat(4001) } })).statusCode >= 400, true);
    assert.equal(inputs, 0);
    assert.equal((await app.inject({ method: 'POST', url: base, payload: { operation: 'input', clientId: 'tab_a', text: '中文' } })).statusCode, 200);
    assert.equal(inputs, 1); assert.equal(ensured, 0);
  } finally { await app.close(); }
});
