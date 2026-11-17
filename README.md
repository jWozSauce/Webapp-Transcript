# Live Transcript

A web app that listens to the microphone and shows a live, speaker-labeled
transcript of the conversation. Speech-to-text is Deepgram's `nova-3` streaming
API. Hosting is a single Cloudflare Worker that serves the static page and mints
short-lived Deepgram tokens, so the API key never reaches the browser.

Works on Mac (Safari/Chrome), iPad (Safari or Chrome, same engine) and Android
Chrome. Add it to the home screen on iPad/Android for a full-screen app.

## How it works

```
browser mic ─► AudioWorklet (16-bit PCM) ─► wss://api.deepgram.com/v1/listen
     │                                              ▲
     └── POST /api/token ─► Worker ─► Deepgram /v1/auth/grant ─ 30 s JWT ─┘
```

- Raw PCM over an AudioWorklet avoids the Safari vs Chrome MediaRecorder codec
  split, so one code path works everywhere.
- The Worker is only in the token path, not the audio path. Audio goes straight
  from the browser to Deepgram.
- Transcript text is kept in the browser's `localStorage` so a refresh does not
  lose it. Nothing is stored server-side.

## Files

| Path | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker config: static assets, custom domain, rate limiter |
| `src/worker.js` | `/api/token` (Deepgram grant), `/api/health`, static fallthrough |
| `public/index.html`, `style.css`, `app.js` | The app |
| `public/pcm-worklet.js` | AudioWorklet: Float32 → Int16 PCM chunks + level meter |
| `public/manifest.webmanifest`, `icon.svg` | PWA metadata for home-screen install |

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Log in to Cloudflare once:
   ```bash
   npx wrangler login
   ```
3. Set the Deepgram key as a Worker secret. The key needs Member permissions in
   the Deepgram console (that is what `/v1/auth/grant` requires):
   ```bash
   npx wrangler secret put DEEPGRAM_API_KEY
   ```
4. Optional: require a shared password before the app will hand out tokens.
   The browser prompts for it once and remembers it.
   ```bash
   npx wrangler secret put APP_PASSWORD
   ```
   Skip this if you would rather put Cloudflare Access (email one-time PIN) in
   front of the hostname, the same way `cbb.kainzow.app` is protected. Both can
   be used together.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # then fill in DEEPGRAM_API_KEY
npm run dev                      # http://localhost:8787
```

`localhost` counts as a secure context, so the microphone works without HTTPS.
To test from a phone or iPad on the same network use `npx wrangler dev --remote`
and open the printed `*.workers.dev` preview URL (HTTPS), since plain-IP HTTP
pages are not allowed to use the mic.

## Deploy

```bash
npm run deploy
```

The custom domain `transcript.kainzow.app` is declared in `wrangler.jsonc`.
Because `kainzow.app` is already a zone in your Cloudflare account, the first
deploy creates the DNS record and certificate automatically. The Worker is also
reachable at `transcript.<account>.workers.dev` unless you set
`workers_dev: false`.

## Deepgram options

Tunables live at the top of `public/app.js`:

- `model: nova-3`, `language: en`, `smart_format`, `diarize` (speaker labels)
- `endpointing: 300` and `utterance_end_ms: 1200` control how quickly interim
  text is finalized after a pause.
- Set `language` to `multi` for mixed-language rooms.

## Known limits

- Browsers stop capturing audio when the tab is backgrounded or the screen
  locks. The app requests a screen wake lock while listening, which keeps iPad
  and Android screens on, but there is no true background mode in a web app.
- Deepgram bills per minute of streamed audio. A 30-second token is issued
  only when you press Start; the socket stays open after the token expires.
