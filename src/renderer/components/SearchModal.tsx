import { useState, useEffect, useRef, useCallback } from 'react';
import type { SearchResult } from '../../shared/types';
import styles from '../styles/SearchModal.module.css';

const api = (window as any).finmapAgent;

interface Props {
  onClose: () => void;
  onJump: (sessionId: string, messageId: string) => void;
}

export function SearchModal({ onClose, onJump }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSelected(0);
      return;
    }
    const t = setTimeout(() => {
      api.searchMessages(q).then((r: SearchResult[]) => {
        setResults(r);
        setSelected(0);
      });
    }, 120);
    return () => clearTimeout(t);
  }, [query]);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected(i => Math.min(i + 1, Math.max(0, results.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected(i => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = results[selected];
        if (hit) {
          onJump(hit.sessionId, hit.messageId);
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [results, selected, onClose, onJump]);

  // Scroll selected into view
  useEffect(() => {
    const item = listRef.current?.querySelector(`[data-idx="${selected}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const formatWhen = useCallback((ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    }
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString('uk-UA',
      sameYear
        ? { day: '2-digit', month: '2-digit' }
        : { day: '2-digit', month: '2-digit', year: 'numeric' }
    );
  }, []);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.searchBar}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Пошук по всіх чатах..."
            autoFocus
          />
          <kbd className={styles.esc}>ESC</kbd>
        </div>

        <div className={styles.results} ref={listRef}>
          {query.trim().length < 2 && (
            <div className={styles.hint}>Почни вводити щоб шукати по всіх повідомленнях</div>
          )}
          {query.trim().length >= 2 && results.length === 0 && (
            <div className={styles.hint}>Нічого не знайдено</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.sessionId}-${r.messageId}`}
              data-idx={i}
              className={`${styles.result} ${i === selected ? styles.active : ''}`}
              onClick={() => {
                onJump(r.sessionId, r.messageId);
                onClose();
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <div className={styles.resultHead}>
                <span className={styles.resultSession}>{r.sessionName}</span>
                <span className={styles.resultRole}>{r.role === 'user' ? 'Ти' : 'Асистент'}</span>
                <span className={styles.resultWhen}>{formatWhen(r.timestamp)}</span>
              </div>
              <div className={styles.resultSnippet}>
                {r.snippet.slice(0, r.matchStart)}
                <mark>{r.snippet.slice(r.matchStart, r.matchEnd)}</mark>
                {r.snippet.slice(r.matchEnd)}
              </div>
            </button>
          ))}
        </div>

        <div className={styles.footer}>
          <span><kbd>↑</kbd><kbd>↓</kbd> навігація</span>
          <span><kbd>⏎</kbd> відкрити</span>
          <span><kbd>ESC</kbd> закрити</span>
        </div>
      </div>
    </div>
  );
}
