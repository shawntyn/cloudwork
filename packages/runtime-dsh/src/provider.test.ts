import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { dshProviderEnvironment, normalizeGatewayBaseURL, resolveDshProvider } from './provider.ts';

test('native DeepSeek defaults and alias are preserved', () => {
  assert.deepEqual(resolveDshProvider({}), { provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  const native = resolveDshProvider({ provider: 'deepseek', model: 'deepseek-v4-pro', maxTokens: '4096' });
  assert.deepEqual(native, { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 4096 });
  assert.deepEqual(dshProviderEnvironment(native, 'private-key'), { DEEPSEEK_API_KEY: 'private-key' });
  assert.throws(() => resolveDshProvider({ baseUrl: 'https://gateway.example' }), /requires DSH_PROVIDER/);
});

test('compatible routes explicitly declare arbitrary model IDs and provider capacity', () => {
  const openai = resolveDshProvider({ provider: 'openai-compatible', model: 'aimax-latest', baseUrl: 'http://gateway.example:12343', contextWindow: '262144', maxTokens: '8192' });
  assert.deepEqual(openai, {
    provider: 'cloud-work-gateway', model: 'aimax-latest', maxTokens: 8192,
    gateway: { api: 'openai-completions', baseURL: 'http://gateway.example:12343/v1', contextWindow: 262144, maxTokens: 8192 },
  });
  const anthropic = resolveDshProvider({ provider: 'anthropic-compatible', model: 'vendor/arbitrary-model', baseUrl: 'https://gateway.example/v1/' });
  assert.deepEqual(anthropic.gateway, { api: 'anthropic-messages', baseURL: 'https://gateway.example', contextWindow: 131072, maxTokens: 8192 });
  const environment = dshProviderEnvironment(openai, 'private-key');
  assert.equal(environment.CLOUD_WORK_GATEWAY_API_KEY, 'private-key');
  assert.equal(environment.CLOUD_WORK_GATEWAY_MODEL, 'aimax-latest');
  assert.equal(environment.CLOUD_WORK_GATEWAY_CONTEXT_WINDOW, '262144');
  assert.equal(environment.DEEPSEEK_API_KEY, undefined);
  assert.equal(JSON.stringify(openai).includes('private-key'), false);
});

test('base URL normalization respects each installed SDK URL convention', () => {
  for (const [input, expected] of [
    ['https://gateway.example', 'https://gateway.example/v1'],
    ['https://gateway.example/v1/', 'https://gateway.example/v1'],
    ['https://gateway.example/proxy/v1/', 'https://gateway.example/proxy/v1'],
    ['https://gateway.example/custom/', 'https://gateway.example/custom'],
  ]) assert.equal(normalizeGatewayBaseURL(input!, 'openai-completions'), expected);
  for (const [input, expected] of [
    ['https://gateway.example/', 'https://gateway.example'],
    ['https://gateway.example/v1/', 'https://gateway.example'],
    ['https://gateway.example/proxy/v1', 'https://gateway.example/proxy'],
    ['https://gateway.example/proxy/', 'https://gateway.example/proxy'],
  ]) assert.equal(normalizeGatewayBaseURL(input!, 'anthropic-messages'), expected);
  for (const input of ['file:///tmp/model', 'https://user:secret@gateway.example', 'https://gateway.example?', 'https://gateway.example#', 'https://gateway.example?key=secret', 'https://gateway.example/v1/chat/completions', 'https://gateway.example/v1/messages', 'not-a-url']) {
    assert.throws(() => normalizeGatewayBaseURL(input, 'openai-completions'), /DSH_BASE_URL/);
  }
});

test('gateway configuration rejects missing model/base, invalid capacities and inconsistent limits', () => {
  const gateway = { provider: 'openai-compatible', model: 'custom-model', baseUrl: 'https://gateway.example' };
  assert.throws(() => resolveDshProvider({ provider: 'openai-compatible', baseUrl: gateway.baseUrl }), /DSH_MODEL/);
  assert.throws(() => resolveDshProvider({ provider: 'openai-compatible', model: gateway.model }), /DSH_BASE_URL/);
  for (const model of [' leading', 'trailing ', 'bad\nmodel', 'x'.repeat(513)]) assert.throws(() => resolveDshProvider({ ...gateway, model }), /DSH_MODEL/);
  for (const invalid of ['1e3', '0x10', '1.5', ' 8192 ', '0', '-1', '2147483648', 1.5, Infinity, NaN]) {
    assert.throws(() => resolveDshProvider({ ...gateway, maxTokens: invalid }), /DSH_MAX_TOKENS/);
    assert.throws(() => resolveDshProvider({ ...gateway, contextWindow: invalid }), /DSH_CONTEXT_WINDOW/);
  }
  assert.throws(() => resolveDshProvider({ ...gateway, maxTokens: 100, contextWindow: 99 }), /cannot exceed/);
  assert.throws(() => resolveDshProvider({ ...gateway, contextWindow: 100 }), /cannot exceed/);
  assert.equal(resolveDshProvider({ ...gateway, contextWindow: '2147483647', maxTokens: '2147483647' }).maxTokens, 2147483647);
});

test('installed DSH initializes both custom protocol profiles without a model request', { timeout: 60_000 }, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloud-work-provider-')));
  const workspace = join(home, 'workspace');
  await mkdir(workspace);
  try {
    for (const provider of ['openai-compatible', 'anthropic-compatible']) {
      const config = resolveDshProvider({ provider, model: 'arbitrary-model-outside-installed-catalog', baseUrl: 'http://127.0.0.1:1/v1' });
      const harness = new DeepSeekHarness({
        profile: 'sdk', cwd: workspace, processCwd: workspace, dshHome: join(home, provider),
        provider: config.provider, model: config.model, maxTokens: config.maxTokens,
        env: { HOME: home, PATH: process.env.PATH, ...dshProviderEnvironment(config, 'unused-initialization-key') },
        patches: [fileURLToPath(new URL('./gateway.patch.yml', import.meta.url)), fileURLToPath(new URL('../../../docker/runtime/cloud-work.patch.yml', import.meta.url))],
        initializeTimeoutMs: 25_000, shutdownTimeoutMs: 1000, disposeEofGraceMs: 1000, disposeGraceMs: 1000,
      });
      try { await harness.start(); }
      finally { await harness.close(); }
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
