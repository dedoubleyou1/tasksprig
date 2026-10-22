import React, { useEffect, useRef, useState } from 'react';
import type { VoiceAudioChunk, VoiceStreamEvent, VoiceStreamStop } from '../shared/types';
import './voice-input.css';

export type VoiceInputState = 'idle' | 'requesting' | 'recording' | 'transcribing';
export interface VoiceInputProps {
  disabled?: boolean;
  hasOpenAIKey: boolean;
  requestPermission: () => Promise<void>;
  startStream: () => Promise<{ sessionId: string }>;
  sendAudio: (request: VoiceAudioChunk) => Promise<void>;
  stopStream: (request: VoiceStreamStop) => Promise<void>;
  onStreamEvent: (listener: (event: VoiceStreamEvent) => void) => () => void;
  /** Replaces the current streaming draft with the full accumulated transcript. */
  onPartialTranscript: (text: string) => void;
  onCancel?: () => void;
  /** Called once with the final transcript after a speaking pause or an explicit Stop. */
  onTranscript: (text: string) => void;
  onStateChange?: (state: VoiceInputState) => void;
}

const MAX_DURATION = 60_000;
const SAMPLE_RATE = 24_000;
const workletUrl = new URL('./voice-capture.worklet.js?no-inline', import.meta.url).href;

function recordingError(error: unknown): string {
  if (error instanceof Error && ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)) {
    return 'Microphone access is off. Enable TaskSprig in System Settings → Privacy & Security → Microphone, then restart TaskSprig.';
  }
  if (error instanceof Error && ['NotFoundError', 'DevicesNotFoundError'].includes(error.name)) return 'No microphone was found. Connect one and try again.';
  if (error instanceof Error && error.name === 'NotReadableError') return 'The microphone is unavailable. Close any app using it and try again.';
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^(?:Error:\s*)+/i, '');
}

