import { useState, useEffect } from 'react';
import type { ChatSession } from '../../shared/types';
import { useT } from '../i18n';
import styles from '../styles/Sidebar.module.css';

const api = (window as any).finmapAgent;

interface Props {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSearch: () => void;
  onClaudeLogout: () => void;
  /** Opens the app-wide settings modal (voice input etc.). */
  onOpenSettings: () => void;
}

export function Sidebar({ sessions, activeSessionId, onSelect, onNew, onDelete, onSearch, onClaudeLogout, onOpenSettings }: Props) {
  const { t } = useT();
  // Version comes from the running build (package.json → app.getVersion), so it
  // stays correct after an auto-update without touching this file.
  const [version, setVersion] = useState('');
  useEffect(() => {
    api.getAppVersion?.().then((v: string) => setVersion(v)).catch(() => {});
  }, []);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <h2 className={styles.logo}>
          <span className={styles.logoMark}>✦</span>
          <span>Fol<span className={styles.logoAccent}>io</span></span>
        </h2>
        <button className={styles.newBtn} onClick={onNew} title={t('sidebar.addCompany')}>
          +
        </button>
      </div>

      <button className={styles.searchPill} onClick={onSearch} title={t('sidebar.searchAllChats')}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span>{t('sidebar.search')}</span>
        <kbd>Ctrl K</kbd>
      </button>

      <nav className={styles.sessions}>
        {sessions.map(session => (
          <div
            key={session.id}
            className={`${styles.sessionItem} ${session.id === activeSessionId ? styles.active : ''}`}
            onClick={() => onSelect(session.id)}
          >
            <span className={styles.sessionName}>{session.name}</span>
            <button
              className={styles.deleteBtn}
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(t('sidebar.confirmDelete', { name: session.name }))) {
                  onDelete(session.id);
                }
              }}
              title={t('sidebar.delete')}
            >
              &times;
            </button>
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        <div className={styles.footerBtns}>
          <button
            type="button"
            className={styles.settingsBtn}
            onClick={onOpenSettings}
            title={t('sidebar.settingsTitle')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <span>{t('sidebar.settings')}</span>
          </button>
          <button
            type="button"
            className={styles.logoutBtn}
            onClick={onClaudeLogout}
            title={t('sidebar.logoutTitle')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>{t('sidebar.logout')}</span>
          </button>
        </div>
        <div className={styles.footerMeta}>
          <span className={styles.author}>
            created by <strong>vitalii98t</strong>
          </span>
          {version && <span className={styles.version}>v{version}</span>}
        </div>
      </div>
    </aside>
  );
}
