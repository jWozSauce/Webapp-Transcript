// Cloudflare Worker: serves the static app and mints short-lived Deepgram tokens.
//
// The real Deepgram API key never leaves this Worker. The browser asks
// /api/token, gets a JWT that lives ~30 seconds, and opens its own WebSocket
// straight to Deepgram with it. The Worker is not in the audio path.

const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

// Constant-time-ish string compare so password checks don't leak length/timing.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function handleToken(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

  if (env.RATE_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  }

  if (env.APP_PASSWORD) {
    const supplied = request.headers.get('x-app-password') || '';
    if (!safeEqual(supplied, env.APP_PASSWORD)) {
      return json({ error: 'unauthorized', password_required: true }, 401);
    }
  }

  if (!env.DEEPGRAM_API_KEY) {
    return json({ error: 'server_misconfigured', detail: 'DEEPGRAM_API_KEY secret is not set' }, 500);
  }

  const upstream = await fetch(DEEPGRAM_GRANT_URL, {
    method: 'POST',
    headers: {
      authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      'content-type': 'application/json',
    },
    // Short TTL: the token only has to be valid while the WebSocket opens.
    body: JSON.stringify({ ttl_seconds: 30 }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: 'deepgram_grant_failed', status: upstream.status, detail: detail.slice(0, 500) }, 502);
  }

  const { access_token, expires_in } = await upstream.json();
  return json({ access_token, expires_in });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/token') return handleToken(request, env);
    if (url.pathname === '/api/health') return json({ ok: true, password_required: Boolean(env.APP_PASSWORD) });
    if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);

    return env.ASSETS.fetch(request);
  },
};
