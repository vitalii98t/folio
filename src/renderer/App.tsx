import { useState, useEffect } from 'react';
import type { ChatSession, ClaudeCodeStatus } from '../shared/types';
import { SetupScreen } from './components/SetupScreen';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { NewSessionModal } from './components/NewSessionModal';
import { SearchModal } from './components/SearchModal';
import { TaskToasts } from './components/TaskToasts';
import styles from './styles/App.module.css';

const api = (window as any).finmapAgent;

export function App() {
  const [claudeStatus, setClaudeStatus] = useState<ClaudeCodeStatus | 'loading'>('loading');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);

  // Global Ctrl+K / Cmd+K to open search.
  // Use e.code (physical key) so it works regardless of keyboard layout —
  // on Ukrainian layout pressing the K key gives e.key='к' (Cyrillic), not 'k'.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
        e.preventDefault();
        setShowSearch(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Check Claude Code status on mount
  useEffect(() => {
    api.checkClaudeStatus().then((status: ClaudeCodeStatus) => {
      setClaudeStatus(status);
    });
  }, []);

  // Load sessions
  useEffect(() => {
    if (claudeStatus === 'ready') {
      api.getSessions().then((list: ChatSession[]) => {
        setSessions(list);
        if (list.length > 0 && !activeSessionId) {
          setActiveSessionId(list[0].id);
        }
      });
    }
  }, [claudeStatus]);

  // Show setup screen if Claude Code not ready
  if (claudeStatus === 'loading') {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <p>Перевіряю Claude Code...</p>
      </div>
    );
  }

  if (claudeStatus !== 'ready') {
    return (
      <SetupScreen
        status={claudeStatus}
        onRetry={() => {
          setClaudeStatus('loading');
          api.checkClaudeStatus().then(setClaudeStatus);
        }}
        onLogin={() => api.openClaudeLogin()}
      />
    );
  }

  // No sessions yet — prompt to create one
  if (sessions.length === 0 && !showNewSession) {
    return (
      <div className={styles.emptyState}>
        <div className={styles.emptyCard}>
          <h1>Folio</h1>
          <p>AI-асистент для управління фінансами</p>
          <button className={styles.primaryBtn} onClick={() => setShowNewSession(true)}>
            Додати компанію
          </button>
        </div>
      </div>
    );
  }

  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null;

  async function handleCreateSession(name: string, apiKey: string) {
    const session = await api.createSession({ name, apiKey });
    setSessions(prev => [...prev, session]);
    setActiveSessionId(session.id);
    setShowNewSession(false);
  }

  async function handleDeleteSession(id: string) {
    await api.deleteSession(id);
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) {
      const remaining = sessions.filter(s => s.id !== id);
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
    }
  }

  async function handleUpdateSession(id: string, updates: Partial<ChatSession>) {
    const updated = await api.updateSession(id, updates);
    if (updated) {
      setSessions(prev => prev.map(s => (s.id === id ? updated : s)));
    }
  }

  return (
    <div className={styles.app}>
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={setActiveSessionId}
        onNew={() => setShowNewSession(true)}
        onDelete={handleDeleteSession}
        onSearch={() => setShowSearch(true)}
      />
      <main className={styles.main}>
        {activeSession ? (
          <ChatView
            session={activeSession}
            onUpdateSession={handleUpdateSession}
            highlightMessageId={highlightMessageId}
            onHighlightConsumed={() => setHighlightMessageId(null)}
          />
        ) : (
          <div className={styles.noSession}>
            <p>Оберіть компанію або створіть нову</p>
          </div>
        )}
      </main>

      {showNewSession && (
        <NewSessionModal
          onClose={() => setShowNewSession(false)}
          onCreate={handleCreateSession}
        />
      )}

      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onJump={(sessionId, messageId) => {
            setActiveSessionId(sessionId);
            setHighlightMessageId(messageId);
          }}
        />
      )}

      <TaskToasts />
    </div>
  );
}
