import type { ChatSession } from '../../shared/types';
import styles from '../styles/Sidebar.module.css';

interface Props {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSearch: () => void;
}

export function Sidebar({ sessions, activeSessionId, onSelect, onNew, onDelete, onSearch }: Props) {
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
        <span className={styles.author}>
          created by <strong>vitalii98t</strong>
        </span>
        <span className={styles.version}>v0.1.0</span>
      </div>
    </aside>
  );
}
