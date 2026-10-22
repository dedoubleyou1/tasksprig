// The AudioContext supplies mono 24 kHz samples. Emit 100 ms PCM16 LE chunks.
class TaskSprigVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2400);
    this.used = 0;
    this.capturing = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') this.capturing = true;
      if (data.type === 'flush') {
        this.capturing = false;
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  flush() {
    if (!this.used) return;
    const audio = new ArrayBuffer(this.used * 2);
    const view = new DataView(audio);
    for (let i = 0; i < this.used; i += 1) {
      const sample = Math.max(-1, Math.min(1, this.samples[i]));
      view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
    }
    this.port.postMessage({ type: 'audio', audio }, [audio]);
    this.used = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (this.capturing && input) for (const sample of input) {
      this.samples[this.used++] = sample;
      if (this.used === this.samples.length) this.flush();
    }
    // Unwritten outputs remain silent: never feed the microphone to the speakers.
    return true;
  }
}
registerProcessor('tasksprig-voice-capture', TaskSprigVoiceCapture);
