# Local AI

A private AI chat app that runs on your computer. Answers with charts, timelines and diagrams, using local models through [Ollama](https://ollama.com) or cloud models from [Infero](https://infero.xyz), [OpenRouter](https://openrouter.ai), [Groq](https://groq.com) and more.

Infero, the main cloud provider, is run by HeyElsa, the makers of Local AI. The app can also read attached images and videos, search the web, and make images and videos.

## Start

```sh
npm install
npm start
```

Open http://localhost:4317. The first time, choose a 4-number passcode and enter the setup code that `npm start` printed in the terminal. The passcode encrypts your chats and files, and nothing can use the app without it. You enter it again each time the app restarts or locks. **A forgotten passcode cannot be recovered.**

Then paste your Infero key. Keys are saved to `.env`, readable only by your user account, and are never sent to the browser. Needs Node 20.6 or newer.

## Cloud providers

| Provider | Key | What it adds |
| --- | --- | --- |
| Infero (main) | `INFERO_KEY`, starts `sk-infero-` | Open-weight chat models, image making, voice. The default for everything it can do. |
| MiniRouter | `MINIROUTER_KEY`, starts `mr-live-` | Web search, video, and its own model catalogue. |
| OpenRouter | `OPENROUTER_KEY`, starts `sk-or-` | Web search and its own model catalogue. |
| Groq | `GROQ_KEY` | Very fast open-weight models, and voice: Whisper to write down speech, Orpheus to read aloud (6 English voices, about $0.022 per 1,000 characters). |
| Cerebras | `CEREBRAS_KEY` | Very fast open-weight models. |
| Together AI | `TOGETHER_KEY` | Open-weight models, image models, and voice. |
| Fireworks | `FIREWORKS_KEY` | Open-weight models. |
| DeepInfra | `DEEPINFRA_KEY` | Open-weight models, image models, and voice. |
| Custom endpoint | `CUSTOM_BASE_URL`, `CUSTOM_NAME`, optional `CUSTOM_KEY` | Any OpenAI-compatible server, such as a company gateway, vLLM or LiteLLM. |

You only need one key. The last six are under More providers in Settings. Groq, Cerebras, Together, Fireworks and DeepInfra run the models themselves, so your message goes only to them. The model picker groups models by provider, Infero first. Only MiniRouter and OpenRouter can search the web, so with web search on, a question asked of any other provider's model goes to MiniRouter's Auto model instead, or to OpenRouter's if you have no MiniRouter key. "Search the web with" in Settings picks between them, and "Make images with" limits Image mode to one provider. The line under the message box says so before you send. A failed request is never retried with another provider. Voice uses the first provider you have a key for that can do it, in the order the table lists them, and the voice list in Settings follows it. To pick the providers yourself, use "Write down what you say with" and "Read answers aloud with" in Settings; each reader remembers its own voice.

## What stays private

**Always on this computer:** chats, attachments, generated files and your key, in `data/` and `.env`. Deleting a chat deletes its files. The server listens only on `127.0.0.1`, rejects requests from other websites, and the page can only connect to this server. Libraries and fonts are stored locally. The line under the message box shows where your next message goes.

**Sent elsewhere when you use a cloud model:** your messages and attachments go to the provider named under the message box. Infero is run by HeyElsa, which also makes this app, so what you send to Infero models goes to HeyElsa. Infero's [privacy policy](https://infero.xyz/privacy) says it does not store request content by default and does not train on it, but the companies hosting its models have their own terms. MiniRouter says it keeps prompts and responses in private debug traces for 30 days with no opt-out ([privacy](https://minirouter.sh/docs/privacy)). OpenRouter and each model's provider have their own policies. Voice input goes to the first provider you have a key for whichever model you use, unless Private mode has turned it off. This app does not save recordings.

**Limits:** browser extensions with access to this site can read what the page shows, so use a browser profile without extensions for the most sensitive chats. Encryption protects files on disk while the app is locked, but not against malware running while it is unlocked. Your provider keys stay in `.env`, outside the encryption. Files saved by a version from before the passcode was required may remain recoverable from old backups or free disk space. See [SECURITY.md](SECURITY.md) for how the app protects you and how to report a problem.

## Privacy controls

| Control | What it does |
| --- | --- |
| Local models | Install [Ollama](https://ollama.com/download), then download a model from the model button. Answers stay on this computer, with no fallback to the cloud. Ollama's cloud-hosted models are never offered. |
| Private mode | Blocks every cloud request in the server, and stays on after a restart. Web search, Image, Video and voice input are off. Read aloud uses your computer's voices. Local voice input is not available yet. |
| Temporary chat | Not saved or listed. Its files are erased when you leave it, or the next time the server starts if the browser quit first. |
| Hide personal details | On by default for cloud models. Replaces typed email addresses, phone numbers, card and bank numbers, US Social Security numbers and API keys with placeholders, then restores them in the answer. Pattern matching can miss things. Names, addresses, images and voice are not covered. |
| Passcode and lock | Always on. Chats and files are encrypted with AES-256-GCM using a key protected by your passcode (scrypt), and every request needs a browser that has entered it, so other programs and accounts on the computer cannot use the app. It locks on restart, on request and after idle time. You can change the passcode in Settings. A forgotten passcode cannot be recovered. |
| Delete chats automatically | Removes chats that have not been updated for 1, 7, 30 or 90 days. |
| Delete everything | Removes all chats and files. Your keys and settings stay. |

## Using it

| Control | What it does |
| --- | --- |
| Ask, Image, Video | Choose what to make. Each mode remembers its own model. Image and Video show an estimated cost first. |
| Paper clip, paste or drag | Add images or videos in Ask mode. Videos are sent as up to 8 still frames, so the model does not hear audio. |
| Microphone icon | Ask out loud instead of typing. The panel shows a live waveform and timer and keeps listening through pauses until you press Stop and ask, up to an hour. It then shows the transcription, and sends your question. Cancel or Esc works at any stage. If transcription fails, your recording is kept so you can retry. Costs depend on the provider. In Image and Video modes the words wait in the box until you press Make. |
| Read aloud | Reads an answer using the voice chosen in Settings. Charts and diagrams are read by title and code is skipped. |
| Read answers aloud (Settings) | Off by default. Reads the answer back when you asked by voice. |
| Thinking | When a model shares its reasoning, it appears above the answer and collapses once the answer starts. Not every model shares it. |
| Globe icon | Orange means web search is on. When on, the model can search if it needs to, up to 3 searches per question. With an Infero model the question goes to MiniRouter or OpenRouter instead. |
| Model name | Choose from each provider's catalog, grouped by provider. The Auto models of MiniRouter and OpenRouter pick a model for you. |

Making a video from a starting image is not supported, because MiniRouter needs a public image link and these files stay local.

## Project layout

- `server.js`: local server, key handling, storage, privacy controls, and calls to Ollama and the cloud providers
- `providers.js`: what differs between the cloud providers (catalogs, search tools, images, voice)
- `public/routing.js`: which provider a model belongs to and where a question goes, shared by the server and the page
- `vault.js`: encryption for chats and files
- `safe-fetch.js`: downloads from addresses a provider chose, limited to public https addresses
- `prompt.js`: instructions that teach models to answer clearly and use visuals
- `public/`: the interface, with no build step
- `test/`: tests that use fake versions of every provider and Ollama, so they need no key and cost nothing (`npm test`)

## License and disclaimer

Local AI is open-source software from HeyElsa, released under the [MIT License](LICENSE). It is provided **as is, without warranty of any kind**. HeyElsa and the contributors are not liable for any claim, loss or damage arising from it or its use, including charges from providers, lost or unreadable data, security incidents, or reliance on AI output. The app sends nothing to HeyElsa by itself. HeyElsa also runs Infero, the default provider: what you send to Infero goes to HeyElsa and is governed by Infero's own terms and privacy policy. You can use other providers or only local models instead.

Using Local AI means you accept the [Terms of use](TERMS.md). The [Privacy notice](PRIVACY.md) explains what is stored on your computer and what leaves it. Both can also be read in the app, under Settings.

