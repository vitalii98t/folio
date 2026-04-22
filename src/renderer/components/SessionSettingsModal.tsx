import { useState, useEffect, useCallback } from 'react';
import type { ChatSession, Integration, ScheduledTask, TaskStatusEvent } from '../../shared/types';
import styles from '../styles/NewSessionModal.module.css';
import notesStyles from '../styles/SessionSettingsModal.module.css';

const api = (window as any).finmapAgent;

interface Props {
  session: ChatSession;
  onClose: () => void;
  onSave: (updates: { name: string; notes: string }) => void;
}

export function SessionSettingsModal({ session, onClose, onSave }: Props) {
  const [name, setName] = useState(session.name);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [showAddTask, setShowAddTask] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [newTaskName, setNewTaskName] = useState('');
  const [newTaskPrompt, setNewTaskPrompt] = useState('');
  const [newTaskInterval, setNewTaskInterval] = useState(30);
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);

  const loadIntegrations = useCallback(() => {
    api.getIntegrations(session.id).then((list: Integration[]) => setIntegrations(list));
  }, [session.id]);

  const loadTasks = useCallback(() => {
    api.getTasks(session.id).then((list: ScheduledTask[]) => setTasks(list));
  }, [session.id]);

  useEffect(() => {
    loadIntegrations();
    loadTasks();
  }, [loadIntegrations, loadTasks]);

  // Live-refresh tasks when any task status changes for this session
  useEffect(() => {
    const unsub = api.onTaskStatus((e: TaskStatusEvent) => {
      if (e.sessionId === session.id) loadTasks();
    });
    return unsub;
  }, [session.id, loadTasks]);

  const canSave = name.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canSave) {
      onSave({ name: name.trim(), notes: notes.trim() });
    }
  }

  async function handleToggle(id: string) {
    await api.toggleIntegration(id);
    loadIntegrations();
  }

  async function handleDelete(integration: Integration) {
    await api.deleteIntegration(integration.id);
    loadIntegrations();
  }

  function resetTaskForm() {
    setEditingTaskId(null);
    setNewTaskName('');
    setNewTaskPrompt('');
    setNewTaskInterval(30);
    setShowAddTask(false);
  }

  async function handleSaveTask() {
    if (!newTaskName.trim() || !newTaskPrompt.trim()) return;
    if (editingTaskId) {
      await api.updateTask(editingTaskId, {
        name: newTaskName.trim(),
        prompt: newTaskPrompt.trim(),
        intervalMin: newTaskInterval,
      });
    } else {
      await api.createTask({
        sessionId: session.id,
        name: newTaskName.trim(),
        prompt: newTaskPrompt.trim(),
        intervalMin: newTaskInterval,
        enabled: true,
      });
    }
    resetTaskForm();
    loadTasks();
  }

  function handleEditTask(task: ScheduledTask) {
    setEditingTaskId(task.id);
    setNewTaskName(task.name);
    setNewTaskPrompt(task.prompt);
    setNewTaskInterval(task.intervalMin);
    setShowAddTask(true);
  }

  function handleToggleAddForm() {
    if (showAddTask) {
      resetTaskForm();
    } else {
      setShowAddTask(true);
    }
  }

  async function handleToggleTask(id: string) {
    await api.toggleTask(id);
    loadTasks();
  }

  async function handleDeleteTask(task: ScheduledTask) {
    if (editingTaskId === task.id) resetTaskForm();
    await api.deleteTask(task.id);
    loadTasks();
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.modal} ${notesStyles.wide}`} onClick={e => e.stopPropagation()}>
        <h2>Налаштування компанії</h2>
        <form onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span>Назва</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </label>

          <label className={styles.field}>
            <span>Нотатки для асистента</span>
            <textarea
              className={notesStyles.notes}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={'Контекст, який асистент пам\'ятатиме для цієї компанії.\n\nНаприклад:\n• Рах. *0001 — ФОП, перекази >50k вважай особистими витратами\n• Контрагент "ТОВ X" — наш основний постачальник\n• Зарплата виплачується 1-го та 15-го'}
              rows={8}
            />
            <small className={styles.hint}>
              Інжектується в системний промпт при кожному запиті
            </small>
          </label>

          <section className={notesStyles.section}>
            <div className={notesStyles.sectionHead}>
              <span>Інтеграції</span>
              <span className={notesStyles.sectionCount}>{integrations.length}</span>
            </div>

            {integrations.length === 0 ? (
              <div className={notesStyles.empty}>
                Немає підключених інтеграцій. Натисни <b>⚡ Інтеграція</b> в чаті, щоб підключити.
              </div>
            ) : (
              <div className={notesStyles.list}>
                {integrations.map(intg => (
                  <div key={intg.id} className={notesStyles.row}>
                    <div className={notesStyles.rowMain}>
                      <div className={notesStyles.rowTitle}>
                        <span className={`${notesStyles.statusDot} ${intg.enabled ? notesStyles.on : notesStyles.off}`} />
                        <span className={notesStyles.rowName}>{intg.serviceName}</span>
                      </div>
                      <div className={notesStyles.rowMeta}>
                        <span>→ {intg.finmapAccountName ?? intg.finmapAccountId}</span>
                        <span>·</span>
                        <span>кожні {intg.syncIntervalMin} хв</span>
                        {intg.lastSync && (
                          <>
                            <span>·</span>
                            <span title={new Date(intg.lastSync).toLocaleString('uk-UA')}>
                              синк {formatAgo(intg.lastSync)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className={notesStyles.rowActions}>
                      <button
                        type="button"
                        className={`${notesStyles.toggle} ${intg.enabled ? notesStyles.toggleOn : ''}`}
                        onClick={() => handleToggle(intg.id)}
                        title={intg.enabled ? 'Вимкнути' : 'Увімкнути'}
                      >
                        <span className={notesStyles.toggleKnob} />
                      </button>
                      <button
                        type="button"
                        className={notesStyles.deleteBtn}
                        onClick={() => handleDelete(intg)}
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
                ))}
              </div>
            )}
          </section>

          <section className={notesStyles.section}>
            <div className={notesStyles.sectionHead}>
              <span>Автозадачі</span>
              <span className={notesStyles.sectionCount}>{tasks.length}</span>
              <button
                type="button"
                className={notesStyles.addBtn}
                onClick={handleToggleAddForm}
                title={showAddTask ? 'Скасувати' : 'Нова задача'}
              >
                {showAddTask ? '−' : '+'}
              </button>
            </div>

            {showAddTask && (
              <div className={notesStyles.addForm}>
                <input
                  type="text"
                  placeholder="Назва (наприклад: Категоризація)"
                  value={newTaskName}
                  onChange={e => setNewTaskName(e.target.value)}
                />
                <textarea
                  placeholder="Що робити Claude (наприклад: за останні 2 дні знайди операції без categoryId і постав категорії на основі comment/counterparty. Не створюй нові категорії)"
                  value={newTaskPrompt}
                  onChange={e => setNewTaskPrompt(e.target.value)}
                  rows={4}
                />
                <div className={notesStyles.addFormRow}>
                  <label className={notesStyles.intervalLabel}>
                    Інтервал
                    <select
                      value={newTaskInterval}
                      onChange={e => setNewTaskInterval(Number(e.target.value))}
                    >
                      <option value={10}>10 хв</option>
                      <option value={15}>15 хв</option>
                      <option value={30}>30 хв</option>
                      <option value={60}>1 год</option>
                      <option value={180}>3 год</option>
                      <option value={360}>6 год</option>
                      <option value={720}>12 год</option>
                      <option value={1440}>1 день</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className={notesStyles.saveTaskBtn}
                    onClick={handleSaveTask}
                    disabled={!newTaskName.trim() || !newTaskPrompt.trim()}
                  >
                    {editingTaskId ? 'Зберегти' : 'Додати'}
                  </button>
                </div>
              </div>
            )}

            {tasks.length === 0 && !showAddTask ? (
              <div className={notesStyles.empty}>
                Немає автозадач. Натисни <b>+</b> щоб додати — Claude виконуватиме її за розкладом.
              </div>
            ) : (
              <div className={notesStyles.list}>
                {tasks.map(task => {
                  const dotClass = task.enabled
                    ? (task.lastStatus === 'error' ? notesStyles.err : notesStyles.on)
                    : notesStyles.off;
                  const expanded = expandedResultId === task.id;
                  return (
                  <div
                    key={task.id}
                    className={`${notesStyles.row} ${editingTaskId === task.id ? notesStyles.rowEditing : ''}`}
                  >
                    <div className={notesStyles.rowHeader}>
                    <div className={notesStyles.rowMain}>
                      <div className={notesStyles.rowTitle}>
                        <span className={`${notesStyles.statusDot} ${dotClass}`} />
                        <span className={notesStyles.rowName}>{task.name}</span>
                        {task.lastStatus === 'error' && (
                          <span className={notesStyles.errBadge}>помилка</span>
                        )}
                      </div>
                      <div className={notesStyles.rowMeta}>
                        <span>кожні {formatInterval(task.intervalMin)}</span>
                        {task.lastRun && (
                          <>
                            <span>·</span>
                            <span title={new Date(task.lastRun).toLocaleString('uk-UA')}>
                              запуск {formatAgo(task.lastRun)}
                            </span>
                          </>
                        )}
                        {task.lastResult && (
                          <>
                            <span>·</span>
                            <button
                              type="button"
                              className={notesStyles.resultToggle}
                              onClick={() => setExpandedResultId(expanded ? null : task.id)}
                            >
                              {expanded ? 'сховати' : 'показати результат'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className={notesStyles.rowActions}>
                      <button
                        type="button"
                        className={`${notesStyles.toggle} ${task.enabled ? notesStyles.toggleOn : ''}`}
                        onClick={() => handleToggleTask(task.id)}
                        title={task.enabled ? 'Вимкнути' : 'Увімкнути'}
                      >
                        <span className={notesStyles.toggleKnob} />
                      </button>
                      <button
                        type="button"
                        className={notesStyles.editBtn}
                        onClick={() => handleEditTask(task)}
                        title="Редагувати"
                        aria-label="Редагувати"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={notesStyles.deleteBtn}
                        onClick={() => handleDeleteTask(task)}
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
                    {expanded && task.lastResult && (
                      <pre className={notesStyles.resultBlock}>{task.lastResult}</pre>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Скасувати
            </button>
            <button type="submit" className={styles.createBtn} disabled={!canSave}>
              Зберегти
            </button>
          </div>
        </form>
      </div>
    </div>
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
