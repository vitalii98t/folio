import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatSession, ChatMessage, AttachedFile, MessageUsage, ContextUsage, AgentEvent, AgentRunSummary, RateLimitSnapshot } from '../../shared/types';
import { ToolCallBadge } from './ToolCallBadge';
import { ConfirmationBar } from './ConfirmationBar';
import { SessionSettingsModal } from './SessionSettingsModal';
import { ChartBlock } from './ChartBlock';
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary';
import { AgentsPanel, applyAgentEvent, summariseAgents, useAgentTypeLabel, type AgentRun } from './AgentsPanel';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useT, type TFunction } from '../i18n';
import styles from '../styles/ChatView.module.css';

/** Custom renderer for ReactMarkdown code blocks — intercepts finapse-chart. */
const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w[\w-]*)/.exec(className || '');
    const lang = match?.[1];
    if (lang === 'finapse-chart') {
      return <ChartBlock raw={String(children).replace(/\n$/, '')} />;
    }
    return <code className={className} {...props}>{children}</code>;
  },
};

const api = (window as any).finmapAgent;

/** Assumed until the SDK reports the real window in its first result. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** How often buffered stream chunks are flushed into React state. */
const STREAM_FLUSH_MS = 40;

const formatSeconds = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 10_000 ? `${Math.round(n / 1000)}k`
  : n >= 1000 ? `${(n / 1000).toFixed(1)}k`
  : String(n);

