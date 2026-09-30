import { useState, useEffect, useCallback } from 'react';
import type { FileImportBinding, ChatSession, TaskStatusEvent } from '../../shared/types';
import styles from '../styles/SessionSettingsModal.module.css';
import { FolderImportWizard } from './FolderImportWizard';
import { useT, type TFunction } from '../i18n';

const api = (window as any).finmapAgent;

interface Props {
  session: ChatSession;
  /** Persists session changes through App so its `sessions` state (and the
   *  `session` prop) stay in sync — passed down to FolderImportWizard. */
  onUpdateSession: (id: string, updates: Partial<ChatSession>) => Promise<void>;
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
export function FileBindingsSection({ session, onUpdateSession }: Props) {
  const { t, locale } = useT();
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

  // Rows show lastSync / lastStatus / processed count — refresh them when a
  // binding run for this session finishes (runs happen in the background).
  useEffect(() => {
    const unsub = api.onTaskStatus((e: TaskStatusEvent) => {
      if (e.sessionId === sessionId && e.kind === 'binding' && e.status !== 'progress') load();
    });
    return unsub;
  }, [sessionId, load]);

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
    if (!confirm(t('fileBindings.confirmDelete', { folder: b.sourceFolderName, account: b.finmapAccountName }))) return;
    await api.deleteFileBinding(b.id);
    if (editingId === b.id) cancelEdit();
    load();
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <span>{t('fileBindings.title')}</span>
        <span className={styles.sectionCount}>{bindings.length}</span>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => setShowWizard(true)}
          title={t('fileBindings.setupFromDrive')}
        >
          +
        </button>
      </div>

      {showWizard && (
        <FolderImportWizard
          session={session}
          onUpdateSession={onUpdateSession}
          onClose={() => setShowWizard(false)}
          onCreated={load}
        />
      )}

      {bindings.length === 0 ? (
        <div className={styles.empty}>
          {t('fileBindings.emptyIntro')} <b>+</b> {t('fileBindings.emptyAfter')}
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
                      <span>{t('fileBindings.every', { interval: formatInterval(t, b.syncIntervalMin) })}</span>
                      {b.lastSync && (
                        <>
                          <span>·</span>
                          <span title={new Date(b.lastSync).toLocaleString(locale)}>
                            {t('fileBindings.syncAgo', { ago: formatAgo(t, b.lastSync) })}
                          </span>
                        </>
                      )}
                      <span>·</span>
                      <span>{t('fileBindings.processedCount', { n: b.processedFileIds.length })}</span>
                    </div>
                    {b.lastResult && (
                      <button
                        type="button"
                        className={styles.resultToggle}
                        onClick={() => setExpandedResultId(expanded ? null : b.id)}
                      >
                        {expanded ? t('fileBindings.hideResult') : t('fileBindings.showResult')}
                      </button>
                    )}
                  </div>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.toggle} ${b.enabled ? styles.toggleOn : ''}`}
                      onClick={() => toggleBinding(b.id)}
                      title={b.enabled ? t('fileBindings.disable') : t('fileBindings.enable')}
                    >
                      <span className={styles.toggleKnob} />
                    </button>
                    <button
                      type="button"
                      className={styles.editBtn}
                      onClick={() => triggerNow(b)}
                      title={t('fileBindings.runNow')}
                      aria-label={t('fileBindings.runNow')}
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
                      title={isEditing ? t('fileBindings.collapse') : t('fileBindings.edit')}
                      aria-label={t('fileBindings.edit')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={styles.deleteBtn}
                      onClick={() => remove(b)}
                      title={t('fileBindings.delete')}
                      aria-label={t('fileBindings.delete')}
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
                      <span>{t('fileBindings.contextLabel')}</span>
                      <textarea
                        rows={6}
                        value={edit.contextPrompt}
                        onChange={e => setEdit({ ...edit, contextPrompt: e.target.value })}
                        placeholder={t('fileBindings.contextPlaceholder')}
                      />
                    </label>
                    <label className={styles.intervalLabel}>
                      {t('fileBindings.checkInterval')}
                      <select
                        value={edit.syncIntervalMin}
                        onChange={e => setEdit({ ...edit, syncIntervalMin: Number(e.target.value) })}
                      >
                        <option value={15}>{t('fileBindings.intervalMin', { n: 15 })}</option>
                        <option value={30}>{t('fileBindings.intervalMin', { n: 30 })}</option>
                        <option value={60}>{t('fileBindings.intervalHours', { n: 1 })}</option>
                        <option value={180}>{t('fileBindings.intervalHours', { n: 3 })}</option>
                        <option value={360}>{t('fileBindings.intervalHours', { n: 6 })}</option>
                        <option value={720}>{t('fileBindings.intervalHours', { n: 12 })}</option>
                        <option value={1440}>{t('fileBindings.intervalDay')}</option>
                        <option value={10080}>{t('fileBindings.intervalWeek')}</option>
                      </select>
                    </label>
                    <div className={styles.editFormRow}>
                      <button
                        type="button"
                        className={styles.saveTaskBtn}
                        onClick={saveEdit}
                        disabled={!edit.contextPrompt.trim()}
                      >
                        {t('fileBindings.save')}
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

function formatAgo(t: TFunction, ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('fileBindings.justNow');
  if (m < 60) return t('fileBindings.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('fileBindings.hoursAgo', { n: h });
  const d = Math.floor(h / 24);
  return t('fileBindings.daysAgo', { n: d });
}

function formatInterval(t: TFunction, min: number): string {
  if (min < 60) return t('fileBindings.intervalMin', { n: min });
  if (min < 1440) return t('fileBindings.intervalHours', { n: Math.round(min / 60) });
  return t('fileBindings.intervalDays', { n: Math.round(min / 1440) });
}
