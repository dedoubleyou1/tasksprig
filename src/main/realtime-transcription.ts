import WebSocket from 'ws';
import type { VoiceStreamEvent } from '../shared/types';
import { formatAgentError } from './agent/errors';

/** This model emits text before commit; gpt-transcribe only starts after commit.
 * https://developers.openai.com/api/docs/guides/realtime-transcription
 * The API key stays in the main process; captured audio is never saved.
 */
export const LIVE_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
export const LIVE_AUDIO_RATE = 24_000;
export const LIVE_AUDIO_MAX_BYTES = LIVE_AUDIO_RATE * 2 * 60;
const TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_LENGTH = 16_000;
const FRAME_SAMPLES = LIVE_AUDIO_RATE / 50; // 20 ms, independent of IPC chunk size.

export interface TranscriptionTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeTranscriptionOptions {
  sessionId: string;
  apiKey: string;
  onEvent: (event: VoiceStreamEvent) => void;
  onClose?: () => void;
  /** Dependency injection for protocol tests; production always uses the fixed OpenAI URL. */
  socketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  timers?: TranscriptionTimers;
}

const timers: TranscriptionTimers = {
  setTimeout(callback, milliseconds) { const timer = setTimeout(callback, milliseconds); timer.unref(); return timer; },
  clearTimeout(handle) { clearTimeout(handle as NodeJS.Timeout); },
};

/** One microphone utterance per session. Stop commits once; cancellation never emits a final. */
export class RealtimeTranscriptionSession {
  private socket?: WebSocket;
  private state: 'new' | 'connecting' | 'listening' | 'finishing' | 'closed' = 'new';
  private readonly clock: TranscriptionTimers;
  private readonly deadlines = new Map<string, unknown>();
  private bytesSent = 0;
  private speechStarted = false;
  private frameSamples = 0;
  private frameEnergy = 0;
  private loudFrames = 0;
  private silentSamples = 0;
  private itemId?: string;
  private partial = '';

  constructor(private readonly options: RealtimeTranscriptionOptions) {
    if (typeof options.apiKey !== 'string' || !options.apiKey.trim()) {
      throw new Error('Add an OpenAI API key in Settings to use voice input. Your chat model can stay unchanged.');
    }
    this.clock = options.timers ?? timers;
  }

  get isClosed(): boolean { return this.state === 'closed'; }
  get sessionId(): string { return this.options.sessionId; }

  start(): void {
    if (this.state !== 'new') return;
    this.state = 'connecting';
    this.deadline('handshake', 12_000, () => this.fail('Connecting to OpenAI transcription timed out. Please try again.'));
    try {
      this.socket = (this.options.socketFactory ?? ((url, config) => new WebSocket(url, config)))(TRANSCRIPTION_URL, {
        headers: { Authorization: `Bearer ${this.options.apiKey.trim()}` },
        handshakeTimeout: 10_000, maxPayload: MAX_EVENT_BYTES, followRedirects: false,
      });
      this.socket.on('open', () => {
        if (this.isClosed) return;
        this.send({ type: 'session.update', session: { type: 'transcription', audio: { input: {
          format: { type: 'audio/pcm', rate: LIVE_AUDIO_RATE },
          transcription: { model: LIVE_TRANSCRIPTION_MODEL, delay: 'low' },
          // gpt-live-transcribe requires client VAD; server_vad is not supported.
          turn_detection: null,
        } } } });
      });
      this.socket.on('message', (data, isBinary) => this.receive(data, isBinary));
      this.socket.on('error', () => this.fail('Could not reach OpenAI transcription. Check your connection and try again.'));
      this.socket.on('unexpected-response', (_request, response) => {
        response.resume();
        const status = response.statusCode;
        this.fail(status === 401 || status === 403
          ? 'OpenAI could not use the saved key. Check your OpenAI key in Settings.'
          : status === 429 ? 'OpenAI transcription is rate-limited or out of credits. Please try again later.'
            : 'OpenAI live transcription is unavailable. Please try again.');
      });
      this.socket.on('close', () => {
        if (!this.isClosed) this.fail('The transcription connection closed before it finished. Please try again.');
      });
    } catch {
      this.fail('Could not connect to OpenAI transcription. Check your connection and try again.');
    }
  }

