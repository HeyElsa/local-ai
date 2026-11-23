# Security

## Reporting a problem

Please report security problems privately, not in a public issue. On the repository page, open the **Security** tab and choose **Report a vulnerability**. That starts a private report only the maintainers can see.

Say what you found, how to reproduce it, and which version or commit you tested. We handle reports on a best-effort basis and will tell you when a fix is out. Please give us a reasonable time to fix a problem before you describe it publicly.

Only the latest version on the `main` branch is supported.

## How Local AI protects you

- **It listens on this computer only** (`127.0.0.1`), and refuses requests whose `Host` or `Origin` is not its own. This stops other websites, including ones that use DNS rebinding.
- **A 4-number passcode is always required.** Chats, files, settings and keys can be reached only by a browser that has entered the passcode. Checking where a request came from stops websites, but any program on the computer can fake that, so it is not relied on alone. The first passcode can be chosen only with a setup code shown in the terminal where the app was started.
- **Chats and files are encrypted on disk** with AES-256-GCM. The key is protected by your passcode using scrypt, and is held in memory only while the app is unlocked.
- **The page can connect only to the app** (`connect-src 'self'`), can load no remote images, and runs no inline scripts. A model's answer is sanitised before it is shown.
- **Every cloud request passes one gate**, so Private mode blocks all of them.
- **A provider cannot point the app at your own network.** A link a provider sends must be a public `https` address, every redirect is checked, and what comes back must be an image.
- **Keys never reach the page.** They stay in `.env`, readable only by your user account.

## What it does not protect against

- Malware or another person using **your own user account**, which can read `.env` and, while the app is unlocked, its memory.
- Browser extensions with access to the page.
- What a provider does with the messages you send it.
- Someone who copies your `data` folder. The passcode is 4 numbers. Through the app that is enough, because wrong guesses are locked out for longer each time. But someone with a copy of the files can try all 10,000 codes on their own computer in under an hour, so the encryption does not protect files that have been copied. Use your computer's own disk encryption for that.
- Provider keys in `.env` are not encrypted, so they work without the passcode for anyone who can read that file.

The dependencies are checked with `npm audit`, and the tests in `test/` cover the protections above, using fake providers.
