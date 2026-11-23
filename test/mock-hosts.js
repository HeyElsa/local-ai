// One stand-in for Groq, Cerebras, Together, Fireworks, DeepInfra and a custom
// endpoint. Each lives under its own path, shaped like its documented catalogue.
import http from 'node:http';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

const CATALOGS = {
  '/groq/models': { object: 'list', data: [
    { id: 'llama-3.3-70b-versatile', owned_by: 'Meta', active: true, context_window: 131072 },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', owned_by: 'Meta', active: true, context_window: 131072 },
    { id: 'whisper-large-v3-turbo', owned_by: 'OpenAI', active: true },
    { id: 'retired-model', owned_by: 'Meta', active: false },
  ] },
  '/cerebras/models': { object: 'list', data: [{ id: 'gpt-oss-120b', object: 'model', created: 0, owned_by: 'Cerebras' }] },
  // Together answers with a bare list.
  '/together/models': [
    { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', display_name: 'Llama 3.3 70B', organization: 'Meta', context_length: 131072, pricing: { input: 0.88, output: 0.88 } },
    { id: 'black-forest-labs/FLUX.1-schnell', type: 'image', display_name: 'FLUX.1 Schnell', organization: 'Black Forest Labs', pricing: { base: 0.0027 } },
    { id: 'BAAI/bge-large-en-v1.5', type: 'embedding' },
  ],
  '/fireworks/models': { data: [
    { id: 'accounts/fireworks/models/kimi-k3', display_name: 'Kimi K3', supports_chat: true, supports_image_input: false, context_length: 262144 },
    { id: 'accounts/fireworks/models/qwen3-embedding', supports_chat: false, kind: 'EMBEDDING_MODEL' },
  ] },
  '/deepinfra/v1/models': { object: 'list', data: [
    { id: 'zai-org/GLM-5.3-Flash', owned_by: 'zai-org', metadata: { context_length: 1048576, pricing: { input_tokens: 0.15, output_tokens: 0.49999999999999994 }, tags: ['chat', 'vlm', 'vision'] } },
    { id: 'black-forest-labs/FLUX-2-klein-9b', metadata: { pricing: { per_image_unit: 0.003 }, tags: ['image-gen'] } },
    { id: 'openai/whisper-large-v3-turbo', metadata: { pricing: { input_seconds: 0.0002 }, tags: ['stt'] } },
  ] },
  '/custom/v1/models': { object: 'list', data: [{ id: 'my-model', owned_by: 'me' }] },
};

export function startHosts() {
  const requests = [];
  let url;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] || '';
    const body = type.startsWith('application/json') && raw.length ? JSON.parse(raw.toString()) : null;
    const host = req.url.split('/')[1];
    requests.push({ host, method: req.method, url: req.url, auth: req.headers.authorization, type, body, raw });
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };

    if (CATALOGS[req.url]) return json(200, CATALOGS[req.url]);
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Thinking. ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Hello from ${host}.` }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    // Together hands back a link to the picture; DeepInfra sends it inline.
    if (req.url === '/together/images/generations') return json(200, { data: [{ url: `${url}/files/picture.png` }] });
    if (req.url === '/files/picture.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from(PNG, 'base64')); }
    if (req.url === '/deepinfra/v1/openai/images/generations') return json(200, { data: [{ b64_json: PNG }] });
    if (req.url.endsWith('/audio/transcriptions')) return json(200, { text: ` From ${host}. ` });
    if (req.url.endsWith('/audio/speech')) { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('fake-mp3')); }
    return json(404, { error: { message: `No route ${req.url}` } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      url = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, requests, url });
    });
  });
}
