/* Live Transcript — browser client.
 *
 * Flow: mic -> AudioWorklet (16-bit PCM) -> WebSocket straight to Deepgram.
 * The Worker at /api/token mints a 30-second JWT; the real API key never
 * reaches the browser. Works the same on Mac, iPad (Safari/Chrome) and Android.
 */
(() => {
  'use strict';

  const DG_URL = 'wss://api.deepgram.com/v1/listen';
  const DG_PARAMS = {
    model: 'nova-3',
    language: 'en',
    encoding: 'linear16',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    diarize: 'true',
    endpointing: '300',
    utterance_end_ms: '1200',
  };
  const KEEPALIVE_MS = 8000;
  const MAX_RECONNECTS = 3;
  const STORAGE_KEY = 'transcript.segments.v1';
  const PASSWORD_KEY = 'transcript.password';
  const GAIN_KEY = 'transcript.gainDb';
  const METER_FLOOR_DB = -60;   // left edge of the meter
  const CLIP_PEAK = 0.985;      // peak sample level treated as clipping

  // ---- DOM -----------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    start: $('startBtn'), stop: $('stopBtn'), copy: $('copyBtn'), download: $('downloadBtn'), clear: $('clearBtn'),
    segments: $('segments'), interim: $('interim'), empty: $('emptyHint'), transcript: $('transcript'),
    status: $('statusText'), dot: $('statusDot'), banner: $('banner'),
    meter: $('meter'), meterFill: $('meterFill'), meterPeak: $('meterPeak'), meterDb: $('meterDb'),
    gain: $('gain'), gainValue: $('gainValue'),
  };

  // ---- State ---------------------------------------------------------------
  let segments = loadSegments();      // [{speaker: number|null, text: string, t: epochMs}]
  let listening = false;
  let stream = null, audioCtx = null, workletNode = null, source = null, gainNode = null;
  let ws = null, keepAliveTimer = null, reconnects = 0;
  let pendingAudio = [];             // chunks captured before the socket opened
  let wakeLock = null;
  let stickToBottom = true;

  // ---- UI helpers ----------------------------------------------------------
  function setStatus(text, kind) {
    el.status.textContent = text;
    el.dot.className = 'dot' + (kind ? ' ' + kind : '');
  }
  function showBanner(msg, info) {
    el.banner.textContent = msg;
    el.banner.className = 'banner' + (info ? ' info' : '');
    el.banner.hidden = !msg;
  }
  function speakerLabel(s) { return s == null ? '' : `Speaker ${s + 1}`; }

  function renderAll() {
    el.segments.innerHTML = '';
    for (const seg of segments) el.segments.appendChild(segmentNode(seg));
    el.empty.hidden = segments.length > 0;
    scrollToBottom(true);
  }
  function segmentNode(seg) {
    const div = document.createElement('div');
    div.className = 'seg';
    if (seg.speaker != null) div.dataset.speaker = String(seg.speaker % 6);
    const who = document.createElement('div'); who.className = 'who'; who.textContent = speakerLabel(seg.speaker);
    const what = document.createElement('p'); what.className = 'what'; what.textContent = seg.text;
    div.append(who, what);
    return div;
  }
  function scrollToBottom(force) {
    if (force || stickToBottom) el.transcript.scrollTop = el.transcript.scrollHeight;
  }
  el.transcript.addEventListener('scroll', () => {
    const t = el.transcript;
    stickToBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  });

  // ---- Level meter ---------------------------------------------------------
  // Shows the signal *after* the sensitivity gain, i.e. what Deepgram hears.
  let meterLevel = 0, meterPeakPos = 0, peakHoldUntil = 0, clipUntil = 0;
  const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  const dbToPct = (db) => Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));

  function updateMeter(rms, peak) {
    const now = performance.now();
    const rmsDb = toDb(rms);
    const target = dbToPct(rmsDb);
    // Fast attack, slower release so speech reads as a steady bar, not a flicker.
    meterLevel = target > meterLevel ? target : meterLevel * 0.85 + target * 0.15;
    el.meterFill.style.setProperty('--level', `${meterLevel.toFixed(1)}%`);

    const peakPct = dbToPct(toDb(peak));
    if (peakPct >= meterPeakPos || now > peakHoldUntil) { meterPeakPos = peakPct; peakHoldUntil = now + 1200; }
    el.meterPeak.style.left = `calc(${meterPeakPos.toFixed(1)}% - 1px)`;
    el.meterPeak.style.opacity = meterPeakPos > 0 ? '1' : '0';

    if (peak >= CLIP_PEAK) clipUntil = now + 600;
    el.meter.classList.toggle('clip', now < clipUntil);

    // Readout follows the smoothed bar so the number and the bar agree.
    const shownDb = METER_FLOOR_DB + (meterLevel / 100) * -METER_FLOOR_DB;
    el.meterDb.textContent = meterLevel > 0.5 ? `${shownDb.toFixed(0)} dB` : '\u2212\u221E dB';
    el.meter.setAttribute('aria-valuenow', String(Math.round(shownDb)));
  }
  function resetMeter() {
    meterLevel = 0; meterPeakPos = 0; clipUntil = 0;
    el.meterFill.style.setProperty('--level', '0%');
    el.meterPeak.style.opacity = '0';
    el.meter.classList.remove('clip');
    el.meterDb.textContent = '\u2212\u221E dB';
  }

  // ---- Sensitivity (input gain) --------------------------------------------
  // A dB slider from -20 to +20, applied with a GainNode before the worklet.
  // Changing it while listening takes effect immediately.
  function gainDb() { return Number(el.gain.value) || 0; }
  function applyGain() {
    const db = gainDb();
    const linear = Math.pow(10, db / 20);
    el.gainValue.textContent = `${db > 0 ? '+' : ''}${db} dB`;
    if (gainNode && audioCtx) gainNode.gain.setTargetAtTime(linear, audioCtx.currentTime, 0.02);
    try { localStorage.setItem(GAIN_KEY, String(db)); } catch { /* ignore */ }
  }
  (function initGain() {
    let saved = null;
    try { saved = localStorage.getItem(GAIN_KEY); } catch { /* ignore */ }
    if (saved != null && !Number.isNaN(Number(saved))) el.gain.value = String(Math.max(-20, Math.min(20, Number(saved))));
    applyGain();
  })();
  el.gain.addEventListener('input', applyGain);
  el.gain.addEventListener('dblclick', () => { el.gain.value = '0'; applyGain(); });

  // ---- Persistence ---------------------------------------------------------
  function loadSegments() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }
  function saveSegments() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(segments)); } catch { /* quota or private mode */ }
  }

  // ---- Transcript handling -------------------------------------------------
  function appendFinal(alt) {
    const words = alt.words || [];
    if (!alt.transcript || !alt.transcript.trim()) return;

    // Group consecutive words by speaker. If diarization gave no speakers,
    // fall back to a single unlabeled run.
    const runs = [];
    for (const w of words) {
      const sp = typeof w.speaker === 'number' ? w.speaker : null;
      const text = w.punctuated_word || w.word;
      const last = runs[runs.length - 1];
      if (last && last.speaker === sp) last.text += ' ' + text;
      else runs.push({ speaker: sp, text });
    }
    if (runs.length === 0) runs.push({ speaker: null, text: alt.transcript.trim() });

    for (const run of runs) {
      const last = segments[segments.length - 1];
      if (last && last.speaker === run.speaker) {
        last.text += ' ' + run.text;
        el.segments.lastElementChild.querySelector('.what').textContent = last.text;
      } else {
        const seg = { speaker: run.speaker, text: run.text, t: Date.now() };
        segments.push(seg);
        el.segments.appendChild(segmentNode(seg));
      }
    }
    el.empty.hidden = true;
    saveSegments();
    scrollToBottom();
  }

  function onDeepgramMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'Results': {
        const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
        if (!alt) return;
        if (msg.is_final) {
          el.interim.textContent = '';
          appendFinal(alt);
        } else if (alt.transcript) {
          el.interim.textContent = alt.transcript;
          scrollToBottom();
        }
        break;
      }
      case 'UtteranceEnd':
        el.interim.textContent = '';
        break;
      case 'Metadata':
        break;
      case 'Error':
        showBanner(`Deepgram error: ${msg.description || msg.message || 'unknown'}`);
        break;
    }
  }

  // ---- Token ---------------------------------------------------------------
  async function fetchToken() {
    const headers = {};
    const saved = localStorage.getItem(PASSWORD_KEY);
    if (saved) headers['x-app-password'] = saved;

    let res = await fetch('/api/token', { method: 'POST', headers });
    if (res.status === 401) {
      const pw = window.prompt('This transcript app is password protected. Enter the password:');
      if (pw == null) throw new Error('Password required');
      localStorage.setItem(PASSWORD_KEY, pw);
      res = await fetch('/api/token', { method: 'POST', headers: { 'x-app-password': pw } });
      if (res.status === 401) {
        localStorage.removeItem(PASSWORD_KEY);
        throw new Error('Wrong password');
      }
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail || ''; } catch { /* ignore */ }
      throw new Error(`Token request failed (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const { access_token } = await res.json();
    if (!access_token) throw new Error('Token response missing access_token');
    return access_token;
  }

  // ---- Deepgram socket -----------------------------------------------------
  async function openSocket(sampleRate) {
    const token = await fetchToken();
    const qs = new URLSearchParams({ ...DG_PARAMS, sample_rate: String(sampleRate) });
    const socket = new WebSocket(`${DG_URL}?${qs}`, ['bearer', token]);
    socket.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Deepgram connection timed out')), 10000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('Could not connect to Deepgram')); };
    });

    socket.onmessage = onDeepgramMessage;
    socket.onerror = () => showBanner('Connection error. Attempting to reconnect…');
    socket.onclose = (e) => {
      if (socket !== ws) return;            // stale socket
      stopKeepAlive();
      ws = null;
      if (!listening) return;               // we closed it on purpose
      if (reconnects < MAX_RECONNECTS) {
        reconnects++;
        setStatus(`Reconnecting (${reconnects})…`, 'busy');
        reconnect(sampleRate).catch((err) => failStop(err.message));
      } else {
        failStop(`Connection lost (code ${e.code}).`);
      }
    };

    ws = socket;
    for (const chunk of pendingAudio) socket.send(chunk);
    pendingAudio = [];
    startKeepAlive();
    reconnects = 0;
    setStatus('Listening', 'live');
    showBanner('');
  }

  async function reconnect(sampleRate) {
    await new Promise((r) => setTimeout(r, 500 * reconnects));
    await openSocket(sampleRate);
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, KEEPALIVE_MS);
  }
  function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }

  // ---- Audio capture -------------------------------------------------------
  async function startAudio() {
    // Ask for the mic first, then create the AudioContext. On iOS the context
    // picks up the mic's native rate this way and avoids a resampling bug.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    await audioCtx.audioWorklet.addModule('pcm-worklet.js');

    source = audioCtx.createMediaStreamSource(stream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = Math.pow(10, gainDb() / 20);
    workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    workletNode.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pcm') {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(m.buffer);
        else if (pendingAudio.length < 60) pendingAudio.push(m.buffer); // ~5 s buffer while connecting
      } else if (m.type === 'level') {
        updateMeter(m.rms, m.peak);
      }
    };
    source.connect(gainNode);
    gainNode.connect(workletNode);

    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (listening) failStop('Microphone was disconnected.');
    });
    return audioCtx.sampleRate;
  }

  async function stopAudio() {
    try { if (source) source.disconnect(); } catch { /* ignore */ }
    try { if (gainNode) gainNode.disconnect(); } catch { /* ignore */ }
    try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch { /* ignore */ }
    if (stream) for (const t of stream.getTracks()) t.stop();
    if (audioCtx) { try { await audioCtx.close(); } catch { /* ignore */ } }
    source = gainNode = workletNode = stream = audioCtx = null;
    pendingAudio = [];
    resetMeter();
  }

  // ---- Wake lock (keep the screen on while listening) ----------------------
  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* not supported or denied; harmless */ }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => {
    if (listening && document.visibilityState === 'visible') {
      acquireWakeLock();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    }
  });

  // ---- Start / stop --------------------------------------------------------
  async function start() {
    if (listening) return;
    listening = true;
    reconnects = 0;
    el.start.hidden = true; el.stop.hidden = false; el.stop.disabled = true;
    setStatus('Starting microphone…', 'busy');
    showBanner('');
    try {
      const sampleRate = await startAudio();
      setStatus('Connecting…', 'busy');
      await openSocket(sampleRate);
      acquireWakeLock();
      el.stop.disabled = false;
    } catch (err) {
      const msg = err && err.name === 'NotAllowedError'
        ? 'Microphone permission denied. Allow mic access for this site and try again.'
        : (err && err.message) || String(err);
      failStop(msg);
    }
  }

  async function stop() {
    if (!listening) return;
    listening = false;
    el.stop.disabled = true;
    setStatus('Stopping…', 'busy');
    stopKeepAlive();
    const socket = ws; ws = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* ignore */ }
      // Give Deepgram a moment to flush the last final result.
      await new Promise((r) => setTimeout(r, 600));
      try { socket.close(); } catch { /* ignore */ }
    }
    await stopAudio();
    releaseWakeLock();
    el.interim.textContent = '';
    el.start.hidden = false; el.stop.hidden = true; el.stop.disabled = false;
    setStatus(segments.length ? 'Stopped' : 'Ready');
  }

  async function failStop(message) {
    showBanner(message);
    await stop();
    setStatus('Error', 'error');
  }

  // ---- Export --------------------------------------------------------------
  function transcriptText() {
    return segments.map((s) => (s.speaker != null ? `${speakerLabel(s.speaker)}: ` : '') + s.text).join('\n');
  }
  async function copyTranscript() {
    if (!segments.length) return;
    try {
      await navigator.clipboard.writeText(transcriptText());
      showBanner('Copied to clipboard.', true);
      setTimeout(() => showBanner(''), 1500);
    } catch {
      showBanner('Copy failed. Use Save instead.');
    }
  }
  function downloadTranscript() {
    if (!segments.length) return;
    const blob = new Blob([transcriptText() + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    a.download = `transcript-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function clearTranscript() {
    if (!segments.length) return;
    if (!window.confirm('Clear the transcript? This cannot be undone.')) return;
    segments = [];
    saveSegments();
    el.interim.textContent = '';
    renderAll();
    if (!listening) setStatus('Ready');
  }

  // ---- Wire up -------------------------------------------------------------
  el.start.addEventListener('click', start);
  el.stop.addEventListener('click', stop);
  el.copy.addEventListener('click', copyTranscript);
  el.download.addEventListener('click', downloadTranscript);
  el.clear.addEventListener('click', clearTranscript);
  window.addEventListener('pagehide', () => { if (listening) stop(); });

  if (!navigator.mediaDevices || !window.AudioWorkletNode) {
    el.start.disabled = true;
    showBanner('This browser does not support microphone capture. Use a current Safari, Chrome, or Firefox over HTTPS.');
  } else if (!window.isSecureContext) {
    el.start.disabled = true;
    showBanner('Microphone access requires HTTPS.');
  }

  renderAll();
  setStatus(segments.length ? 'Stopped' : 'Ready');
})();