function formatDuration(ms: number, t: TFunction): string {
  const s = Math.round(ms / 1000);
  return s < 60
    ? t('chatView.durationSec', { s })
    : t('chatView.durationMin', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

function usageDetails(u: MessageUsage, t: TFunction): string {
  return [
    t('chatView.usageOutput', { n: formatTokens(u.outputTokens) }),
    t('chatView.usageInput', { n: formatTokens(u.inputTokens), cached: formatTokens(u.cacheReadTokens) }),
    t('chatView.usageTurns', { n: u.numTurns }),
    u.contextTokens != null ? t('chatView.usageContext', { n: formatTokens(u.contextTokens) }) : '',
    u.model ? t('chatView.usageModel', { model: u.model }) : '',
  ].filter(Boolean).join('\n');
}

function agentsDetails(list: AgentRunSummary[], t: TFunction, typeLabel: (type: string) => string): string {
  return list.map(a => t('agents.summaryLine', {
    status: a.ok ? '✓' : '✕',
    type: typeLabel(a.type),
    description: a.description,
    tools: t('agents.tools', { n: a.toolCount }),
    duration: formatDuration(a.durationMs, t),
  })).join('\n');
}

interface Props {
  session: ChatSession;
  onUpdateSession: (id: string, updates: Partial<ChatSession>) => Promise<void>;
  highlightMessageId: string | null;
  onHighlightConsumed: () => void;
  /** Whether this build ships a speech-recognition key (mic enabled). */
  voiceAvailable: boolean;
  /** Claude plan limits (account-wide), null until the CLI reports them. */
  rateLimit: RateLimitSnapshot | null;
}

export function ChatView({ session, onUpdateSession, highlightMessageId, onHighlightConsumed, voiceAvailable, rateLimit }: Props) {
  const { t, locale } = useT();
  const agentTypeLabel = useAgentTypeLabel();
  const [showSettings, setShowSettings] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [confirmingNewChat, setConfirmingNewChat] = useState(false);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<string | null>(null);
  highlightRef.current = highlightMessageId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [activeTools, setActiveTools] = useState<string[]>([]);
  // FIFO queue of mutations awaiting confirmation — Claude can fire several
  // tool calls in parallel; the bar shows the first + a "+N queued" counter.
  const [pendingConfirms, setPendingConfirms] = useState<{ toolName: string; input: Record<string, unknown> }[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  /** True while waiting for first response after sending attachments — files
   *  are parsed in main before Claude even starts, show a distinct hint. */
  const [parsingFiles, setParsingFiles] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Live context-window fill for the header badge. Seeded from the session
   *  (persisted after each reply), refreshed by STREAM_USAGE while Claude works. */
  const [context, setContext] = useState<ContextUsage | null>(null);
  /** Drag-and-drop depth counter — dragenter/dragleave fire for every child
   *  element, so a plain boolean flickers. */
  const [dragDepth, setDragDepth] = useState(0);
  /** Subagents Claude launched for the reply in progress. */
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const agentsRef = useRef<AgentRun[]>([]);
  agentsRef.current = agents;
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Token streaming arrives as many tiny IPC chunks; re-rendering markdown on
  // each would burn CPU. Buffer and flush ~25×/s instead.
  const chunkBufRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-scroll only while the user is already at the bottom — reading an
  // earlier message while a long answer streams must not yank the view.
  const stickToBottomRef = useRef(true);
  const onUpdateSessionRef = useRef(onUpdateSession);
  onUpdateSessionRef.current = onUpdateSession;

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    const sameYear = d.getFullYear() === now.getFullYear();
    const datePart = d.toLocaleDateString(locale,
      sameYear
        ? { day: '2-digit', month: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' }
    );
    return `${datePart} ${time}`;
  };

  const handleCopy = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(prev => (prev === id ? null : prev)), 1500);
    } catch {
      // clipboard API may be unavailable in some contexts
    }
  };

  // ── Streaming buffer ──────────────────────────────────────────
  const flushChunks = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const buf = chunkBufRef.current;
    if (!buf) return;
    chunkBufRef.current = '';
    setStreamingText(prev => prev + buf);
  }, []);

  const queueChunk = useCallback((text: string) => {
    chunkBufRef.current += text;
    if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushChunks, STREAM_FLUSH_MS);
  }, [flushChunks]);

  const dropChunks = useCallback(() => {
    chunkBufRef.current = '';
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  // ── Voice input ───────────────────────────────────────────────
  // Push-to-talk. Click mic → record; click again → main uploads the clip to
  // Groq Whisper (key baked into the build) and we append the text to the
  // draft, so the user reviews before sending.
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voice = useVoiceInput({
    onResult: (text) => {
      setInput(prev => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${text}` : text));
      inputRef.current?.focus();
    },
    onError: (message) => setVoiceError(message),
  });
  const voiceBusy = voice.status === 'starting' || voice.status === 'transcribing';

  // Voice errors self-dismiss; the next mic click clears them too.
  useEffect(() => {
    if (!voiceError) return;
    const timer = setTimeout(() => setVoiceError(null), 8000);
    return () => clearTimeout(timer);
  }, [voiceError]);

  const handleVoiceClick = () => {
    setVoiceError(null);
    if (!voiceAvailable) {
      setVoiceError(t('chatView.voiceUnavailable'));
      return;
    }
    voice.toggle();
  };

  // Escape while recording discards the clip — global listener because the
  // mic button (not the textarea) usually has focus at that point.
  useEffect(() => {
    if (voice.status !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        voice.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voice.status, voice.cancel]);

  // Load saved messages & autoApprove state when session changes
  useEffect(() => {
    api.getMessages(session.id).then((saved: ChatMessage[]) => {
      setMessages(saved && saved.length > 0 ? saved : []);
    });
    api.getAutoApprove(session.id).then((v: boolean) => setAutoApprove(v));
    dropChunks();
    setStreamingText('');
    setActiveTools([]);
    setIsLoading(false);
    setPendingConfirms([]);
    setParsingFiles(false);
    setDragDepth(0);
    setAgents([]);
    // A settings modal opened for the previous company must not stay mounted
    // against this one (Ctrl+K jump) — Save would overwrite this company.
    setShowSettings(false);
    stickToBottomRef.current = true;
    setContext(
      session.contextTokens != null
        ? { contextTokens: session.contextTokens, contextWindow: session.contextWindow }
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const toggleAutoApprove = async () => {
    const next = !autoApprove;
    setAutoApprove(next);
    await api.setAutoApprove(session.id, next);
    // If enabling — auto-approve everything currently pending
    if (next && pendingConfirms.length > 0) {
      for (let i = 0; i < pendingConfirms.length; i++) {
        await api.confirmMutation(session.id);
      }
      setPendingConfirms([]);
    }
  };

  // Auto-resize textarea whenever input changes
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '80px';
    if (el.scrollHeight > 80) {
      el.style.height = Math.min(el.scrollHeight, 300) + 'px';
    }
  }, [input]);

  // Auto-scroll to bottom — skip when we're about to jump to a highlighted
  // message, or when the user has scrolled up to read. Reading the flags
  // from refs (not deps) prevents re-running when the highlight gets
  // consumed, which would otherwise yank the view back to the bottom.
  useEffect(() => {
    if (highlightRef.current || !stickToBottomRef.current) return;
    // Instant while streaming: a smooth scroll that lags behind 25 flushes/s
    // would read as "not at bottom" and switch sticking off.
    bottomRef.current?.scrollIntoView({ behavior: streamingText ? 'auto' : 'smooth' });
  }, [messages, streamingText]);

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Scroll to and briefly pulse a searched-for message
  useEffect(() => {
    if (!highlightMessageId) return;
    if (!messages.some(m => m.id === highlightMessageId)) return;
    const raf = requestAnimationFrame(() => {
      const el = messagesContainerRef.current?.querySelector(
        `[data-message-id="${highlightMessageId}"]`
      ) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setPulseId(highlightMessageId);
    });
    const clearPulse = setTimeout(() => {
      setPulseId(null);
      onHighlightConsumed();
    }, 2200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(clearPulse);
    };
  }, [highlightMessageId, messages, onHighlightConsumed]);

  // Helper: add message to state and persist
  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => [...prev, msg]);
    api.addMessage(session.id, msg);
  }, [session.id]);

  // Setup stream listeners
  useEffect(() => {
    const unsubs = [
      api.onStreamChunk((sid: string, text: string) => {
        if (sid !== session.id) return;
        setParsingFiles(false);
        queueChunk(text);
      }),
      api.onStreamToolCall((sid: string, toolName: string, _toolInput: Record<string, unknown>) => {
        if (sid !== session.id) return;
        setParsingFiles(false);
        flushChunks();
        setActiveTools(prev => [...prev, toolName]);
      }),
      api.onStreamToolPermission((sid: string, toolName: string, toolInput: Record<string, unknown>) => {
        if (sid !== session.id) return;
        setPendingConfirms(prev => [...prev, { toolName, input: toolInput }]);
      }),
      api.onStreamUsage((sid: string, usage: ContextUsage) => {
        if (sid !== session.id) return;
        setContext(prev => ({
          contextTokens: usage.contextTokens,
          contextWindow: usage.contextWindow ?? prev?.contextWindow,
        }));
      }),
      api.onStreamAgent((sid: string, ev: AgentEvent) => {
        if (sid !== session.id) return;
        setParsingFiles(false);
        setAgents(prev => applyAgentEvent(prev, ev));
      }),
      api.onStreamCompact((sid: string, preTokens: number) => {
        if (sid !== session.id) return;
        flushChunks();
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          systemKind: 'compact',
          preTokens,
          content: t('chatView.compacted', { tokens: formatTokens(preTokens) }),
          timestamp: Date.now(),
        });
      }),
      api.onStreamDone((sid: string, fullText: string, usage?: MessageUsage) => {
        if (sid !== session.id) return;
        dropChunks();
        const agentSummary = agentsRef.current.length > 0 ? summariseAgents(agentsRef.current) : undefined;
        setAgents([]);
        addMessage({ id: crypto.randomUUID(), role: 'assistant', content: fullText, timestamp: Date.now(), usage, agents: agentSummary });
        setStreamingText('');
        setActiveTools([]);
        setIsLoading(false);
        setParsingFiles(false);
        setPendingConfirms([]);
        if (usage?.contextTokens != null) {
          setContext({ contextTokens: usage.contextTokens, contextWindow: usage.contextWindow });
          // Persist so the badge is right after a restart, before the next message.
          onUpdateSessionRef.current(session.id, { contextTokens: usage.contextTokens, contextWindow: usage.contextWindow });
        }
      }),
      api.onStreamError((sid: string, error: string) => {
        if (sid !== session.id) return;
        dropChunks();
        setAgents([]);
        addMessage({ id: crypto.randomUUID(), role: 'assistant', content: `${t('chatView.errorPrefix')}${error}`, timestamp: Date.now() });
        setStreamingText('');
        setActiveTools([]);
        setIsLoading(false);
        setParsingFiles(false);
        setPendingConfirms([]);
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [session.id, addMessage, queueChunk, flushChunks, dropChunks, t]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if ((!text && attachedFiles.length === 0) || isLoading) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text || (attachedFiles.length > 0 ? `[${attachedFiles.map(f => f.name).join(', ')}]` : ''),
      timestamp: Date.now(),
      attachments: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    };

    stickToBottomRef.current = true;
    addMessage(userMsg);
    setInput('');
    setIsLoading(true);
    setStreamingText('');

    if (attachedFiles.length > 0) {
      setParsingFiles(true);
      api.sendMessageWithFiles(session.id, text, attachedFiles.map((f: AttachedFile) => f.path));
      setAttachedFiles([]);
    } else {
      api.sendMessage(session.id, text);
    }
  }, [input, isLoading, session.id, attachedFiles, addMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAttach = async () => {
    const files = await api.selectFiles();
    if (files && files.length > 0) {
      setAttachedFiles(prev => [...prev, ...files]);
    }
  };

  const removeFile = (index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // ── Drag-and-drop + clipboard paste ───────────────────────────
  /** Turn File objects from a drop/paste into attachments. Files with an OS
   *  path (Explorer/Finder) go through main by path; path-less blobs
   *  (screenshots, images copied from a browser) are saved to disk first. */
  const attachFiles = async (files: File[]) => {
    const paths: string[] = [];
    const blobs: File[] = [];
    for (const f of files) {
      const p = api.getPathForFile(f);
      if (p) paths.push(p);
      else blobs.push(f);
    }
    const out: AttachedFile[] = [];
    if (paths.length > 0) out.push(...(await api.attachFilePaths(paths)));
    for (const b of blobs) {
      try {
        const bytes = new Uint8Array(await b.arrayBuffer());
        if (bytes.byteLength === 0) continue;
        out.push(await api.savePastedFile(bytes, b.type, b.name));
      } catch {
        // unreadable clipboard item — skip it
      }
    }
    if (out.length > 0) setAttachedFiles(prev => [...prev, ...out]);
  };

  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDragDepth(d => d + 1);
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDragDepth(d => Math.max(0, d - 1));
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDragDepth(0);
    void attachFiles(Array.from(e.dataTransfer.files));
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter(i => i.kind === 'file')
      .map(i => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return; // plain text — let the textarea handle it
    e.preventDefault();
    void attachFiles(files);
  };

  const handleConfirm = async () => {
    await api.confirmMutation(session.id);
    setPendingConfirms(prev => prev.slice(1));
  };

  const handleReject = async () => {
    await api.rejectMutation(session.id);
    setPendingConfirms(prev => prev.slice(1));
  };

  const handleCancel = () => {
    api.cancelMessage(session.id);
    dropChunks();
    setAgents([]);
    setIsLoading(false);
    setStreamingText('');
    setActiveTools([]);
    setParsingFiles(false);
    setPendingConfirms([]);
  };

  const startIntegration = () => {
    if (isLoading) return;

    const text = t('chatView.integrationPrompt');
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    stickToBottomRef.current = true;
    addMessage(userMsg);
    setIsLoading(true);
    setStreamingText('');
    api.sendMessage(session.id, text);
  };

  const handleNewChat = async () => {
    if (!confirmingNewChat) {
      setConfirmingNewChat(true);
      setTimeout(() => setConfirmingNewChat(false), 3000);
      return;
    }
    setConfirmingNewChat(false);
    await api.newChat(session.id);
    dropChunks();
    setAgents([]);
    setMessages([]);
    setStreamingText('');
    setActiveTools([]);
    setIsLoading(false);
    setContext(null);
    onUpdateSessionRef.current(session.id, { contextTokens: undefined, contextWindow: undefined });
  };

  // ── Header context badge ──────────────────────────────────────
  const contextWindow = context?.contextWindow ?? session.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const contextPct = context ? Math.min(100, Math.round((context.contextTokens / contextWindow) * 100)) : null;
  const contextTone =
    contextPct == null ? ''
    : contextPct >= 90 ? styles.contextDanger
    : contextPct >= 70 ? styles.contextWarn
    : '';
  const contextTitle = context
    ? t('chatView.contextTitle', { used: formatTokens(context.contextTokens), total: formatTokens(contextWindow), pct: contextPct ?? 0 })
    : '';
  const RING = 50.27; // 2π·8 — circumference of the badge ring

  // ── Header plan-limit badge (5-hour session window) ───────────
  const nowMs = Date.now();
  const fiveHour = rateLimit?.fiveHour && rateLimit.fiveHour.resetsAt > nowMs ? rateLimit.fiveHour : undefined;
  const sevenDay = rateLimit?.sevenDay && rateLimit.sevenDay.resetsAt > nowMs ? rateLimit.sevenDay : undefined;
  const limitPct = fiveHour ? Math.min(100, Math.round(fiveHour.utilization * 100)) : null;
  const limitRejected = rateLimit?.status === 'rejected' && !!fiveHour;
  const limitTone =
    limitPct == null ? ''
    : limitRejected || limitPct >= 90 ? styles.contextDanger
    : limitPct >= 70 || rateLimit?.status === 'allowed_warning' ? styles.contextWarn
    : '';
  const formatResetAt = (ms: number) => {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString()
      ? time
      : `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`;
  };
  const formatIn = (ms: number) => {
    const mins = Math.max(1, Math.round((ms - nowMs) / 60_000));
    const h = Math.floor(mins / 60);
    return h > 0 ? t('chatView.inHoursMinutes', { h, m: mins % 60 }) : t('chatView.inMinutes', { m: mins });
  };
  const limitTitle = fiveHour
    ? [
        limitRejected ? t('chatView.limitRejected') : '',
        t('chatView.limitTitle', { pct: limitPct ?? 0, at: formatResetAt(fiveHour.resetsAt), in: formatIn(fiveHour.resetsAt) }),
        sevenDay ? t('chatView.limitWeek', { pct: Math.round(sevenDay.utilization * 100), at: formatResetAt(sevenDay.resetsAt) }) : '',
      ].filter(Boolean).join('\n')
    : '';

  return (
    <div
      className={styles.container}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>{session.name}</h2>
          <button
            className={styles.settingsBtn}
            onClick={() => setShowSettings(true)}
            title={t('chatView.companySettings')}
            aria-label={t('chatView.settings')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
        <div className={styles.headerActions}>
          {limitPct != null && (
            <span className={`${styles.contextBadge} ${limitTone}`} title={limitTitle}>
              <span aria-hidden="true">⏱</span>
              <span>{limitPct}%</span>
            </span>
          )}
          {context && contextPct != null && (
            <span className={`${styles.contextBadge} ${contextTone}`} title={contextTitle}>
              <svg className={styles.contextRing} viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
                <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
                <circle
                  cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
                  strokeDasharray={`${(contextPct / 100) * RING} ${RING}`}
                  transform="rotate(-90 10 10)"
                />
              </svg>
              <span>{contextPct}%</span>
            </span>
          )}
          <label className={styles.autoApproveToggle} title={t('chatView.autoApproveHint')}>
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={toggleAutoApprove}
            />
            <span>{t('chatView.autoApprove')}</span>
          </label>
          <button
            className={`${styles.newChatBtn} ${confirmingNewChat ? styles.newChatBtnConfirm : ''}`}
            onClick={handleNewChat}
            disabled={isLoading}
            title={confirmingNewChat ? t('chatView.newChatConfirmHint') : t('chatView.newChat')}
          >
            {confirmingNewChat ? t('chatView.newChatConfirm') : t('chatView.newChat')}
          </button>
          <button className={styles.integrationBtn} onClick={startIntegration} disabled={isLoading}>
            {t('chatView.integrationBtn')}
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className={styles.messages} ref={messagesContainerRef} onScroll={handleMessagesScroll}>
        {messages.length === 0 && !streamingText && (
          <div className={styles.welcome}>
            <div className={styles.welcomeIcon}>✦</div>
            <h2>Fol<span className={styles.welcomeAccent}>io</span></h2>
            <p>{t('chatView.welcomeTagline')}</p>
            <div className={styles.suggestions}>
              <button onClick={() => setInput(t('chatView.suggestBalancesPrompt'))}>
                {t('chatView.suggestBalances')}
              </button>
              <button onClick={() => setInput(t('chatView.suggestExpensesPrompt'))}>
                {t('chatView.suggestExpenses')}
              </button>
              <button onClick={() => setInput(t('chatView.suggestDuplicatesPrompt'))}>
                {t('chatView.suggestDuplicates')}
              </button>
              <button onClick={() => setInput(t('chatView.suggestUncategorizedPrompt'))}>
                {t('chatView.suggestUncategorized')}
              </button>
              <button onClick={startIntegration} className={styles.integrationSuggestion}>
                {t('chatView.suggestIntegration')}
              </button>
            </div>
          </div>
        )}

        {messages.map(msg => msg.role === 'system' ? (
          <div
            key={msg.id}
            data-message-id={msg.id}
            className={styles.systemDivider}
            title={formatTime(msg.timestamp)}
          >
            <span>
              {msg.systemKind === 'compact' && msg.preTokens != null
                ? t('chatView.compacted', { tokens: formatTokens(msg.preTokens) })
                : msg.content}
            </span>
          </div>
        ) : (
          <div
            key={msg.id}
            data-message-id={msg.id}
            className={`${styles.message} ${styles[msg.role]} ${pulseId === msg.id ? styles.pulse : ''}`}
          >
            <div className={styles.messageColumn}>
              <div className={`${styles.bubble} ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                {/* Image attachments */}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className={styles.attachments}>
                    {msg.attachments.map((file, i) => (
                      <div key={i} className={styles.attachmentChip}>
                        {file.dataUrl ? (
                          <img src={file.dataUrl} alt={file.name} className={styles.attachmentImg} />
                        ) : (
                          <span className={styles.attachmentFile}>{file.name}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <MarkdownErrorBoundary raw={msg.content}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                  </MarkdownErrorBoundary>
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
              <div className={styles.messageMeta}>
                <span className={styles.timestamp}>{formatTime(msg.timestamp)}</span>
                {msg.usage && (
                  <span className={styles.usageMeta} title={usageDetails(msg.usage, t)}>
                    {formatDuration(msg.usage.durationMs, t)}
                  </span>
                )}
                {msg.agents && msg.agents.length > 0 && (
                  <span className={styles.usageMeta} title={agentsDetails(msg.agents, t, agentTypeLabel)}>
                    ✦ {t('agents.used', { n: msg.agents.length })}
                  </span>
                )}
                <button
                  className={`${styles.copyBtn} ${copiedId === msg.id ? styles.copied : ''}`}
                  onClick={() => handleCopy(msg.id, msg.content)}
                  title={copiedId === msg.id ? t('chatView.copied') : t('chatView.copy')}
                  aria-label={t('chatView.copyMessage')}
                >
                  {copiedId === msg.id ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {streamingText && (
          <div className={`${styles.message} ${styles.assistant}`}>
            <div className={`${styles.bubble} markdown-body`}>
              <MarkdownErrorBoundary raw={streamingText}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{streamingText}</ReactMarkdown>
              </MarkdownErrorBoundary>
            </div>
          </div>
        )}

        {/* Thinking indicator (shown while loading without text yet) */}
        {isLoading && !streamingText && (
          <div className={`${styles.message} ${styles.assistant}`}>
            <div className={styles.thinkingBubble}>
              <span className={styles.thinkingDot}></span>
              <span className={styles.thinkingDot}></span>
              <span className={styles.thinkingDot}></span>
              <span className={styles.thinkingText}>{parsingFiles ? t('chatView.parsingFiles') : t('chatView.thinking')}</span>
            </div>
          </div>
        )}

        {/* Subagents working on this reply */}
        {agents.length > 0 && <AgentsPanel agents={agents} />}

        {/* Active tool calls */}
        {activeTools.length > 0 && (
          <div className={styles.toolCalls}>
            {activeTools.map((tool, i) => (
              <ToolCallBadge key={i} name={tool} />
            ))}
          </div>
        )}

        {/* Confirmation bar — shows the oldest pending mutation; the rest queue */}
        {pendingConfirms.length > 0 && (
          <ConfirmationBar
            toolName={pendingConfirms[0].toolName}
            input={pendingConfirms[0].input}
            queueCount={pendingConfirms.length - 1}
            onConfirm={handleConfirm}
            onReject={handleReject}
          />
        )}

        <div ref={bottomRef} />
      </div>

      {/* Attached files preview */}
      {attachedFiles.length > 0 && (
        <div className={styles.attachedBar}>
          {attachedFiles.map((file, i) => (
            <div key={i} className={styles.attachedItem}>
              {file.dataUrl ? (
                <img src={file.dataUrl} alt={file.name} className={styles.attachedThumb} />
              ) : (
                <span className={styles.attachedName}>{file.name}</span>
              )}
              <button className={styles.attachedRemove} onClick={() => removeFile(i)}>&times;</button>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div className={styles.inputArea}>
        <button
          className={styles.iconBtn}
          onClick={handleAttach}
          title={t('chatView.attachFile')}
          disabled={isLoading}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.98 8.83l-8.58 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        <textarea
          ref={inputRef}
          className={styles.textarea}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={voice.status === 'recording' ? t('chatView.listening') : t('chatView.inputPlaceholder')}
          rows={2}
          disabled={isLoading}
        />

        {/* Voice state pill — floats over the input's top edge so a long
            error message never squeezes the textarea */}
        {(voice.status === 'recording' || voice.status === 'transcribing' || voiceError) && (
          <span
            className={`${styles.voiceStatus} ${voiceError ? styles.voiceStatusError : ''}`}
            title={voiceError ?? undefined}
          >
            {voiceError ? (
              voiceError
            ) : voice.status === 'recording' ? (
              <>
                <span className={styles.recDot} />
                {formatSeconds(voice.seconds)}
              </>
            ) : (
              t('chatView.transcribing')
            )}
          </span>
        )}

        <button
          className={`${styles.iconBtn} ${voice.status === 'recording' ? styles.iconBtnActive : ''} ${voiceBusy ? styles.iconBtnBusy : ''}`}
          onClick={handleVoiceClick}
          disabled={isLoading || voiceBusy}
          title={
            !voiceAvailable ? t('chatView.voiceUnavailable')
            : voice.status === 'recording' ? t('chatView.voiceStop')
            : voiceBusy ? t('chatView.voiceBusy')
            : t('chatView.voiceStart')
          }
          aria-label={t('chatView.voiceLabel')}
        >
          {voice.status === 'recording' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : voiceBusy ? (
            <span className={styles.spinner} />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          )}
        </button>

        {isLoading ? (
          <button className={styles.cancelBtn} onClick={handleCancel}>
            ⏹
          </button>
        ) : (
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!input.trim() && attachedFiles.length === 0}
          >
            ↑
          </button>
        )}
      </div>

      {/* Drop target overlay — pointer-events: none so it never steals the
          drop or triggers extra dragenter/dragleave pairs */}
      {dragDepth > 0 && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropOverlayInner}>
            <span className={styles.dropIcon}>⤓</span>
            <span>{t('chatView.dropHere')}</span>
          </div>
        </div>
      )}

      {showSettings && (
        <SessionSettingsModal
          key={session.id}
          session={session}
          onUpdateSession={onUpdateSession}
          onClose={() => setShowSettings(false)}
          onSave={async ({ name, notes, model }) => {
            await onUpdateSession(session.id, { name, notes, model: model || undefined });
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}
