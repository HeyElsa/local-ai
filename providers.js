// The parts of each cloud provider's API that differ. Everything here only builds
// requests and reads responses: sending goes through callUpstream in server.js,
// so Private mode applies to every provider.
import { PROVIDERS as META } from './public/routing.js';

const baseUrl = (env, fallback) => (process.env[env] || fallback).replace(/\/$/, '');
const voiceList = (pairs) => pairs.map(([id, name]) => ({ id, name }));

const OPENAI_VOICES = voiceList([
  ['alloy', 'Alloy'], ['ash', 'Ash'], ['coral', 'Coral'], ['echo', 'Echo'], ['fable', 'Fable'],
  ['nova', 'Nova'], ['onyx', 'Onyx'], ['sage', 'Sage'], ['shimmer', 'Shimmer'],
]);
// Groq's Orpheus voices, as its docs list them for the English model.
const ORPHEUS_VOICES = voiceList([
  ['autumn', 'Autumn'], ['diana', 'Diana'], ['hannah', 'Hannah'], ['austin', 'Austin'], ['daniel', 'Daniel'], ['troy', 'Troy'],
]);
const KOKORO_VOICES = voiceList([
  ['af_bella', 'Bella'], ['af_heart', 'Heart'], ['af_nicole', 'Nicole'], ['af_sarah', 'Sarah'], ['af_sky', 'Sky'],
  ['am_adam', 'Adam'], ['am_michael', 'Michael'], ['bf_emma', 'Emma, British'], ['bf_isabella', 'Isabella, British'],
  ['bm_george', 'George, British'], ['bm_lewis', 'Lewis, British'],
]);

// Fields every model in the app has, so the page can treat all providers alike.
const blank = { context: undefined, input: 0, output: 0, seesImages: false, canSearch: false, imagePrice: 0, imageRequired: {}, videoPrices: [], videoControls: null };
const price = (value) => Math.max(0, Number(value) || 0); // Routers report -1 when the price depends on the model they pick.

const infero = {
  base: baseUrl('INFERO_BASE_URL', 'https://api.infero.xyz/v1'),
  envKey: 'INFERO_KEY',
  balanceHeader: 'x-infero-balance-usd',
  catalogPaths: ['/models'],
  parseModels([{ data = [] }]) {
    return data.filter((m) => m.kind === 'chat' || m.kind === 'image').map((m) => ({
      ...blank, id: `infero:${m.id}`, name: m.name || m.id, provider: m.owned_by || 'infero', via: 'infero', kind: m.kind,
      // Chat prices are per million tokens; image prices are per image.
      input: m.kind === 'chat' ? price(m.price_in) / 1e6 : 0,
      output: m.kind === 'chat' ? price(m.price_out) / 1e6 : 0,
      imagePrice: m.kind === 'image' ? Math.max(price(m.price_in), price(m.price_out)) : 0,
      seesImages: Boolean(m.vision),
    }));
  },
  searchBody: null,
  imagePath: '/images/generations',
  imageBody: (model, prompt) => ({ model, prompt, n: 1, response_format: 'b64_json' }),
  voices: KOKORO_VOICES,
  transcribeBody(audio) {
    const form = new FormData();
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
    return { form };
  },
  speakBody: (input, voice) => ({ model: 'kokoro', input, voice, response_format: 'mp3' }),
};

const minirouter = {
  base: baseUrl('MINIROUTER_BASE_URL', 'https://api.minirouter.sh/v1'),
  envKey: 'MINIROUTER_KEY',
  balanceHeader: 'x-minirouter-balance-usd',
  servedHeader: 'x-minirouter-model',
  costHeader: 'x-minirouter-cost-usd',
  catalogPaths: ['/models'],
  parseModels([{ data = [] }]) {
    return data.filter((m) => ['language', 'image', 'video'].includes(m.type)).filter((m) => (
      m.type !== 'language' || !m.modalities || m.modalities.output?.includes('text')
    )).map((m) => {
      const router = m.id.startsWith('minirouter/');
      return {
        ...blank, id: m.id, name: m.name || m.id, provider: m.owned_by, via: 'minirouter',
        kind: m.type === 'language' ? 'chat' : m.type,
        context: m.context_window,
        input: Number(m.pricing?.input) || 0, output: Number(m.pricing?.output) || 0,
        seesImages: router || Boolean(m.modalities?.input?.includes('image')),
        canSearch: router || Boolean(m.tags?.includes('tool-use')),
        imagePrice: Number(m.pricing?.image) || 0,
        imageRequired: m.image?.controls?.required || {},
        videoPrices: m.pricing?.prices || [],
        videoControls: m.video?.controls || null,
      };
    });
  },
  searchBody: () => ({
    tools: [
      { type: 'minirouter:google_search', parameters: { max_uses: 3, max_results: 5 } },
      { type: 'minirouter:web_fetch', parameters: { max_uses: 3, max_content_tokens: 8000 } },
      { type: 'minirouter:datetime' },
    ],
    max_tool_calls: 6,
  }),
  imagePath: '/images/generations',
  imageBody: (model, prompt, required) => ({ model, prompt, n: 1, ...required }),
  voices: OPENAI_VOICES,
  transcribeBody: (audio) => ({ json: { model: 'openai/whisper-1', media_type: 'audio/wav', response_format: 'json', audio: audio.toString('base64') } }),
  speakBody: (input, voice) => ({ model: 'openai/tts-1', input, voice, response_format: 'mp3' }),
};

