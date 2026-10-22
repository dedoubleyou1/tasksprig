import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AUDIO_BYTES, MAX_RECORDING_MS, TRANSCRIPTION_MODEL, transcribeAudio } from '../src/main/transcription';

// Synthetic bytes and a stub fetch only. These tests never record or transmit audio.
const sample = { audio: new Uint8Array([1, 2, 3, 4]), mimeType: 'audio/webm;codecs=opus', durationMs: 1200 };

test('voice transcription uploads a bounded file to OpenAI and returns editable text', async () => {
  let calls = 0;
  const mockFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only-not-a-real-key');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const body = init?.body as FormData;
    assert.equal(body.get('model'), TRANSCRIPTION_MODEL);
    const file = body.get('file') as File;
    assert.equal(file.name, 'voice.webm');
    assert.equal(file.type, 'audio/webm');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), sample.audio);
    return Response.json({ text: '  Water the plants every two weeks.  ' });
  };
  assert.deepEqual(await transcribeAudio(sample, 'test-only-not-a-real-key', { fetch: mockFetch }), { text: 'Water the plants every two weeks.' });
  assert.equal(calls, 1);
});

test('invalid voice requests fail before any network call', async () => {
  let calls = 0;
  const mockFetch: typeof fetch = async () => { calls++; throw new Error('Must not be called'); };
  await assert.rejects(() => transcribeAudio(sample, '', { fetch: mockFetch }), /OpenAI API key/);
  await assert.rejects(() => transcribeAudio({ ...sample, durationMs: MAX_RECORDING_MS + 1 }, 'test', { fetch: mockFetch }), /one minute/);
  await assert.rejects(() => transcribeAudio({ ...sample, durationMs: Number.NaN }, 'test', { fetch: mockFetch }), /one minute/);
  await assert.rejects(() => transcribeAudio({ ...sample, audio: new Uint8Array() }, 'test', { fetch: mockFetch }), /empty/);
  await assert.rejects(() => transcribeAudio({ ...sample, audio: new Uint8Array(MAX_AUDIO_BYTES + 1) }, 'test', { fetch: mockFetch }), /too large/);
  await assert.rejects(() => transcribeAudio({ ...sample, mimeType: 'text/plain' }, 'test', { fetch: mockFetch }), /format/);
  assert.equal(calls, 0);
});

test('provider failures give readable errors without exposing provider response bodies', async () => {
  for (const [status, message] of [[401, /saved key/], [429, /credits/], [404, /unavailable/], [500, /temporarily/]] as const) {
    const mockFetch: typeof fetch = async () => new Response('sensitive provider diagnostics should never be shown', { status });
    await assert.rejects(() => transcribeAudio(sample, 'test', { fetch: mockFetch }), message);
  }
  await assert.rejects(() => transcribeAudio(sample, 'test', { fetch: async () => Response.json({ text: ' ' }) }), /No speech/);
  await assert.rejects(() => transcribeAudio(sample, 'test', { fetch: async () => { throw new DOMException('Timeout', 'TimeoutError'); } }), /timed out/);
});
