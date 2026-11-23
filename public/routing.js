// Which cloud provider a model belongs to, and where a question really goes.
// The server and the page both use this file, so the line under the message box
// always matches what the server does.

// In order of preference: Infero is the main provider, the others fill its gaps.
export const PROVIDERS = [
  {
    id: 'infero', name: 'Infero', prefix: 'infero:',
    keyUrl: 'https://console.infero.xyz/login', placeholder: 'sk-infero-...', keyHint: 'Infero keys start with sk-infero-.',
    supports: { search: false, image: true, video: false, transcribe: true, speak: true },
    autoModel: null,
  },
  {
    id: 'minirouter', name: 'MiniRouter', prefix: '',
    keyUrl: 'https://minirouter.sh/key', placeholder: 'mr-live-...', keyHint: 'MiniRouter keys start with mr-live-.',
    supports: { search: true, image: true, video: true, transcribe: true, speak: true },
    autoModel: 'minirouter/auto',
  },
  {
    id: 'openrouter', name: 'OpenRouter', prefix: 'openrouter:',
    keyUrl: 'https://openrouter.ai/settings/keys', placeholder: 'sk-or-...', keyHint: 'OpenRouter keys start with sk-or-.',
    supports: { search: true, image: true, video: false, transcribe: true, speak: true },
    autoModel: 'openrouter:openrouter/auto',
  },
  // Secondary providers below are shown under "More providers" in Settings.
  {
    id: 'groq', name: 'Groq', prefix: 'groq:', more: true, role: 'Very fast open-weight models',
    keyUrl: 'https://console.groq.com/keys', placeholder: 'Groq API key', keyHint: 'Copy the key from console.groq.com/keys.',
    supports: { search: false, image: false, video: false, transcribe: true, speak: true },
    autoModel: null,
  },
  {
    id: 'cerebras', name: 'Cerebras', prefix: 'cerebras:', more: true, role: 'Very fast open-weight models',
    keyUrl: 'https://cloud.cerebras.ai', placeholder: 'Cerebras API key', keyHint: 'Copy the key from cloud.cerebras.ai, under API Keys.',
    supports: { search: false, image: false, video: false, transcribe: false, speak: false },
    autoModel: null,
  },
  {
    id: 'together', name: 'Together AI', prefix: 'together:', more: true, role: 'Open-weight models and image models',
    keyUrl: 'https://api.together.ai/settings/projects/~current/api-keys', placeholder: 'Together API key', keyHint: 'Copy the key from your Together project settings.',
    supports: { search: false, image: true, video: false, transcribe: true, speak: true },
    autoModel: null,
  },
  {
    id: 'fireworks', name: 'Fireworks', prefix: 'fireworks:', more: true, role: 'Open-weight models',
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys', placeholder: 'Fireworks API key', keyHint: 'Copy the key from app.fireworks.ai, under API keys.',
    supports: { search: false, image: false, video: false, transcribe: false, speak: false },
    autoModel: null,
  },
  {
    id: 'deepinfra', name: 'DeepInfra', prefix: 'deepinfra:', more: true, role: 'Open-weight models and image models',
    keyUrl: 'https://deepinfra.com/dash/keys', placeholder: 'DeepInfra API key', keyHint: 'Copy the key from deepinfra.com/dash/keys.',
    supports: { search: false, image: true, video: false, transcribe: true, speak: true },
    autoModel: null,
  },
  {
    id: 'custom', name: 'Custom endpoint', prefix: 'custom:', more: true, custom: true, role: 'Any OpenAI-compatible server',
    keyUrl: '', placeholder: 'Key, if it needs one', keyHint: '',
    supports: { search: false, image: false, video: false, transcribe: false, speak: false },
    autoModel: null,
  },
];

export const isLocalId = (id) => String(id || '').startsWith('local/');
export const providerById = (id) => PROVIDERS.find((p) => p.id === id);

// MiniRouter IDs have no prefix, so chats saved before other providers existed still work.
export function providerOf(id) {
  const text = String(id || '');
  return PROVIDERS.find((p) => p.prefix && text.startsWith(p.prefix)) || providerById('minirouter');
}

export const upstreamId = (id) => String(id).slice(providerOf(id).prefix.length);
export const isAutoModel = (id) => PROVIDERS.some((p) => p.autoModel === id);

// The first provider with a key that can do this job, in order of preference.
export const firstWith = (job, keys = {}) => PROVIDERS.find((p) => keys[p.id] && p.supports[job]) || null;

// Providers that can take a question handed over for web search.
export const searchHelpers = (keys = {}) => PROVIDERS.filter((p) => p.supports.search && p.autoModel && keys[p.id]);

// Where a question goes. A provider that cannot search hands a question that
// needs search to the provider chosen in Settings, or else the first that can, and says so.
export function routeFor(id, web, { models = [], keys = {}, searchVia = 'auto' } = {}) {
  if (isLocalId(id) || !web) return { model: id, search: false };
  const provider = providerOf(id);
  if (provider.supports.search) {
    const info = models.find((m) => m.id === id);
    return { model: id, search: !info || Boolean(info.canSearch) };
  }
  const helpers = searchHelpers(keys).filter((p) => p !== provider);
  const helper = helpers.find((p) => p.id === searchVia) || helpers[0];
  if (!helper) return { model: id, search: false };
  return { model: helper.autoModel, search: true, handedOff: helper.id };
}
