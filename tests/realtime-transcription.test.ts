import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  LIVE_TRANSCRIPTION_MODEL, RealtimeTranscriptionSession, type TranscriptionTimers,
} from '../src/main/realtime-transcription';
import type { VoiceStreamEvent } from '../src/shared/types';

// No microphone, network, or real credentials: exercise the actual session with protocol fixtures.
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  terminated = 0;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  terminate() { this.terminated++; this.readyState = WebSocket.CLOSED; }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  receive(data: object) { this.emit('message', Buffer.from(JSON.stringify(data)), false); }
}

class FakeClock implements TranscriptionTimers {
  now = 0;
  nextId = 0;
  pending = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, milliseconds: number) {
    const id = ++this.nextId;
    this.pending.set(id, { at: this.now + milliseconds, callback });
    return id;
  }
  clearTimeout(handle: unknown) { this.pending.delete(handle as number); }
  advance(milliseconds: number) {
    const until = this.now + milliseconds;
    while (true) {
      const next = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.pending.delete(next[0]); this.now = next[1].at; next[1].callback();
    }
    this.now = until;
  }
}

function fixture(ready = true) {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const events: VoiceStreamEvent[] = [];
  let closed = 0;
  let connection: { url: string; options: WebSocket.ClientOptions } | undefined;
  const session = new RealtimeTranscriptionSession({
    sessionId: 'voice-test', apiKey: 'test-key-not-real', timers: clock,
    onEvent: event => events.push(event), onClose: () => closed++,
    socketFactory: (url, options) => { connection = { url, options }; return socket as unknown as WebSocket; },
  });
  session.start();
  if (ready) { socket.open(); socket.receive({ type: 'session.updated' }); }
  return { session, socket, clock, events, get closed() { return closed; }, get connection() { return connection!; } };
}

function pcm(milliseconds = 100, amplitude = 0.1): Uint8Array {
  const bytes = new Uint8Array(milliseconds * 24 * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length; i += 2) view.setInt16(i, Math.round(amplitude * 32767) * (i % 4 ? 1 : -1), true);
  return bytes;
}

test('live transcription configures the current dedicated session and emits partials before commit', () => {
  const f = fixture(false);
  assert.equal(f.connection.url, 'wss://api.openai.com/v1/realtime?intent=transcription');
  assert.deepEqual(f.connection.options.headers, { Authorization: 'Bearer test-key-not-real' });
  assert.equal(f.connection.options.followRedirects, false);
  f.socket.open();
  assert.deepEqual(f.socket.sent[0], { type: 'session.update', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: LIVE_TRANSCRIPTION_MODEL, delay: 'low' }, turn_detection: null,
  } } } });
  assert.equal(f.events.length, 0);
  f.socket.receive({ type: 'session.created' });
  assert.equal(f.events.length, 0);
  f.socket.receive({ type: 'session.updated' });
  assert.equal(f.events[0].type, 'ready');
  const audio = pcm();
  f.session.pushAudio(audio);
  assert.deepEqual(Buffer.from(f.socket.sent[1].audio, 'base64'), Buffer.from(audio));
  f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Water ' });
  f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'the plants' });
  assert.deepEqual(f.events.filter(e => e.type === 'partial').map(e => e.text), ['Water ', 'Water the plants']);
  assert.equal(f.socket.sent.some(e => e.type === 'input_audio_buffer.commit'), false);
  f.session.stop(false);
  f.session.stop(false);
  assert.equal(f.socket.sent.filter(e => e.type === 'input_audio_buffer.commit').length, 1);
  f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'other', transcript: 'Unrelated' });
  assert.equal(f.session.isClosed, false);
  f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: ' Water the plants. ' });
  f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Duplicate' });
  assert.deepEqual(f.events.filter(e => e.type === 'final').map(e => e.text), ['Water the plants.']);
  assert.equal(f.closed, 1);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.socket.terminated, 1);
});

