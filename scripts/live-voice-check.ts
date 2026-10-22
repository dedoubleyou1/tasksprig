/** Optional live check: streams only synthetic speech, never accesses a microphone or task data. */
import { app } from 'electron';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { SettingsStore } from '../src/main/settings';
import { configureAppData } from '../src/main/app-data';
import { RealtimeTranscriptionSession } from '../src/main/realtime-transcription';
import type { VoiceStreamEvent } from '../src/shared/types';

const run = promisify(execFile);
const phrase = 'Please remind me to water the plants weekly.';
const sampleRate = 24_000;
const chunkMs = 100;
const chunkBytes = sampleRate * 2 * chunkMs / 1000;
let scratch: string | undefined;
let session: RealtimeTranscriptionSession | undefined;
let configuredKey = '';
configureAppData();

const deadline = setTimeout(() => {
  session?.stop(true);
  console.error('Synthetic streaming voice check timed out after one minute.');
  void (scratch ? rm(scratch, { recursive: true, force: true }) : Promise.resolve())
    .finally(() => app.exit(1));
}, 60_000);

function pcmFromWav(bytes: Buffer): Buffer {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'Speech synthesis must create a WAV file.');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  const chunks: Buffer[] = [];
  let formatFound = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + size <= bytes.length, 'The synthesized WAV file is incomplete.');
    if (name === 'fmt ') {
      assert.ok(size >= 16);
      assert.equal(bytes.readUInt16LE(start), 1, 'Expected uncompressed PCM.');
      assert.equal(bytes.readUInt16LE(start + 2), 1, 'Expected mono audio.');
      assert.equal(bytes.readUInt32LE(start + 4), sampleRate, 'Expected 24 kHz audio.');
      assert.equal(bytes.readUInt16LE(start + 14), 16, 'Expected 16-bit samples.');
      formatFound = true;
    }
    if (name === 'data') chunks.push(bytes.subarray(start, start + size));
    offset = start + size + (size % 2);
  }
  const pcm = Buffer.concat(chunks);
  assert.ok(formatFound && pcm.length > chunkBytes && pcm.length % 2 === 0, 'The synthesized WAV has no usable audio.');
  // Explicit silence below, rather than synthesized trailing padding, owns endpoint timing.
  let lastAudibleSample = -1;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    if (Math.abs(pcm.readInt16LE(offset)) >= 200) lastAudibleSample = offset / 2;
  }
  assert.ok(lastAudibleSample >= 0, 'Synthetic speech is silent.');
  return pcm.subarray(0, Math.min(pcm.length, (lastAudibleSample + 1) * 2 + chunkBytes));
}

void app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin', 'This synthetic voice check uses macOS speech synthesis.');
  const settings = new SettingsStore(app.getPath('userData'));
  await settings.init();
  configuredKey = settings.getForProvider('openai').apiKey;
  assert.ok(configuredKey, 'Configure an OpenAI API key in TaskSprig first; the active chat provider can stay unchanged.');
  scratch = await mkdtemp(join(tmpdir(), 'tasksprig-live-voice-'));
  try {
    const recordingPath = join(scratch, 'synthetic-reminder.wav');
    await run('/usr/bin/say', [
      '-o', recordingPath, '--file-format=WAVE', '--data-format=LEI16@24000',
      '--channels=1', '-r', '170', phrase,
    ], { timeout: 10_000, maxBuffer: 16_384 });
    const pcm = pcmFromWav(await readFile(recordingPath));
    const events: Array<VoiceStreamEvent & { atMs: number }> = [];
    const started = Date.now();
    let streamError: string | undefined;
    let partialBeforeStop = false;
    let speechStopped = false;
    let closed = false;
    session = new RealtimeTranscriptionSession({
      sessionId: `synthetic-check-${Date.now()}`,
      apiKey: configuredKey,
      onEvent(event) {
        events.push({ ...event, atMs: Date.now() - started });
        if (event.type === 'partial' && event.text?.trim() && !speechStopped) partialBeforeStop = true;
        if (event.type === 'speech_stopped') speechStopped = true;
        if (event.type === 'error') streamError = event.message || 'Realtime transcription failed.';
      },
      onClose() { closed = true; },
    });
    const waitFor = async (predicate: () => boolean, timeoutMs: number, explanation: string) => {
      const until = Date.now() + timeoutMs;
      while (!predicate()) {
        if (streamError) throw new Error(streamError);
        if (closed || session!.isClosed) throw new Error(`Realtime session closed before ${explanation}.`);
        if (Date.now() >= until) throw new Error(`Timed out waiting for ${explanation}.`);
        await delay(25);
      }
    };
    const pushPaced = async (audio: Buffer) => {
      if (streamError) throw new Error(streamError);
      assert.ok(!closed && !session!.isClosed, 'The session must stay open while audio is streamed.');
      session!.pushAudio(Uint8Array.from(audio));
      await delay(chunkMs);
    };

    session.start();
    await waitFor(() => events.some(event => event.type === 'ready'), 15_000, 'the ready event');
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      assert.equal(speechStopped, false, 'The session should not endpoint during this short spoken phrase.');
      const chunk = Buffer.alloc(chunkBytes);
      pcm.copy(chunk, 0, offset, Math.min(offset + chunkBytes, pcm.length));
      await pushPaced(chunk);
    }

    // No stop(false) or explicit commit: client silence detection must finish this turn.
    const silenceStarted = Date.now();
    for (let chunk = 0; chunk < 30 && !speechStopped; chunk++) await pushPaced(Buffer.alloc(chunkBytes));
    await waitFor(() => speechStopped, 1_000, 'automatic speech_stopped after silence');
    const silenceElapsedMs = Date.now() - silenceStarted;
    assert.ok(silenceElapsedMs >= 1_200 && silenceElapsedMs <= 4_000,
      `The two-second silence endpoint should be natural and bounded (observed ${silenceElapsedMs} ms).`);
    await waitFor(() => events.some(event => event.type === 'final'), 15_000, 'the final transcript');
    assert.ok(partialBeforeStop, 'Expected a nonempty streaming partial before speech_stopped/commit, without calling stop().');
    const final = events.findLast(event => event.type === 'final');
    const text = final?.text?.trim() || '';
    assert.match(text, /\bwater\b/i, 'The synthetic reminder transcript should include water.');
    assert.match(text, /\bplants?\b/i, 'The synthetic reminder transcript should include plants.');
    const firstPartial = events.find(event => event.type === 'partial' && event.text?.trim());
    const stopped = events.find(event => event.type === 'speech_stopped');
    assert.ok(firstPartial && stopped && firstPartial.atMs < stopped.atMs, 'A partial must arrive before the automatic commit.');
    console.log(`Synthetic streaming voice check passed. First partial ${firstPartial.atMs} ms; silence endpoint ${silenceElapsedMs} ms; final ${final!.atMs} ms. Transcript: ${text}`);
  } finally {
    session?.stop(true);
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
}).then(() => {
  clearTimeout(deadline);
  app.quit();
}).catch(error => {
  clearTimeout(deadline);
  const message = error instanceof Error ? error.message : 'Synthetic streaming voice check failed.';
  console.error(configuredKey ? message.split(configuredKey).join('[redacted]') : message);
  app.exit(1);
});
