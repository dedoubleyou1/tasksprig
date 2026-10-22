import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import type { StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelSettings, Provider } from '../../shared/types';

export const DEFAULT_MODELS: Record<Provider, string> = {
  demo: '', anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.4-mini', google: 'gemma-4-26b-a4b-it',
};

export interface ModelAdapter {
  model: Model<Api>;
  streamFn: StreamFn;
  thinkingLevel: ThinkingLevel;
  getApiKey: () => string;
}

/** Provider-specific wiring stays here; task tools, scheduling and agent behavior are model agnostic. */
export function createModelAdapter(settings: ModelSettings): ModelAdapter {
  if (settings.provider === 'demo') throw new Error('Demo mode does not use a model adapter.');
  if (!settings.apiKey.trim()) throw new Error('Add an API key in Model settings, or switch to the labelled demo mode.');
  const models = createModels();
  const factories = { anthropic: anthropicProvider, openai: openaiProvider, google: googleProvider };
  models.setProvider(factories[settings.provider]());
  const modelId = settings.model.trim() || DEFAULT_MODELS[settings.provider];
  let model = models.getModel(settings.provider, modelId);
  // Keep the model field open to newly released Google IDs without requiring a Pi catalog update.
  if (!model && settings.provider === 'google') {
    model = {
      id: modelId, name: modelId, provider: 'google', api: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta', input: ['text'],
      reasoning: /gemma-?4|gemini/.test(modelId),
      ...(/gemma-?4/.test(modelId) ? { thinkingLevelMap: { minimal: 'MINIMAL', high: 'HIGH', off: null } } : {}),
      // These are conservative request limits, not a pricing or model-capability claim.
      contextWindow: 32768, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }
  if (!model) throw new Error(`Pi does not recognize ${settings.provider}/${modelId}. Choose a catalog model in settings.`);
  return {
    model,
    streamFn: (target, context, options) => models.streamSimple(target, context, {
      ...options, apiKey: settings.apiKey.trim(), maxTokens: 8192,
    }),
    thinkingLevel: /gemma-?4/.test(modelId) ? 'minimal' : settings.provider === 'openai' ? 'low' : 'off',
    getApiKey: () => settings.apiKey.trim(),
  };
}
