/** Recorded audio stays in memory and is sent only to this fixed OpenAI endpoint.
 * API reference: https://developers.openai.com/api/docs/guides/speech-to-text
 */
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const MAX_RECORDING_MS = 60_000;
export const TRANSCRIPTION_MODEL = 'gpt-transcribe';
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

export interface AudioTranscriptionRequest {
  audio: Uint8Array | ArrayBuffer;
  mimeType: string;
  durationMs: number;
}

const AUDIO_FORMATS: Record<string, string> = {
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
};

export async function transcribeAudio(
  request: AudioTranscriptionRequest,
  apiKey: string,
  options: { fetch?: typeof fetch } = {},
): Promise<{ text: string }> {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Add an OpenAI API key in Settings to use voice input. Your active chat model can stay unchanged.');
  }
  if (!request || !(request.audio instanceof Uint8Array || request.audio instanceof ArrayBuffer)) {
    throw new Error('The recording could not be read. Please record it again.');
  }
  if (!Number.isFinite(request.durationMs) || request.durationMs <= 0 || request.durationMs > MAX_RECORDING_MS) {
    throw new Error('Please keep voice recordings under one minute.');
  }
  if (request.audio.byteLength === 0 || request.audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('The recording is empty or too large. Please try a shorter recording.');
  }
  const mimeType = typeof request.mimeType === 'string' ? request.mimeType.split(';')[0].trim().toLowerCase() : '';
  const extension = AUDIO_FORMATS[mimeType];
  if (!extension) throw new Error('This recording format is not supported. Please try recording again.');

  const bytes = request.audio instanceof ArrayBuffer ? new Uint8Array(request.audio.slice(0)) : Uint8Array.from(request.audio);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mimeType }), `voice.${extension}`);
  form.set('model', TRANSCRIPTION_MODEL);

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new Error('Transcription timed out. Please try again.');
    }
    throw new Error('Could not reach OpenAI for transcription. Check your connection and try again.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('OpenAI could not use the saved key. Check your OpenAI key in Settings.');
    if (response.status === 429) throw new Error('OpenAI transcription is rate-limited or out of credits. Please try again later.');
    if (response.status === 404) throw new Error('The transcription model is unavailable for this OpenAI account.');
    if (response.status === 400 || response.status === 413) throw new Error('OpenAI could not read this recording. Please try a shorter recording.');
    throw new Error('OpenAI transcription is temporarily unavailable. Please try again.');
  }
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error('OpenAI returned an unreadable transcript. Please try again.'); }
  const text = result && typeof result === 'object' && 'text' in result && typeof result.text === 'string' ? result.text.trim() : '';
  if (!text) throw new Error('No speech was detected. Please try again closer to the microphone.');
  if (text.length > 16_000) throw new Error('The transcript is too long. Please try a shorter recording.');
  return { text };
}

/** Called only after the user presses the microphone button. */
export async function requestMicrophoneAccess(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const { systemPreferences } = await import('electron');
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return;
  if (status === 'not-determined' || status === 'unknown') {
    if (await systemPreferences.askForMediaAccess('microphone')) return;
  }
  throw new Error('Microphone access is off. Enable TaskSprig in System Settings → Privacy & Security → Microphone, then restart TaskSprig.');
}