  pushAudio(audio: Uint8Array): void {
    if (this.state === 'closed' || this.state === 'finishing') return;
    if (this.state !== 'listening') { this.fail('Voice input is not ready yet. Please try again.'); return; }
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0 || audio.byteLength % 2 !== 0 || audio.byteLength > MAX_CHUNK_BYTES) {
      this.fail('The microphone audio could not be read. Please try recording again.'); return;
    }
    const remaining = LIVE_AUDIO_MAX_BYTES - this.bytesSent;
    const bytes = audio.subarray(0, Math.min(audio.byteLength, remaining));
    if (bytes.byteLength) {
      const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
      if (!this.send({ type: 'input_audio_buffer.append', audio: encoded })) return;
      this.bytesSent += bytes.byteLength;
      this.detectSpeech(bytes);
    }
    if (this.bytesSent >= LIVE_AUDIO_MAX_BYTES) this.stop(false);
  }

  stop(cancel = false): void {
    if (this.isClosed) return;
    if (cancel) { this.close(); return; }
    if (this.state === 'finishing') return;
    if (this.state !== 'listening' || this.bytesSent < LIVE_AUDIO_RATE / 5) {
      this.fail('No speech was captured. Please try again closer to the microphone.'); return;
    }
    this.state = 'finishing';
    this.clearDeadline('no-speech');
    this.clearDeadline('maximum');
    this.emit('speech_stopped');
    this.deadline('final', 15_000, () => this.fail('The final transcript timed out. Your partial text is still in the input; you can edit and send it.'));
    this.send({ type: 'input_audio_buffer.commit' });
  }

  private receive(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.isClosed) return;
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
    if (isBinary || bytes.byteLength > MAX_EVENT_BYTES) { this.fail('OpenAI returned an unreadable transcript. Please try again.'); return; }
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(bytes.toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      event = value as Record<string, unknown>;
    } catch { this.fail('OpenAI returned an unreadable transcript. Please try again.'); return; }
    if (event.type === 'session.updated' && this.state === 'connecting') {
      this.clearDeadline('handshake');
      this.state = 'listening';
      this.deadline('no-speech', 15_000, () => this.fail('No speech was detected. Please try again closer to the microphone.'));
      this.deadline('maximum', 60_000, () => this.stop(false));
      this.emit('ready');
    } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
      this.fail(formatAgentError(JSON.stringify(event.error ?? event), 'openai', this.options.apiKey));
    } else if (event.type === 'input_audio_buffer.committed') {
      if (typeof event.item_id === 'string' && !this.itemId) this.itemId = event.item_id;
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      if (typeof event.delta !== 'string' || !this.acceptItem(event.item_id)) return;
      this.partial += event.delta;
      if (this.partial.length > MAX_TRANSCRIPT_LENGTH) { this.fail('The transcript is too long. Please try a shorter recording.'); return; }
      if (this.partial.trim()) this.markSpeechStarted();
      this.emit('partial', this.partial);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (this.state !== 'finishing' || !this.acceptItem(event.item_id)) return;
      const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
      if (!text) { this.fail('No speech was detected. Please try again closer to the microphone.'); return; }
      if (text.length > MAX_TRANSCRIPT_LENGTH) { this.fail('The transcript is too long. Please try a shorter recording.'); return; }
      // Close first so a callback, late event, or duplicate completion cannot submit twice.
      this.close();
      this.emit('final', text);
    }
  }

  private acceptItem(itemId: unknown): boolean {
    if (typeof itemId !== 'string' || !itemId) return false;
    if (!this.itemId) this.itemId = itemId;
    return this.itemId === itemId;
  }

  private detectSpeech(audio: Uint8Array): void {
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    for (let offset = 0; offset < audio.byteLength && this.state === 'listening'; offset += 2) {
      const value = view.getInt16(offset, true) / 32768;
      this.frameEnergy += value * value;
      if (++this.frameSamples < FRAME_SAMPLES) continue;
      const rms = Math.sqrt(this.frameEnergy / this.frameSamples);
      this.frameSamples = 0;
      this.frameEnergy = 0;
      // A short sustained onset rejects clicks; a lower continuation threshold preserves quiet endings.
      const loud = rms >= (this.speechStarted ? 0.006 : 0.012);
      this.loudFrames = loud ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= 3) this.markSpeechStarted();
      if (this.speechStarted) {
        this.silentSamples = loud ? 0 : this.silentSamples + FRAME_SAMPLES;
        if (this.silentSamples >= LIVE_AUDIO_RATE * 2) this.stop(false);
      }
    }
  }

  private markSpeechStarted(): void {
    if (this.speechStarted || this.state !== 'listening') return;
    this.speechStarted = true;
    this.clearDeadline('no-speech');
    this.emit('speech_started');
  }

  private send(event: Record<string, unknown>): boolean {
    if (this.isClosed) return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 512 * 1024) {
      this.fail('The transcription connection cannot keep up. Please check your connection and try again.'); return false;
    }
    try { this.socket.send(JSON.stringify(event)); return true; }
    catch { this.fail('The transcription connection was interrupted. Please try again.'); return false; }
  }

  private emit(type: VoiceStreamEvent['type'], text?: string, message?: string): void {
    this.options.onEvent({ sessionId: this.options.sessionId, type, ...(text !== undefined ? { text } : {}), ...(message ? { message } : {}) });
  }

  private fail(message: string): void {
    if (this.isClosed) return;
    this.close();
    this.emit('error', undefined, message);
  }

  private deadline(name: string, duration: number, callback: () => void): void {
    this.clearDeadline(name);
    this.deadlines.set(name, this.clock.setTimeout(() => { this.deadlines.delete(name); callback(); }, duration));
  }

  private clearDeadline(name: string): void {
    const timer = this.deadlines.get(name);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.deadlines.delete(name);
  }

  private close(): void {
    if (this.isClosed) return;
    this.state = 'closed';
    for (const name of this.deadlines.keys()) this.clearDeadline(name);
    if (this.socket) {
      this.socket.removeAllListeners();
      // Terminating a connecting socket can emit an asynchronous error after cancellation.
      this.socket.on('error', () => {});
      this.socket.terminate();
    }
    this.options.onClose?.();
  }
}
