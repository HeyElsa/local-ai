# Privacy notice

Effective 23 November 2026.

## The short version

Local AI is open-source software from HeyElsa (Elsa AI Ltd.) that runs on your computer. The software itself has no analytics, no telemetry, no crash reporting, no advertising and no accounts. What leaves your computer goes only to the providers you choose, and only when you use them.

**HeyElsa also operates Infero, the default cloud provider.** When you use an Infero model, or Infero for images or voice, what you send goes to Infero, and so to HeyElsa. It is handled under [Infero's privacy policy](https://infero.xyz/privacy), not this notice. If you do not want HeyElsa to receive your messages, use another provider or only models on your computer, or turn on Private mode.

## What is stored on your computer

| What | Where | Notes |
| --- | --- | --- |
| Chats | `data/chats/` in the app folder | One file per chat, readable only by your user account, and encrypted with your passcode. |
| Attachments and generated images and videos | `data/media/` | Same protection as chats. Deleting a chat deletes its files. |
| Settings | `data/settings.json` | Private mode, automatic deletion, lock time and provider choices. |
| Provider keys and custom endpoint | `.env` in the app folder | Readable only by your user account. Never sent to the page, and not covered by encryption. |
| Encryption key, protected by your passcode | `data/vault.json` | Created when you choose your passcode on first run. |
| Preferences in your browser | The browser's local storage for this app | Chosen models, voices, theme, web search on or off, sidebar state, last balance, and whether you have seen the guide. No chat content. |

Voice recordings are kept in memory only while they are written down, and are never saved. In Private mode, attachments are held in memory only and nothing new is saved.

## What leaves your computer, and when

Nothing leaves your computer unless you use a feature that needs a provider. The line under the message box says where your next message goes before you send it.

- **Asking a cloud model.** Your message, the earlier messages in that chat, and any attached images or sampled video frames go to the provider that runs the model. Routers such as MiniRouter and OpenRouter pass them on to the company whose model answers. Infero passes them to the host it picks.
- **Web search.** Questions asked with web search on go to MiniRouter or OpenRouter, even if you chose a model from another provider. The app tells you before you send.
- **Images and videos.** Your description goes to the provider of the image or video model you chose.
- **Voice.** Recordings go to the provider chosen to write down speech, and answers you have read aloud go to the provider chosen to read aloud. This happens even with a local model, unless Private mode is on.
- **Model lists.** The app asks each provider you have a key for which models it offers.
- **Local models.** Questions to models on this computer go to Ollama on this computer only. Downloading a local model contacts Ollama's library, but sends none of your chats.
- **Custom endpoint.** If you set one up, questions to its models go to the address you entered.

Fonts and libraries are stored in the app, so loading the page contacts nobody. The page can connect only to the app on your computer, which stops a model's answer from loading remote images that could leak your chat.

## Providers, including Infero

Each provider decides how it handles what you send, under its own privacy policy and terms. Read each provider's policy before you add its key:

- Infero, operated by HeyElsa: [infero.xyz/privacy](https://infero.xyz/privacy). Infero's policy says it does not store the content of requests by default and does not use it to train models. Infero passes your messages to the companies that host its models, which receive them under their own terms.

Apart from Infero, HeyElsa does not control these providers and is not responsible for them:

- MiniRouter: [minirouter.sh/docs/privacy](https://minirouter.sh/docs/privacy). MiniRouter says it keeps prompts and responses in private debug traces for 30 days, with no opt-out.
- OpenRouter ([openrouter.ai](https://openrouter.ai)), Groq ([groq.com](https://groq.com)), Cerebras ([cerebras.ai](https://cerebras.ai)), Together AI ([together.ai](https://www.together.ai)), Fireworks ([fireworks.ai](https://fireworks.ai)), DeepInfra ([deepinfra.com](https://deepinfra.com)) and Ollama ([ollama.com](https://ollama.com)): see the privacy policy on each website.

## Controls

- **Private mode** blocks every cloud request in the app's server and saves nothing new.
- **Temporary chat** is not saved or listed, and its files are erased when you leave it.
- **Hide personal details**, on by default for cloud models, replaces email addresses, phone numbers, card and bank numbers, US Social Security numbers and API keys you type with placeholders, and restores them in the answer. Pattern matching can miss things. Names, addresses, images and voice are not covered.
- **Passcode and lock**, always on, encrypts chats and files on disk with AES-256-GCM using a key protected by your passcode. Nothing can use the app until the passcode is entered, including other programs and accounts on this computer.
- **Delete chats automatically** removes chats you have not used for 1, 7, 30 or 90 days.
- **Delete all chats** removes every chat and file. Your keys and settings stay.

## Limits

Browser extensions with access to the app can read what the page shows. Encryption protects files while the app is locked, not against malware running while it is unlocked. Files saved by a version from before the passcode was required may still be recoverable from backups or free disk space. Data you have sent to a provider cannot be deleted from this app. Ask the provider.

## Changes and contact

We may update this notice. The current version is the one in the repository, with its effective date at the top. Questions can be raised as an issue in the repository.
