import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatSession, ChatMessage, AttachedFile } from '../../shared/types';
import { ToolCallBadge } from './ToolCallBadge';
import { ConfirmationBar } from './ConfirmationBar';
import { SessionSettingsModal } from './SessionSettingsModal';
import { ChartBlock } from './ChartBlock';
import { useVoiceInput } from '../hooks/useVoiceInput';
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

interface Props {
  session: ChatSession;
  onUpdateSession: (id: string, updates: Partial<ChatSession>) => Promise<void>;
  highlightMessageId: string | null;
  onHighlightConsumed: () => void;
}

export function ChatView({ session, onUpdateSession, highlightMessageId, onHighlightConsumed }: Props) {
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
  const [pendingConfirm, setPendingConfirm] = useState<{ toolName: string; input: Record<string, unknown> } | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [autoApprove, setAutoApprove] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    const sameYear = d.getFullYear() === now.getFullYear();
    const datePart = d.toLocaleDateString('uk-UA',
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

  // Voice input
  const { isListening, interimText, toggle: toggleVoice } = useVoiceInput((text) => {
    setInput(prev => prev ? `${prev} ${text}` : text);
    inputRef.current?.focus();
  });

  // Load saved messages & autoApprove state when session changes
  useEffect(() => {
    api.getMessages(session.id).then((saved: ChatMessage[]) => {
      setMessages(saved && saved.length > 0 ? saved : []);
    });
    api.getAutoApprove(session.id).then((v: boolean) => setAutoApprove(v));
    setStreamingText('');
    setActiveTools([]);
    setIsLoading(false);
    setPendingConfirm(null);
  }, [session.id]);

  const toggleAutoApprove = async () => {
    const next = !autoApprove;
    setAutoApprove(next);
    await api.setAutoApprove(session.id, next);
    // If enabling — auto-approve any pending confirmation
    if (next && pendingConfirm) {
      await api.confirmMutation(session.id);
      setPendingConfirm(null);
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

  // Auto-scroll to bottom — skip when we're about to jump to a highlighted message.
  // Reading the flag from a ref (not a dep) prevents re-running when the highlight
  // gets consumed, which would otherwise yank the view back to the bottom.
  useEffect(() => {
    if (highlightRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

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
        setStreamingText(prev => prev + text);
      }),
      api.onStreamToolCall((sid: string, toolName: string, _toolInput: Record<string, unknown>) => {
        if (sid !== session.id) return;
        setActiveTools(prev => [...prev, toolName]);
      }),
      api.onStreamToolPermission((sid: string, toolName: string, toolInput: Record<string, unknown>) => {
        if (sid !== session.id) return;
        setPendingConfirm({ toolName, input: toolInput });
      }),
      api.onStreamDone((sid: string, fullText: string) => {
        if (sid !== session.id) return;
        addMessage({ id: crypto.randomUUID(), role: 'assistant', content: fullText, timestamp: Date.now() });
        setStreamingText('');
        setActiveTools([]);
        setIsLoading(false);
      }),
      api.onStreamError((sid: string, error: string) => {
        if (sid !== session.id) return;
        addMessage({ id: crypto.randomUUID(), role: 'assistant', content: `**Помилка:** ${error}`, timestamp: Date.now() });
        setStreamingText('');
        setActiveTools([]);
        setIsLoading(false);
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [session.id, addMessage]);

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

    addMessage(userMsg);
    setInput('');
    setIsLoading(true);
    setStreamingText('');

    if (attachedFiles.length > 0) {
      api.sendMessageWithFiles(session.id, text, attachedFiles.map((f: AttachedFile) => f.path));
      setAttachedFiles([]);
    } else {
      api.sendMessage(session.id, text);
    }
  }, [input, isLoading, session.id, attachedFiles]);

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

  const handleConfirm = async () => {
    await api.confirmMutation(session.id);
    setPendingConfirm(null);
  };

  const handleReject = async () => {
    await api.rejectMutation(session.id);
    setPendingConfirm(null);
  };

  const handleCancel = () => {
    api.cancelMessage(session.id);
    setIsLoading(false);
    setStreamingText('');
    setActiveTools([]);
  };

  const startIntegration = () => {
    if (isLoading) return;

    const text = 'Хочу підключити інтеграцію';
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(userMsg);
    setIsLoading(true);
    setStreamingText('');
    api.sendMessage(session.id, text);
  };

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <h2>{session.name}</h2>
          <button
            className={styles.settingsBtn}
            onClick={() => setShowSettings(true)}
            title="Налаштування компанії"
            aria-label="Налаштування"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.autoApproveToggle} title="Виконувати всі дії без підтвердження">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={toggleAutoApprove}
            />
            <span>Авто-підтвердження</span>
          </label>
          <button
            className={`${styles.newChatBtn} ${confirmingNewChat ? styles.newChatBtnConfirm : ''}`}
            onClick={async () => {
              if (!confirmingNewChat) {
                setConfirmingNewChat(true);
                setTimeout(() => setConfirmingNewChat(false), 3000);
                return;
              }
              setConfirmingNewChat(false);
              await api.newChat(session.id);
              setMessages([]);
              setStreamingText('');
              setActiveTools([]);
              setIsLoading(false);
            }}
            disabled={isLoading}
            title={confirmingNewChat ? 'Історія зникне. Натисни ще раз' : 'Новий чат'}
          >
            {confirmingNewChat ? 'Точно?' : 'Новий чат'}
          </button>
          <button className={styles.integrationBtn} onClick={startIntegration} disabled={isLoading}>
            ⚡ Інтеграція
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className={styles.messages} ref={messagesContainerRef}>
        {messages.length === 0 && !streamingText && (
          <div className={styles.welcome}>
            <div className={styles.welcomeIcon}>✦</div>
            <h2>Fol<span className={styles.welcomeAccent}>io</span></h2>
            <p>Інтелектуальний асистент для управління фінансами</p>
            <div className={styles.suggestions}>
              <button onClick={() => setInput('Покажи баланси всіх рахунків')}>
                Баланси рахунків
              </button>
              <button onClick={() => setInput('Покажи витрати за останній місяць')}>
                Витрати за місяць
              </button>
              <button onClick={() => setInput('Знайди дублікати транзакцій')}>
                Пошук дублікатів
              </button>
              <button onClick={() => setInput('Які операції без категорії?')}>
                Без категорії
              </button>
              <button onClick={startIntegration} className={styles.integrationSuggestion}>
                ⚡ Підключити інтеграцію
              </button>
            </div>
          </div>
        )}

        {messages.map(msg => (
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                ) : (
                  <p>{msg.content}</p>
                )}
              </div>
              <div className={styles.messageMeta}>
                <span className={styles.timestamp}>{formatTime(msg.timestamp)}</span>
                <button
                  className={`${styles.copyBtn} ${copiedId === msg.id ? styles.copied : ''}`}
                  onClick={() => handleCopy(msg.id, msg.content)}
                  title={copiedId === msg.id ? 'Скопійовано' : 'Копіювати'}
                  aria-label="Копіювати повідомлення"
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
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{streamingText}</ReactMarkdown>
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
              <span className={styles.thinkingText}>думаю...</span>
            </div>
          </div>
        )}

        {/* Active tool calls */}
        {activeTools.length > 0 && (
          <div className={styles.toolCalls}>
            {activeTools.map((tool, i) => (
              <ToolCallBadge key={i} name={tool} />
            ))}
          </div>
        )}

        {/* Confirmation bar */}
        {pendingConfirm && (
          <ConfirmationBar
            toolName={pendingConfirm.toolName}
            input={pendingConfirm.input}
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
          title="Прикріпити файл"
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
          placeholder="Напишіть повідомлення..."
          rows={2}
          disabled={isLoading}
        />

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

      {showSettings && (
        <SessionSettingsModal
          session={session}
          onClose={() => setShowSettings(false)}
          onSave={async ({ name, notes }) => {
            await onUpdateSession(session.id, { name, notes });
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}
