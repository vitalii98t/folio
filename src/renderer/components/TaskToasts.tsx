import { useEffect, useState } from 'react';
import type { TaskStatusEvent } from '../../shared/types';
import styles from '../styles/TaskToasts.module.css';

const api = (window as any).finmapAgent;

interface Toast {
  id: string;
  taskId: string;
  taskName: string;
  status: 'start' | 'done' | 'error';
  message?: string;
  toolHistory: string[];
  expanded: boolean;
}

const AUTO_DISMISS_MS = 6000;

export function TaskToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const unsub = api.onTaskStatus((e: TaskStatusEvent) => {
      setToasts(prev => {
        if (e.status === 'start') {
          // Reuse existing toast for this task if any, otherwise create
          const existing = prev.find(t => t.taskId === e.taskId && t.status === 'start');
          if (existing) return prev;
          return [...prev, {
            id: `${e.taskId}-start-${Date.now()}`,
            taskId: e.taskId,
            taskName: e.taskName,
            status: 'start',
            toolHistory: [],
            expanded: false,
          }];
        }

        if (e.status === 'progress' && e.currentTool) {
          // Append tool to the active toast's history
          return prev.map(t =>
            t.taskId === e.taskId && t.status === 'start'
              ? { ...t, toolHistory: [...t.toolHistory, shortToolName(e.currentTool!)].slice(-8) }
              : t
          );
        }

        if (e.status === 'done' || e.status === 'error') {
          // Replace the start toast (if any) with done/error
          const withoutStart = prev.filter(t => !(t.taskId === e.taskId && t.status === 'start'));
          const newId = `${e.taskId}-${e.status}-${Date.now()}`;
          setTimeout(() => {
            setToasts(p => p.filter(t => t.id !== newId));
          }, AUTO_DISMISS_MS);
          return [...withoutStart, {
            id: newId,
            taskId: e.taskId,
            taskName: e.taskName,
            status: e.status,
            message: e.result ? firstLine(e.result) : undefined,
            toolHistory: [],
            expanded: false,
          }];
        }

        return prev;
      });
    });
    return unsub;
  }, []);

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const toggleExpand = (id: string) => {
    setToasts(prev => prev.map(t => (t.id === id ? { ...t, expanded: !t.expanded } : t)));
  };

  if (toasts.length === 0) return null;

  return (
    <div className={styles.stack}>
      {toasts.map(t => (
        <div
          key={t.id}
          className={`${styles.toast} ${styles[t.status]} ${t.expanded ? styles.expanded : ''}`}
          onClick={() => {
            if (t.status === 'start' && t.toolHistory.length > 0) {
              toggleExpand(t.id);
            } else {
              dismiss(t.id);
            }
          }}
        >
          <span className={styles.icon}>
            {t.status === 'start' && <Spinner />}
            {t.status === 'done' && '✓'}
            {t.status === 'error' && '!'}
          </span>
          <div className={styles.body}>
            <div className={styles.title}>
              {t.status === 'start' && 'Виконується'}
              {t.status === 'done' && 'Готово'}
              {t.status === 'error' && 'Помилка'}
              <span className={styles.name}> · {t.taskName}</span>
            </div>
            {t.status === 'start' && t.toolHistory.length > 0 && !t.expanded && (
              <div className={styles.currentTool}>
                {t.toolHistory[t.toolHistory.length - 1]}
                <span className={styles.hint}> · клік щоб розгорнути</span>
              </div>
            )}
            {t.status === 'start' && t.expanded && (
              <div className={styles.toolList}>
                {t.toolHistory.map((tool, i) => {
                  const isLast = i === t.toolHistory.length - 1;
                  return (
                    <div key={i} className={`${styles.toolItem} ${isLast ? styles.toolActive : ''}`}>
                      <span className={styles.toolDot}>{isLast ? '●' : '✓'}</span>
                      <span>{tool}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {t.message && <div className={styles.message}>{t.message}</div>}
            {t.status === 'start' && (
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={(e) => { e.stopPropagation(); api.cancelTask(t.taskId); }}
              >
                Скасувати
              </button>
            )}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}
            aria-label="Закрити"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.2-8.55">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function firstLine(s: string): string {
  const line = s.split('\n').find(l => l.trim().length > 0) ?? '';
  return line.length > 140 ? line.slice(0, 140) + '…' : line;
}

/** Strip `mcp__finmap__` prefix for readability */
function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}
