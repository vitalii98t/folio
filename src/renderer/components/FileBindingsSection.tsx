import { useState, useEffect, useCallback } from 'react';
import type { FileImportBinding, ChatSession } from '../../shared/types';
import styles from '../styles/SessionSettingsModal.module.css';
import { FolderImportWizard } from './FolderImportWizard';

const api = (window as any).finmapAgent;

interface Props {
  session: ChatSession;
}

interface EditState {
  contextPrompt: string;
  syncIntervalMin: number;
}

/**
 * Read-only management UI for file-import bindings. Creation is done through
 * the `folder-import-setup` skill in chat (because picking the right folder
 * needs MCP listings that only Claude can comfortably do). Here the user
 * just sees existing bindings, edits the context-prompt / interval, toggles
 * them on/off, triggers a run manually, or deletes.
 */
export function FileBindingsSection({ session }: Props) {
  const sessionId = session.id;
  const [bindings, setBindings] = useState<FileImportBinding[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({ contextPrompt: '', syncIntervalMin: 30 });
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  const load = useCallback(() => {
    api.getFileBindings(sessionId).then(setBindings);
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  function startEdit(b: FileImportBinding) {
    setEditingId(b.id);
    setEdit({ contextPrompt: b.contextPrompt, syncIntervalMin: b.syncIntervalMin });
  }

  function cancelEdit() {
    setEditingId(null);
    setEdit({ contextPrompt: '', syncIntervalMin: 30 });
  }

  async function saveEdit() {
    if (!editingId) return;
    if (!edit.contextPrompt.trim()) return;
    await api.updateFileBinding(editingId, {
      contextPrompt: edit.contextPrompt.trim(),
      syncIntervalMin: edit.syncIntervalMin,
    });
    cancelEdit();
    load();
  }

  async function toggleBinding(id: string) {
    await api.toggleFileBinding(id);
    load();
  }

  async function triggerNow(b: FileImportBinding) {
    await api.triggerFileBinding(b.id);
    // Result will arrive via the existing task-status event channel; nothing to do here.
  }

  async function remove(b: FileImportBinding) {
    if (!confirm(`Видалити авто-імпорт "${b.sourceFolderName} → ${b.finmapAccountName}"?\n\nВже створені у Finmap операції залишаться — видалиться тільки звʼязка.`)) return;
    await api.deleteFileBinding(b.id);
    if (editingId === b.id) cancelEdit();
    load();
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span>Авто-імпорт з папок</span>
        <span className={styles.sectionCount}>{bindings.length}</span>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => setShowWizard(true)}
          title="Налаштувати авто-імпорт з Google Drive"
        >
          +
        </button>
      </div>

      {showWizard && (
        <FolderImportWizard
          session={session}
          onClose={() => setShowWizard(false)}
          onCreated={load}
        />
      )}

      {bindings.length === 0 ? (
        <div className={styles.empty}>
          Ще немає налаштованих авто-імпортів. Натисни <b>+</b> щоб підʼєднати папку Google Drive до Finmap-рахунку.
        </div>
      ) : (
        <div className={styles.list}>
          {bindings.map(b => {
            const isEditing = editingId === b.id;
            const expanded = expandedResultId === b.id;
            return (
              <div key={b.id} className={`${styles.row} ${isEditing ? styles.rowEditing : ''}`}>
                <div className={styles.rowHeader}>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      <span className={`${styles.statusDot} ${b.enabled ? styles.on : styles.off} ${b.lastStatus === 'error' ? styles.err : ''}`} />
                      <span className={styles.rowName}>📁 {b.sourceFolderName}</span>
                    </div>
                    <div className={styles.rowMeta}>
                      <span>→ 💳 {b.finmapAccountName}</span>
                      <span>·</span>
                      <span>кожні {formatInterval(b.syncIntervalMin)}</span>
                      {b.lastSync && (
                        <>
                          <span>·</span>
                          <span title={new Date(b.lastSync).toLocaleString('uk-UA')}>
                            синк {formatAgo(b.lastSync)}
                          </span>
                        </>
                      )}
                      <span>·</span>
                      <span>{b.processedFileIds.length} оброблених</span>
                    </div>
                    {b.lastResult && (
                      <button
                        type="button"
                        className={styles.resultToggle}
                        onClick={() => setExpandedResultId(expanded ? null : b.id)}
                      >
                        {expanded ? 'сховати результат' : 'показати результат'}
                      </button>
                    )}
                  </div>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.toggle} ${b.enabled ? styles.toggleOn : ''}`}
                      onClick={() => toggleBinding(b.id)}
                      title={b.enabled ? 'Вимкнути' : 'Увімкнути'}
                    >
                      <span className={styles.toggleKnob} />
                    </button>
                    <button
                      type="button"
                      className={styles.editBtn}
                      onClick={() => triggerNow(b)}
                      title="Запустити зараз"
                      aria-label="Запустити зараз"
                      disabled={!b.enabled}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={styles.editBtn}
                      onClick={() => isEditing ? cancelEdit() : startEdit(b)}
                      title={isEditing ? 'Згорнути' : 'Редагувати'}
                      aria-label="Редагувати"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={styles.deleteBtn}
                      onClick={() => remove(b)}
                      title="Видалити"
                      aria-label="Видалити"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                </div>
                {expanded && b.lastResult && (
                  <pre className={styles.resultBlock}>{b.lastResult}</pre>
                )}
                {isEditing && (
                  <div className={styles.editForm}>
                    <label className={styles.editLabel}>
                      <span>Контекст обробки (інтерпретується Claude для кожного нового файла)</span>
                      <textarea
                        rows={6}
                        value={edit.contextPrompt}
                        onChange={e => setEdit({ ...edit, contextPrompt: e.target.value })}
                        placeholder={'Категорія: "Продаж послуг"\nКонтрагент: з назви файла\nТип: дохід\nЯкщо .pdf — банківська виписка'}
                      />
                    </label>
                    <label className={styles.intervalLabel}>
                      Інтервал перевірки
                      <select
                        value={edit.syncIntervalMin}
                        onChange={e => setEdit({ ...edit, syncIntervalMin: Number(e.target.value) })}
                      >
                        <option value={15}>15 хв</option>
                        <option value={30}>30 хв</option>
                        <option value={60}>1 год</option>
                        <option value={180}>3 год</option>
                        <option value={360}>6 год</option>
                        <option value={720}>12 год</option>
                        <option value={1440}>1 день</option>
                        <option value={10080}>1 тиждень</option>
                      </select>
                    </label>
                    <div className={styles.editFormRow}>
                      <button
                        type="button"
                        className={styles.saveTaskBtn}
                        onClick={saveEdit}
                        disabled={!edit.contextPrompt.trim()}
                      >
                        Зберегти
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} год тому`;
  const d = Math.floor(h / 24);
  return `${d} дн тому`;
}

function formatInterval(min: number): string {
  if (min < 60) return `${min} хв`;
  if (min < 1440) return `${Math.round(min / 60)} год`;
  return `${Math.round(min / 1440)} дн`;
}
