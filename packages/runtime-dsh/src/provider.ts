/** Published DSH 0.1.5-rc.2 llm-pi-ai profile contract, isolated from platform code. */
export const GATEWAY_PROVIDER = 'cloud-work-gateway';
export const MAX_TOKEN_SETTING = 2_147_483_647;

export interface DshProviderInput {
  provider?: string;
  model?: string;
  baseUrl?: string;
  contextWindow?: number | string;
  maxTokens?: number | string;
}
export interface DshProviderConfiguration {
  provider: string;
  model: string;
  maxTokens?: number;
  gateway?: {
    api: 'openai-completions' | 'anthropic-messages';
    baseURL: string;
    contextWindow: number;
    maxTokens: number;
  };
}

function tokens(value: string | number | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TOKEN_SETTING) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_TOKEN_SETTING}`);
  }
  return parsed;
}

export function normalizeGatewayBaseURL(baseUrl: string, api: 'openai-completions' | 'anthropic-messages'): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('DSH_BASE_URL must be a valid http(s) base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('DSH_BASE_URL must use http(s), without credentials, query parameters or a fragment');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (/\/(chat\/completions|messages|responses)$/.test(path)) throw new Error('DSH_BASE_URL must name an API base, not an individual model endpoint');
  if (api === 'openai-completions' && !path) path = '/v1';
  // Anthropic's installed SDK concatenates the configured base with /v1/messages.
  if (api === 'anthropic-messages' && path.endsWith('/v1')) path = path.slice(0, -3);
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function resolveDshProvider(input: DshProviderInput): DshProviderConfiguration {
  const configuredProvider = input.provider || 'deepseek-official';
  const provider = configuredProvider === 'deepseek' ? 'deepseek-official' : configuredProvider;
  const compatible = provider === 'openai-compatible' || provider === 'anthropic-compatible';
  const model = input.model || (compatible ? '' : 'deepseek-v4-flash');
  if (!model || model.trim() !== model || /[\u0000-\u001f\u007f]/.test(model) || model.length > 512) {
    throw new Error('DSH_MODEL must be a non-empty model ID without surrounding whitespace or control characters');
  }
  const contextWindow = tokens(input.contextWindow, 'DSH_CONTEXT_WINDOW');
  const maxTokens = tokens(input.maxTokens, 'DSH_MAX_TOKENS');
  if (contextWindow !== undefined && maxTokens !== undefined && maxTokens > contextWindow) throw new Error('DSH_MAX_TOKENS cannot exceed DSH_CONTEXT_WINDOW');
  if (!compatible) {
    if (input.baseUrl) throw new Error('DSH_BASE_URL requires DSH_PROVIDER=openai-compatible or anthropic-compatible');
    return { provider, model, ...(maxTokens !== undefined ? { maxTokens } : {}) };
  }
  if (!input.baseUrl) throw new Error('DSH_BASE_URL is required for a compatible gateway provider');
  const api = provider === 'openai-compatible' ? 'openai-completions' : 'anthropic-messages';
  const gateway = {
    api,
    baseURL: normalizeGatewayBaseURL(input.baseUrl, api),
    contextWindow: contextWindow ?? 131_072,
    maxTokens: maxTokens ?? 8_192,
  } as const;
  if (gateway.maxTokens > gateway.contextWindow) throw new Error('DSH_MAX_TOKENS cannot exceed DSH_CONTEXT_WINDOW');
  return { provider: GATEWAY_PROVIDER, model, maxTokens: gateway.maxTokens, gateway };
}

/** No credential is written into a profile file; DSH resolves only this named environment reference. */
export function dshProviderEnvironment(config: DshProviderConfiguration, apiKey: string): NodeJS.ProcessEnv {
  if (!config.gateway) return { DEEPSEEK_API_KEY: apiKey };
  return {
    CLOUD_WORK_GATEWAY_API_KEY: apiKey,
    CLOUD_WORK_GATEWAY_API: config.gateway.api,
    CLOUD_WORK_GATEWAY_BASE_URL: config.gateway.baseURL,
    CLOUD_WORK_GATEWAY_MODEL: config.model,
    CLOUD_WORK_GATEWAY_CONTEXT_WINDOW: String(config.gateway.contextWindow),
    CLOUD_WORK_GATEWAY_MAX_TOKENS: String(config.gateway.maxTokens),
  };
}
