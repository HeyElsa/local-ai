# Multiple cloud providers: Infero first, MiniRouter and OpenRouter second

Date: 2026-11-23. Status: approved.

## Goal

Add Infero (https://infero.xyz) as the main cloud provider. Keep MiniRouter, and add OpenRouter, as secondary providers. Infero is the default and is listed first. Secondary providers fill the gaps Infero has (web search, video). Nothing ever switches provider silently because a request failed.

## Provider capabilities

| | Infero | MiniRouter | OpenRouter |
|---|---|---|---|
| Base URL | `https://api.infero.xyz/v1` | `https://api.minirouter.sh/v1` | `https://openrouter.ai/api/v1` |
| Key | `sk-infero-…` | `mr-live-…` | `sk-or-…` |
| Chat | ✓ | ✓ | ✓ |
| Web search | ✗ | `minirouter:*` server tools | `openrouter:web_search` |
| Image | `/images/generations` | `/images/generations` | `/images` |
| Video | ✗ | ✓ | ✗ |
| Transcribe | multipart, `whisper-large-v3-turbo` | base64 JSON, `openai/whisper-1` | `input_audio` JSON, `openai/whisper-large-v3` |
| Speak | `kokoro`, Kokoro voices | `openai/tts-1`, OpenAI voices | `openai/gpt-4o-mini-tts`, OpenAI voices |
| Balance header | `x-infero-balance-usd` | `x-minirouter-balance-usd` | none |

## Design

### Provider layer
- `public/routing.js` is shared by the server and the browser. It holds provider metadata (name, ID prefix, key hints, capabilities, auto model), `providerOf(id)` and `routeFor(id, web, {models, keys})`.
- `providers.js` (server only) adds catalog parsing, search tools, image endpoints, voice request builders and balance headers for each provider.
- Model IDs carry a provider prefix: `infero:<id>` and `openrouter:<id>`. MiniRouter IDs stay unprefixed, so saved chats and model choices keep working. `local/` is unchanged.
- Keys: `INFERO_KEY`, `MINIROUTER_KEY` and `OPENROUTER_KEY` in `.env` (0600). `PUT /api/key {provider, key}`, where `provider` defaults to MiniRouter for compatibility. `/api/status` reports which providers have keys, never the keys themselves.
- Catalogs are fetched only for providers with a key, cached for each provider, and fetched independently. A provider that is down hides only its own group.
- Defaults: Ask `infero:deepseek-v4-flash`, Image `infero:z-image-turbo`, Video MiniRouter Veo. Each falls back to the next provider's auto or first model when its provider has no key.

### Routing
- `routeFor`:
  - With a local model, or with web search off, the request goes where it is addressed.
  - If the model's provider supports search, it searches if the model can (existing behaviour).
  - If the model's provider cannot search (Infero), the question is **handed off** to the first secondary with a key: `minirouter/auto`, else `openrouter:openrouter/auto`. If neither secondary has a key, it answers without search and is marked as such.
- The browser runs the same function, so the line under the message box names the real destination before you send.
- Voice uses the first provider with a key in the order Infero, MiniRouter, OpenRouter. The Settings voice list follows that provider.

### Errors and privacy
- Errors name the provider ("Infero returned 402: …"), and a 401 points to that provider's key. There is no cross-provider retry.
- `callUpstream` remains the only way out, so Private mode blocks every provider.
- Personal-detail masking applies to every cloud provider. This change also fixes the bug where a value repeated in one message got two placeholders.

### Testing
- Mock Infero and OpenRouter servers. Tests cover prefix routing, unprefixed IDs still going to MiniRouter, search handoff in each key combination, separate keys that are never echoed, voice provider choice and upload formats, Private mode blocking every provider, and one provider being down without emptying the list.
- Every existing test passes unchanged.
- One manual live check with a real Infero key confirms its stream format, reasoning field and error body, which its docs leave out.

### Out of scope
Infero's `/v1/messages` (Anthropic) endpoint, its `provider` pinning option, batch requests and per-key budgets. Also out: OpenRouter balance (it needs a management key).
