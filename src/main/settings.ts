import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelSettings, Provider, PublicSettings } from '../shared/types';
const DEFAULT_MODELS: Record<Provider, string> = {
  demo: '', anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.4-mini', google: 'gemma-4-26b-a4b-it',
};
export class SettingsStore {
  private current: ModelSettings = { provider: 'demo', model: '', apiKey: '' };
  private keys: Partial<Record<Provider, string>> = {};
  constructor(private dataDir: string) {}
  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'settings.json'), 'utf8'));
      if (!Object.hasOwn(DEFAULT_MODELS, saved.provider)) return;
      this.current.provider = saved.provider;
      this.current.model = saved.model || DEFAULT_MODELS[this.current.provider];
      if (await safeStorage.isAsyncEncryptionAvailable()) {
        const encryptedKeys = saved.encryptedKeys || (saved.encryptedKey ? { [saved.provider]: saved.encryptedKey } : {});
        for (const provider of ['anthropic', 'openai', 'google'] as const) {
          if (encryptedKeys[provider]) this.keys[provider] = (await safeStorage.decryptStringAsync(Buffer.from(encryptedKeys[provider], 'base64'))).result;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not restore model settings; configure them in the app.');
    }
  }
  private envKey(provider: Provider) {
    return provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY
      : provider === 'openai' ? process.env.OPENAI_API_KEY
      : provider === 'google' ? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) : '';
  }
  get(): ModelSettings { return { ...this.current, apiKey: this.keys[this.current.provider] || this.envKey(this.current.provider) || '' }; }
  getForProvider(provider: Provider): ModelSettings {
    return { provider, model: this.current.provider === provider ? this.current.model : DEFAULT_MODELS[provider], apiKey: this.keys[provider] || this.envKey(provider) || '' };
  }
  public(): PublicSettings {
    const settings = this.get();
    const configuredProviders = (['anthropic', 'openai', 'google'] as const).filter(provider => !!(this.keys[provider] || this.envKey(provider)));
    return { provider: settings.provider, model: settings.model, hasApiKey: !!settings.apiKey, configuredProviders };
  }
  async save(input: { provider: Provider; model: string; apiKey?: string }) {
    if (!Object.hasOwn(DEFAULT_MODELS, input.provider)) throw new Error('Unknown model provider');
    if (input.apiKey && input.apiKey.length > 10000) throw new Error('API key is too long');
    const apiKey = input.apiKey?.trim() || this.keys[input.provider] || '';
    const next = { provider: input.provider, model: input.model?.trim() || DEFAULT_MODELS[input.provider], apiKey };
    const keys = { ...this.keys };
    if (apiKey && input.provider !== 'demo') keys[input.provider] = apiKey;
    const encryptedKeys: Partial<Record<Provider, string>> = {};
    for (const provider of ['anthropic', 'openai', 'google'] as const) {
      if (keys[provider]) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('macOS credential encryption is unavailable. Use a provider environment variable for this session.');
        encryptedKeys[provider] = (await safeStorage.encryptStringAsync(keys[provider]!)).toString('base64');
      }
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const target = path.join(this.dataDir, 'settings.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify({ provider: next.provider, model: next.model, encryptedKeys }), { mode: 0o600 });
    await fs.rename(`${target}.tmp`, target);
    this.current = next;
    this.keys = keys;
    return this.public();
  }
}