const openrouter = {
  base: baseUrl('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  envKey: 'OPENROUTER_KEY',
  catalogPaths: ['/models', '/models?output_modalities=image'],
  parseModels([chat, image]) {
    const shape = (m, kind) => ({
      ...blank, id: `openrouter:${m.id}`, name: m.name || m.id, provider: m.id.split('/')[0], via: 'openrouter', kind,
      context: m.context_length || undefined,
      input: kind === 'chat' ? price(m.pricing?.prompt) : 0,
      output: kind === 'chat' ? price(m.pricing?.completion) : 0,
      seesImages: kind === 'chat' && Boolean(m.architecture?.input_modalities?.includes('image')),
      canSearch: kind === 'chat' && (m.id === 'openrouter/auto' || Boolean(m.supported_parameters?.includes('tools'))),
    });
    const outputs = (m) => m.architecture?.output_modalities || ['text'];
    return [
      ...(chat?.data || []).filter((m) => outputs(m).includes('text')).map((m) => shape(m, 'chat')),
      ...(image?.data || []).filter((m) => outputs(m).includes('image')).map((m) => shape(m, 'image')),
    ];
  },
  searchBody: () => ({ tools: [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_uses: 3 } }] }),
  imagePath: '/images',
  imageBody: (model, prompt) => ({ model, prompt, n: 1, response_format: 'b64_json' }),
  voices: OPENAI_VOICES,
  transcribeBody: (audio) => ({ json: { model: 'openai/whisper-large-v3', input_audio: { data: audio.toString('base64'), format: 'wav' } } }),
  speakBody: (input, voice) => ({ model: 'openai/gpt-4o-mini-tts', input, voice, response_format: 'mp3' }),
};

/* ---------- secondary OpenAI-compatible providers ---------- */

// Catalogues of these providers rarely say which models see images, so a model's name is the hint.
const VISION_HINT = /llama-4|vision|[-_.]vl\b|-vl-|scout|maverick|gemma-3|pixtral/i;
const NOT_CHAT = /whisper|tts|orpheus|playai|guard|embed|rerank|moderation|transcribe|asr/i;
const tidy = (n) => Number((Number(n) || 0).toPrecision(6)); // DeepInfra prices carry float noise.
const listOf = (page) => (Array.isArray(page) ? page : page?.data || page?.models || []);
const chatModel = (via, m, extra = {}) => ({
  ...blank, id: `${via}:${m.id}`, name: m.id, provider: m.owned_by || via, via, kind: 'chat',
  seesImages: VISION_HINT.test(m.id), ...extra,
});
// Speech-to-text as a file upload, the format most OpenAI-compatible providers take.
const fileUpload = (model) => (audio) => {
  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'json');
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
  return { form };
};
const kokoro = (model) => ({
  voices: KOKORO_VOICES,
  speakBody: (input, voice) => ({ model, input, voice, response_format: 'mp3' }),
});

