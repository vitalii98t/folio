import { useState, useEffect } from 'react';
import type { ChatSession, ClaudeCodeStatus, UpdateStatusEvent, AppSettings, RateLimitSnapshot } from '../shared/types';
import { DEFAULT_UI_LANGUAGE } from '../shared/types';
import { SetupScreen } from './components/SetupScreen';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { NewSessionModal } from './components/NewSessionModal';
import { SearchModal } from './components/SearchModal';
import { AppSettingsModal } from './components/AppSettingsModal';
import { TaskToasts } from './components/TaskToasts';
import { I18nProvider, useT } from './i18n';
import styles from './styles/App.module.css';

const api = (window as any).finmapAgent;

/**
 * Outer shell owns app-wide settings so the i18n provider can wrap every
 * screen — including the setup screen shown before Claude is ready.
 */
export function App() {
  const [appSettings, setAppSettings] = useState<AppSettings>({});
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  useEffect(() => {
    api.getAppSettings?.()
      .then((s: AppSettings) => setAppSettings(s ?? {}))
      .catch(() => {});
    api.voiceAvailable?.()
      .then((v: boolean) => setVoiceAvailable(Boolean(v)))
      .catch(() => {});
  }, []);

  return (
    <I18nProvider lang={appSettings.uiLanguage ?? DEFAULT_UI_LANGUAGE}>
      <AppShell appSettings={appSettings} voiceAvailable={voiceAvailable} onSettingsChange={setAppSettings} />
    </I18nProvider>
  );
}

interface ShellProps {
  appSettings: AppSettings;
  voiceAvailable: boolean;
  onSettingsChange: (s: AppSettings) => void;
}

function AppShell({ appSettings, voiceAvailable, onSettingsChange }: ShellProps) {
  const { t } = useT();
  const [claudeStatus, setClaudeStatus] = useState<ClaudeCodeStatus | 'loading'>('loading');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [reAuthChecking, setReAuthChecking] = useState(false);
  const [updateReady, setUpdateReady] = useState<string | null>(null); // version downloaded & ready
  const [showAppSettings, setShowAppSettings] = useState(false);
  // Claude plan limits are account-wide, so they live here, not per chat.
  const [rateLimit, setRateLimit] = useState<RateLimitSnapshot | null>(null);
  useEffect(() => {
    api.getRateLimit?.().then((s: RateLimitSnapshot | null) => { if (s) setRateLimit(s); }).catch(() => {});
    const unsub = api.onRateLimit?.((s: RateLimitSnapshot) => setRateLimit(s));
    return unsub;
  }, []);

  // Listen to runtime auth-error events from main — Claude SDK 401/403/expired
  useEffect(() => {
    const unsub = api.onStreamAuthError((_sid: string, message: string) => {
      setAuthError(message);
    });
    return unsub;
  }, []);

  // Auto-update: show restart prompt once the new version is downloaded
  useEffect(() => {
    const unsub = api.onUpdateStatus?.((e: UpdateStatusEvent) => {
      if (e.status === 'downloaded') setUpdateReady(e.version ?? '');
    });
    return unsub;
  }, []);

  async function recheckAuth() {
    setReAuthChecking(true);
    const status = await api.checkClaudeStatus();
    setReAuthChecking(false);
    if (status === 'ready') {
      setAuthError(null);
      setClaudeStatus('ready');
    }
  }

  // Global Ctrl+K / Cmd+K to open search.
  // Use e.code (physical key) so it works regardless of keyboard layout —
  // on a Ukrainian layout the K key reports a Cyrillic e.key, not 'k'.
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
        <p>{t('app.checkingClaude')}</p>
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
          <p>{t('app.tagline')}</p>
          <button className={styles.primaryBtn} onClick={() => setShowNewSession(true)}>
            {t('app.addCompany')}
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

  async function handleClaudeLogout() {
    if (!confirm(t('app.logoutConfirm'))) return;
    const result = await api.claudeLogout();
    if (!result.ok) {
      alert(t('app.logoutFailed', { error: result.error }));
      return;
    }
    // Re-sync local state with the now-cleared session ids
    const fresh = await api.getSessions();
    setSessions(fresh);
    setAuthError(null);
    // Force the setup-screen branch — user clicks "Sign in to Claude Code" to re-auth
    setClaudeStatus('not_authenticated');
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
        onClaudeLogout={handleClaudeLogout}
        onOpenSettings={() => setShowAppSettings(true)}
      />
      <main className={styles.main}>
        {activeSession ? (
          <ChatView
            session={activeSession}
            onUpdateSession={handleUpdateSession}
            highlightMessageId={highlightMessageId}
            onHighlightConsumed={() => setHighlightMessageId(null)}
            voiceAvailable={voiceAvailable}
            rateLimit={rateLimit}
          />
        ) : (
          <div className={styles.noSession}>
            <p>{t('app.pickCompany')}</p>
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

      {showAppSettings && (
        <AppSettingsModal
          settings={appSettings}
          voiceAvailable={voiceAvailable}
          onClose={() => setShowAppSettings(false)}
          onSaved={(saved) => {
            onSettingsChange(saved);
            setShowAppSettings(false);
          }}
        />
      )}

      <TaskToasts />

      {updateReady !== null && (
        <div className={styles.updateBanner}>
          <span>
            {t('app.updateReady', { version: updateReady ? ` ${updateReady}` : '' })}
          </span>
          <div className={styles.updateBannerActions}>
            <button
              className={styles.updateBannerInstall}
              onClick={() => api.installUpdate()}
            >
              {t('app.updateInstall')}
            </button>
            <button
              className={styles.updateBannerDismiss}
              onClick={() => setUpdateReady(null)}
              title={t('app.updateLaterHint')}
            >
              {t('app.updateLater')}
            </button>
          </div>
        </div>
      )}

      {authError && (
        <div className={styles.authBanner}>
          <div className={styles.authBannerInner}>
            <strong>{t('app.authExpired')}</strong>
            <p>{authError}</p>
            <p className={styles.authBannerHint}>
              {t('app.authHintBefore')}<b>{t('app.authHintLogin')}</b>{t('app.authHintMiddle')}<code>claude login</code>{t('app.authHintAfter')}<b>{t('app.authHintCheck')}</b>{t('app.authHintEnd')}
            </p>
            <div className={styles.authBannerActions}>
              <button
                className={styles.authBannerLogin}
                onClick={() => api.openClaudeLogin()}
              >
                {t('app.authLogin')}
              </button>
              <button
                className={styles.authBannerCheck}
                onClick={recheckAuth}
                disabled={reAuthChecking}
              >
                {reAuthChecking ? t('app.authChecking') : t('app.authCheck')}
              </button>
              <button
                className={styles.authBannerDismiss}
                onClick={() => setAuthError(null)}
                title={t('app.close')}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