export default function VoiceInput(props: VoiceInputProps) {
  const { disabled = false, hasOpenAIKey } = props;
  const [phase, setPhase] = useState<VoiceInputState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const phaseRef = useRef<VoiceInputState>('idle');
  const sessionRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const flushRef = useRef<(() => void) | null>(null);
  const audioQueue = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  const updatePhase = (next: VoiceInputState) => {
    phaseRef.current = next;
    if (mounted.current) { setPhase(next); callbacks.current.onStateChange?.(next); }
  };
  const releaseMicrophone = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (limitRef.current) clearTimeout(limitRef.current);
    timerRef.current = null; limitRef.current = null;
    if (workletRef.current) {
      workletRef.current.port.onmessage = null;
      workletRef.current.disconnect();
      workletRef.current.port.close();
    }
    workletRef.current = null;
    sourceRef.current?.disconnect(); sourceRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    flushRef.current?.(); flushRef.current = null;
  };
  const finish = () => {
    attempt.current += 1;
    sessionRef.current = null;
    unsubscribeRef.current?.(); unsubscribeRef.current = null;
    releaseMicrophone();
    updatePhase('idle');
  };
  const fail = (error: unknown) => {
    const id = sessionRef.current;
    finish();
    if (id) void callbacks.current.stopStream({ sessionId: id, cancel: true }).catch(() => {});
    if (mounted.current) { setFailed(true); setNotice(recordingError(error)); }
  };
  const cancel = () => {
    const id = sessionRef.current;
    finish();
    if (id) void callbacks.current.stopStream({ sessionId: id, cancel: true }).catch(() => {});
    callbacks.current.onCancel?.();
    if (mounted.current) { setFailed(false); setNotice('Voice request cancelled.'); }
  };
  const stop = async () => {
    if (phaseRef.current !== 'recording') return;
    const id = sessionRef.current;
    if (!id) return;
    updatePhase('transcribing');
    // Flush the final fraction of a 100 ms chunk before the main process commits the turn.
    const worklet = workletRef.current;
    if (worklet) await new Promise<void>(resolve => {
      let timeout: ReturnType<typeof setTimeout>;
      const done = () => { clearTimeout(timeout); flushRef.current = null; resolve(); };
      flushRef.current = done;
      timeout = setTimeout(done, 200);
      worklet.port.postMessage({ type: 'flush' });
    });
    if (sessionRef.current !== id) return;
    releaseMicrophone();
    await audioQueue.current;
    if (sessionRef.current !== id) return;
    try { await callbacks.current.stopStream({ sessionId: id }); }
    catch (error) { if (sessionRef.current === id) fail(error); }
  };
  const handleEvent = (event: VoiceStreamEvent) => {
    if (!mounted.current || event.sessionId !== sessionRef.current) return;
    switch (event.type) {
      case 'ready': {
        if (phaseRef.current !== 'requesting') return;
        setElapsed(0);
        updatePhase('recording');
        workletRef.current?.port.postMessage({ type: 'start' });
        const startedAt = Date.now();
        timerRef.current = setInterval(() => setElapsed(Math.min(60, Math.floor((Date.now() - startedAt) / 1000))), 250);
        limitRef.current = setTimeout(() => void stop(), MAX_DURATION);
        break;
      }
      case 'partial': callbacks.current.onPartialTranscript(event.text || ''); break;
      case 'speech_started': break;
      case 'speech_stopped': releaseMicrophone(); updatePhase('transcribing'); break;
      case 'final': {
        const text = event.text?.trim();
        finish();
        if (text) { setNotice(''); setFailed(false); callbacks.current.onTranscript(text); }
        else { setNotice('No speech detected. Tap the microphone and try again.'); setFailed(false); }
        break;
      }
      case 'error': fail(new Error(event.message || 'Voice transcription stopped. Please try again.')); break;
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const id = sessionRef.current;
      finish();
      if (id) void callbacks.current.stopStream({ sessionId: id, cancel: true }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (phase === 'idle') return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [phase]);
  useEffect(() => {
    if (!notice || failed || phase !== 'idle') return;
    const timeout = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timeout);
  }, [notice, failed, phase]);

  const start = async () => {
    if (phaseRef.current !== 'idle' || disabled) return;
    setNotice(''); setFailed(false);
    if (!hasOpenAIKey) { setFailed(true); setNotice('Add an OpenAI API key in Settings for voice input. Your chat model can stay unchanged.'); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') { setFailed(true); setNotice('Microphone streaming is unavailable in this app session. Restart TaskSprig and try again.'); return; }
    const currentAttempt = ++attempt.current;
    const active = () => mounted.current && currentAttempt === attempt.current;
    updatePhase('requesting');
    try {
      await callbacks.current.requestPermission();
      if (!active()) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
      if (!active()) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      // Chromium resamples the microphone into this context's 24 kHz PCM stream.
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      contextRef.current = context;
      if (context.sampleRate !== SAMPLE_RATE) throw new Error('This microphone could not provide the audio format needed for streaming.');
      await context.audioWorklet.addModule(workletUrl);
      if (!active()) return;
      const source = context.createMediaStreamSource(stream);
      sourceRef.current = source;
      const worklet = new AudioWorkletNode(context, 'tasksprig-voice-capture', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      workletRef.current = worklet;
      audioQueue.current = Promise.resolve();
      worklet.port.onmessage = (message: MessageEvent<{ type: string; audio?: ArrayBuffer }>) => {
        if (message.data.type === 'flushed') { flushRef.current?.(); return; }
        const id = sessionRef.current;
        if (message.data.type !== 'audio' || !message.data.audio || !id || !active()) return;
        const audio = new Uint8Array(message.data.audio);
        audioQueue.current = audioQueue.current.then(async () => {
          if (sessionRef.current === id) await callbacks.current.sendAudio({ sessionId: id, audio });
        }).catch(error => { if (sessionRef.current === id) fail(error); });
      };
      // The worklet emits silence on its output, so capture is never played through the speakers.
      source.connect(worklet); worklet.connect(context.destination);
      await context.resume();
      if (!active()) return;
      const pending: VoiceStreamEvent[] = [];
      unsubscribeRef.current = callbacks.current.onStreamEvent(event => {
        if (!sessionRef.current) { if (active() && pending.length < 20) pending.push(event); }
        else handleEvent(event);
      });
      const { sessionId } = await callbacks.current.startStream();
      if (!active()) { void callbacks.current.stopStream({ sessionId, cancel: true }).catch(() => {}); return; }
      sessionRef.current = sessionId;
      pending.forEach(handleEvent);
    } catch (error) { if (active()) fail(error); }
  };

  const status = phase === 'recording'
    ? `Listening ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} · pause to send · Esc to cancel`
    : phase === 'requesting' ? 'Starting voice input…'
      : phase === 'transcribing' ? 'Finishing transcript… · Esc to cancel' : notice;
  return <div className="voice-input">
    <button type="button" className={`voice-button ${phase === 'recording' ? 'recording' : ''}`} aria-label={phase === 'recording' ? 'Stop recording' : 'Record voice'} aria-pressed={phase === 'recording'} title={phase === 'recording' ? 'Stop recording and send' : 'Record voice · live transcription by OpenAI · pause to send'} disabled={phase === 'requesting' || phase === 'transcribing' || (disabled && phase !== 'recording')} onClick={() => phase === 'recording' ? void stop() : void start()}>
      {phase === 'recording' ? <span className="voice-stop"/> : <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>}
    </button>
    {status && <div className={`voice-status ${failed ? 'error' : ''}`} role={failed ? 'alert' : 'status'}>{status}{failed && <button type="button" aria-label="Dismiss voice message" onClick={() => { setNotice(''); setFailed(false); }}>×</button>}</div>}
  </div>;
}
