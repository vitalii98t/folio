import { useState, useEffect } from 'react';
import type { ChatSession } from '../../shared/types';
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
}

export function Sidebar({ sessions, activeSessionId, onSelect, onNew, onDelete, onSearch, onClaudeLogout }: Props) {
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
        <button className={styles.newBtn} onClick={onNew} title="Додати компанію">
          +
        </button>
      </div>

      <button className={styles.searchPill} onClick={onSearch} title="Пошук по всіх чатах">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span>Пошук</span>
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
                if (confirm(`Видалити "${session.name}"?`)) {
                  onDelete(session.id);
                }
              }}
              title="Видалити"
            >
              &times;
            </button>
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.logoutBtn}
          onClick={onClaudeLogout}
          title="Вийти з акаунту Claude — використай, якщо акаунт заблоковано або хочеш переключитись на інший"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span>Вийти з Claude</span>
        </button>
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