const groq = {
  base: baseUrl('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
  envKey: 'GROQ_KEY',
  catalogPaths: ['/models'],
  parseModels: ([page]) => listOf(page)
    .filter((m) => m.active !== false && !NOT_CHAT.test(m.id))
    .map((m) => chatModel('groq', m, { context: m.context_window })),
  transcribeBody: fileUpload('whisper-large-v3-turbo'),
  // Orpheus only makes WAV, and reads at most 200 characters per request.
  voices: ORPHEUS_VOICES,
  speakLimit: 200,
  speakBody: (input, voice) => ({ model: 'canopylabs/orpheus-v1-english', input, voice, response_format: 'wav' }),
};

const cerebras = {
  base: baseUrl('CEREBRAS_BASE_URL', 'https://api.cerebras.ai/v1'),
  envKey: 'CEREBRAS_KEY',
  catalogPaths: ['/models'],
  parseModels: ([page]) => listOf(page).filter((m) => !NOT_CHAT.test(m.id)).map((m) => chatModel('cerebras', m)),
};

const together = {
  base: baseUrl('TOGETHER_BASE_URL', 'https://api.together.ai/v1'),
  envKey: 'TOGETHER_KEY',
  catalogPaths: ['/models'],
  parseModels: ([page]) => listOf(page).flatMap((m) => {
    const type = String(m.type || 'chat').toLowerCase();
    const shared = { name: m.display_name || m.id, provider: m.organization || m.id.split('/')[0], context: m.context_length || undefined };
    if (type === 'image') return [{ ...blank, ...shared, id: `together:${m.id}`, via: 'together', kind: 'image', imagePrice: tidy(m.pricing?.base) }];
    if (!['chat', 'language', 'code', 'vision'].includes(type) || NOT_CHAT.test(m.id)) return [];
    return [chatModel('together', m, {
      ...shared,
      input: tidy(m.pricing?.input) / 1e6, output: tidy(m.pricing?.output) / 1e6, // per million tokens
      seesImages: type === 'vision' || VISION_HINT.test(m.id),
    })];
  }),
  imagePath: '/images/generations',
  // Its docs disagree on the response_format value, so the default is used: a link or base64, both handled.
  imageBody: (model, prompt) => ({ model, prompt, n: 1 }),
  transcribeBody: fileUpload('openai/whisper-large-v3'),
  ...kokoro('hexgrad/Kokoro-82M'),
};

const fireworks = {
  base: baseUrl('FIREWORKS_BASE_URL', 'https://api.fireworks.ai/inference/v1'),
  envKey: 'FIREWORKS_KEY',
  catalogPaths: ['/models'],
  parseModels: ([page]) => listOf(page).map((m) => ({ ...m, id: m.id || m.name })).filter((m) => (
    m.id && m.supports_chat !== false && !/EMBEDDING/i.test(m.kind || '') && !NOT_CHAT.test(m.id)
  )).map((m) => chatModel('fireworks', m, {
    name: m.display_name || m.displayName || m.id.split('/').pop(),
    provider: 'fireworks',
    context: m.context_length || m.contextLength || undefined,
    seesImages: Boolean(m.supports_image_input ?? m.supportsImageInput ?? VISION_HINT.test(m.id)),
  })),
};

// DeepInfra serves chat under /v1/openai, but its catalogue and audio sit under /v1.
const deepinfraRoot = () => deepinfra.base.replace(/\/openai$/, '');
const deepinfra = {
  base: baseUrl('DEEPINFRA_BASE_URL', 'https://api.deepinfra.com/v1/openai'),
  envKey: 'DEEPINFRA_KEY',
  catalogUrls: () => [`${deepinfraRoot()}/models`],
  parseModels: ([page]) => listOf(page).flatMap((m) => {
    const tags = m.metadata?.tags || [];
    const pricing = m.metadata?.pricing || {};
    if (tags.includes('image-gen')) {
      return [{ ...blank, id: `deepinfra:${m.id}`, name: m.id, provider: m.id.split('/')[0], via: 'deepinfra', kind: 'image', imagePrice: tidy(pricing.per_image_unit) }];
    }
    if (!tags.includes('chat')) return [];
    return [chatModel('deepinfra', m, {
      provider: m.owned_by || m.id.split('/')[0],
      context: m.metadata?.context_length || undefined,
      input: tidy(pricing.input_tokens) / 1e6, output: tidy(pricing.output_tokens) / 1e6,
      seesImages: tags.includes('vision'),
    })];
  }),
  imagePath: '/images/generations',
  imageBody: (model, prompt) => ({ model, prompt, n: 1, response_format: 'b64_json' }),
  transcribeUrl: () => `${deepinfraRoot()}/audio/transcriptions`,
  transcribeBody: fileUpload('openai/whisper-large-v3-turbo'),
  speakUrl: () => `${deepinfraRoot()}/audio/speech`,
  ...kokoro('hexgrad/Kokoro-82M'),
};

// Any OpenAI-compatible server you set up in Settings. server.js fills in its address and name.
const custom = {
  base: '',
  envKey: 'CUSTOM_KEY',
  catalogPaths: ['/models'],
  // What it can see is unknown, so images are allowed and the server will say if it cannot.
  parseModels: ([page]) => listOf(page).filter((m) => m.id && !NOT_CHAT.test(m.id))
    .map((m) => chatModel('custom', m, { provider: m.owned_by || 'custom', seesImages: true })),
};

const ADAPTERS = { infero, minirouter, openrouter, groq, cerebras, together, fireworks, deepinfra, custom };

// Shared metadata and server-only details, in order of preference.
export const PROVIDERS = META.map((meta) => ({ ...meta, ...ADAPTERS[meta.id] }));
export const provider = (id) => PROVIDERS.find((p) => p.id === id);
