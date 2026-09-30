import { useState, useRef, useCallback, useEffect } from 'react';
import type { TranscribeResult } from '../../shared/types';
import { useT, type TFunction } from '../i18n';

/**
 * Push-to-talk voice input.
 *
 * Click → record via MediaRecorder (webm/opus) → click again → bytes go to
 * main over IPC, which uploads them to the configured speech-to-text
 * provider and hands the text back.
 *
 * Why not the Web Speech API the previous version used: in Electron
 * `webkitSpeechRecognition` exists but `start()` fails with a `network`
 * error — Chromium's recogniser is a Google-hosted service that needs API
 * keys only Chrome ships with. So we record ourselves and pick the backend.
 */

const api = (window as any).finmapAgent;

/** Hard stop so a forgotten recording can't grow past provider upload
 *  limits (Groq free tier: 25 MB). At 32 kbps opus, 10 min ≈ 2.4 MB. */
const MAX_RECORDING_MS = 10 * 60_000;

/** Input level meter. Whisper invents text on silence ("thanks for watching"),
 *  and the provider rates that as speech, so the only reliable guard is to
 *  not upload clips in which the mic never heard a voice. */
const METER_INTERVAL_MS = 100;
/** RMS (0..1) above which a 100 ms frame counts as voice. Silence with the
 *  browser's noise suppression sits around 0.001–0.005; speech 0.03+. */
const VOICE_RMS = 0.015;
/** Minimum voiced frames (×100 ms) for a clip to be worth transcribing. */
const MIN_VOICED_FRAMES = 3;

interface LevelMeter {
  voiced: number;
  stop: () => void;
}

function startLevelMeter(stream: MediaStream): LevelMeter | null {
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const meter: LevelMeter = {
      voiced: 0,
      stop: () => {
        clearInterval(timer);
        try { source.disconnect(); } catch {}
        void ctx.close().catch(() => {});
      },
    };
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      if (Math.sqrt(sum / buf.length) > VOICE_RMS) meter.voiced++;
    }, METER_INTERVAL_MS);
    return meter;
  } catch {
    return null; // no Web Audio — don't block uploads on a missing meter
  }
}

export type VoiceStatus = 'idle' | 'starting' | 'recording' | 'transcribing';

interface Options {
  /** Receives the recognised text once the provider answers. */
  onResult: (text: string) => void;
  /** Receives a human-readable message when anything fails. */
  onError: (message: string) => void;
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find(c => MediaRecorder.isTypeSupported(c)) ?? '';
}

function describeMediaError(err: any, t: TFunction): string {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return t('voice.micDenied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
    return t('voice.micNotFound');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return t('voice.micBusy');
  }
  return t('voice.micStartFailed', { detail: String(err?.message ?? err) });
}

export function useVoiceInput({ onResult, onError }: Options) {
  const { t } = useT();
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set by cancel() / unmount so onstop discards the clip instead of uploading. */
  const discardRef = useRef(false);
  const meterRef = useRef<LevelMeter | null>(null);
  // Latest callbacks (and translator) without re-creating start/stop on every render.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const tRef = useRef(t);
  onResultRef.current = onResult;
  onErrorRef.current = onError;
  tRef.current = t;

  const releaseStream = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    meterRef.current?.stop();
    meterRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    setStatus('starting');
    try {
      // macOS shows its TCC prompt from main; elsewhere this resolves true.
      const allowed: boolean = await api.requestMicAccess();
      if (!allowed) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32_000,
      });
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => {
        discardRef.current = true;
        const t = tRef.current;
        onErrorRef.current(t('voice.recordingInterrupted'));
        try { recorder.stop(); } catch {}
      };
      recorder.onstop = async () => {
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const voiced = meterRef.current ? meterRef.current.voiced : Infinity;
        releaseStream();
        if (discardRef.current || chunks.length === 0) {
          setStatus('idle');
          setSeconds(0);
          return;
        }
        if (voiced < MIN_VOICED_FRAMES) {
          setStatus('idle');
          setSeconds(0);
          const t = tRef.current;
          onErrorRef.current(t('voice.noSpeech'));
          return;
        }
        setStatus('transcribing');
        try {
          const blob = new Blob(chunks, { type });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const result: TranscribeResult = await api.transcribeAudio(bytes, type);
          if (result.ok) onResultRef.current(result.text);
          else onErrorRef.current(result.error);
        } catch (err: any) {
          const t = tRef.current;
          onErrorRef.current(t('voice.transcribeFailed', { detail: String(err?.message ?? err) }));
        } finally {
          setStatus('idle');
          setSeconds(0);
        }
      };

      streamRef.current = stream;
      meterRef.current = startLevelMeter(stream);
      recorderRef.current = recorder;
      recorder.start(1000); // timeslice — flush a chunk every second
      setSeconds(0);
      setStatus('recording');
      const startedAt = Date.now();
      tickRef.current = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
      maxTimerRef.current = setTimeout(() => { try { recorder.stop(); } catch {} }, MAX_RECORDING_MS);
    } catch (err: any) {
      releaseStream();
      setStatus('idle');
      onErrorRef.current(describeMediaError(err, tRef.current));
    }
  }, [releaseStream]);

  /** Finish recording and send the clip for transcription. */
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state !== 'inactive') rec.stop(); // onstop does the rest
  }, []);

  /** Drop the recording without transcribing (Escape). */
  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    discardRef.current = true;
    if (rec.state !== 'inactive') {
      rec.stop();
    } else {
      releaseStream();
      setStatus('idle');
      setSeconds(0);
    }
  }, [releaseStream]);

  const toggle = useCallback(() => {
    if (status === 'recording') stop();
    else if (status === 'idle') void start();
  }, [status, start, stop]);

  // Release the mic if the component unmounts mid-recording (session switch).
  useEffect(() => () => {
    discardRef.current = true;
    try { recorderRef.current?.stop(); } catch {}
    releaseStream();
  }, [releaseStream]);

  return { status, seconds, toggle, cancel };
}
