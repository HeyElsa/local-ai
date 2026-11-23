// Stand-ins for Infero and OpenRouter, shaped like their documented APIs, so
// routing between providers can be tested without keys or cost.
import http from 'node:http';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

function serve(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const type = req.headers['content-type'] || '';
    const body = type.startsWith('application/json') && raw.length ? JSON.parse(raw.toString()) : null;
    const request = { method: req.method, url: req.url, auth: req.headers.authorization, type, body, raw };
    requests.push(request);
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    const stream = (headers, usage = {}) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello from the provider.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { cost: 0.001, ...usage } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const audio = () => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(Buffer.from('fake-mp3')); };
    await handler({ req, res, request, json, stream, audio });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

export function startInfero({ failModels = false } = {}) {
  return serve(({ request, json, stream, audio }) => {
    const { url, body } = request;
    if (url === '/models') {
      if (failModels) return json(500, { error: 'down' });
      return json(200, { object: 'list', data: [
        { id: 'deepseek-v4-flash', kind: 'chat', owned_by: 'infero', price_in: 0.095, price_out: 0.191, price_unit: '1M tokens', vision: false },
        { id: 'llama-4-scout', kind: 'chat', owned_by: 'infero', price_in: 0.1, price_out: 0.3, price_unit: '1M tokens', vision: true },
        { id: 'z-image-turbo', kind: 'image', owned_by: 'infero', price_in: 0.0106, price_out: 0, price_unit: 'image', vision: false },
        { id: 'whisper-large-v3-turbo', kind: 'transcription', owned_by: 'infero', price_in: 0.0007, price_unit: 'audio minute' },
        { id: 'kokoro', kind: 'speech', owned_by: 'infero', price_in: 1.05, price_unit: '1M characters' },
      ] });
    }
    if (url === '/chat/completions') {
      if (body.model === 'broken') return json(402, { error: { message: 'Balance exhausted' } });
      return stream({ 'x-infero-balance-usd': '7.50', 'x-infero-provider': 'deepinfra' });
    }
    if (url === '/images/generations') return json(200, { created: 1, data: [{ b64_json: PNG }] });
    if (url === '/audio/transcriptions') return json(200, { text: ' From Infero. ' });
    if (url === '/audio/speech') return audio();
    return json(404, { error: 'not found' });
  });
}

export function startOpenRouter() {
  return serve(({ request, json, stream, audio }) => {
    const { url } = request;
    if (url === '/models') {
      return json(200, { data: [
        { id: 'openrouter/auto', name: 'Auto Router', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: [] },
        { id: 'meta-llama/llama-4', name: 'Llama 4', context_length: 128000, pricing: { prompt: '0.0000002', completion: '0.0000006' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
      ] });
    }
    if (url === '/models?output_modalities=image') {
      return json(200, { data: [
        { id: 'google/gemini-2.5-flash-image', name: 'Gemini Flash Image', pricing: { prompt: '0.0000003', completion: '0.0000025' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['image', 'text'] }, supported_parameters: [] },
      ] });
    }
    if (url === '/chat/completions') return stream({}, { server_tool_use_details: { web_search_requests: 2 } });
    if (url === '/images') return json(200, { created: 1, data: [{ b64_json: PNG, media_type: 'image/png' }], usage: { cost: 0.039 } });
    if (url === '/audio/transcriptions') return json(200, { text: 'From OpenRouter.', usage: { cost: 0.0001 } });
    if (url === '/audio/speech') return audio();
    return json(404, { error: 'not found' });
  });
}
