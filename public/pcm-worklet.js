// AudioWorklet: converts the mic's Float32 samples to 16-bit PCM chunks and
// posts them to the main thread, plus a cheap level reading for the meter.
// Raw PCM sidesteps the MediaRecorder codec differences between Safari
// (MP4/AAC) and Chrome (WebM/Opus), so one code path works everywhere.
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 4096; // ~85 ms at 48 kHz
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.sumSquares = 0;
    this.peak = 0;
    this.count = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSquares += s * s;
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
      this.count++;
      if (this.offset === this.chunkSize) {
        const out = this.buffer;
        this.port.postMessage({ type: 'pcm', buffer: out.buffer }, [out.buffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.offset = 0;
        this.port.postMessage({ type: 'level', rms: Math.sqrt(this.sumSquares / this.count), peak: this.peak });
        this.sumSquares = 0;
        this.peak = 0;
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