test('PCM VAD waits for sustained speech and two seconds of silence before committing once', () => {
  const f = fixture();
  f.session.pushAudio(pcm(20));
  f.session.pushAudio(pcm(100, 0));
  assert.equal(f.events.some(e => e.type === 'speech_started'), false, 'brief click is not speech');
  f.session.pushAudio(pcm(100));
  assert.equal(f.events.filter(e => e.type === 'speech_started').length, 1);
  for (let i = 0; i < 19; i++) f.session.pushAudio(pcm(100, 0));
  assert.equal(f.socket.sent.some(e => e.type === 'input_audio_buffer.commit'), false);
  f.session.pushAudio(pcm(100, 0));
  assert.equal(f.events.filter(e => e.type === 'speech_stopped').length, 1);
  assert.equal(f.socket.sent.filter(e => e.type === 'input_audio_buffer.commit').length, 1);
  const sent = f.socket.sent.length;
  f.session.pushAudio(pcm());
  assert.equal(f.socket.sent.length, sent, 'capture arriving after automatic stop is ignored');
  f.session.stop(true);
});

test('cancellation closes immediately and never submits late transcript text', () => {
  for (const ready of [true, false]) {
    const f = fixture(ready);
    if (ready) {
      f.session.pushAudio(pcm());
      f.socket.receive({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Draft' });
    }
    f.session.stop(true);
    f.socket.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Do not send' });
    f.socket.emit('error', new Error('late connection failure'));
    f.clock.advance(120_000);
    assert.equal(f.events.some(e => e.type === 'final' || e.type === 'error'), false);
    assert.equal(f.socket.sent.some(e => e.type === 'input_audio_buffer.commit'), false);
    assert.equal(f.session.isClosed, true);
    assert.equal(f.closed, 1);
    assert.equal(f.clock.pending.size, 0);
  }
});

test('connection, no-speech, duration, and final-transcript timeouts are bounded', () => {
  const handshake = fixture(false);
  handshake.clock.advance(12_000);
  assert.match(handshake.events.at(-1)!.message!, /Connecting.*timed out/);
  assert.equal(handshake.clock.pending.size, 0);

  const silent = fixture();
  silent.clock.advance(15_000);
  assert.match(silent.events.at(-1)!.message!, /No speech/);
  assert.equal(silent.clock.pending.size, 0);

  const long = fixture();
  long.session.pushAudio(pcm());
  long.clock.advance(60_000);
  assert.equal(long.socket.sent.filter(e => e.type === 'input_audio_buffer.commit').length, 1);
  long.clock.advance(15_000);
  assert.match(long.events.at(-1)!.message!, /final transcript timed out/);
  assert.equal(long.clock.pending.size, 0);
});

test('invalid PCM, excessive network buffering, and malformed events fail with cleanup', () => {
  for (const audio of [new Uint8Array(1), new Uint8Array(70_000), new Uint8Array()]) {
    const f = fixture();
    f.session.pushAudio(audio);
    assert.match(f.events.at(-1)!.message!, /microphone audio/);
    assert.equal(f.session.isClosed, true);
  }
  const backpressure = fixture();
  backpressure.socket.bufferedAmount = 600_000;
  backpressure.session.pushAudio(pcm());
  assert.match(backpressure.events.at(-1)!.message!, /cannot keep up/);
  const malformed = fixture();
  malformed.socket.emit('message', Buffer.from('{'), false);
  assert.match(malformed.events.at(-1)!.message!, /unreadable/);
});

test('provider error events become readable messages without JSON or credentials', () => {
  const f = fixture();
  f.socket.receive({ type: 'error', error: { code: 'invalid_api_key', message: 'Bad key test-key-not-real' } });
  assert.match(f.events.at(-1)!.message!, /authenticate/);
  assert.doesNotMatch(f.events.at(-1)!.message!, /test-key|[{}]/);
  assert.equal(f.session.isClosed, true);
  assert.equal(f.clock.pending.size, 0);
});
