import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChatSession, Integration, ScheduledTask, TaskStatusEvent, ClaudeModelInfo } from '../../shared/types';
import styles from '../styles/NewSessionModal.module.css';
import notesStyles from '../styles/SessionSettingsModal.module.css';
import { McpServersSection } from './McpServersSection';
import { FileBindingsSection } from './FileBindingsSection';
import { useT, type TFunction } from '../i18n';

const api = (window as any).finmapAgent;

interface Props {
  session: ChatSession;
  onClose: () => void;
  onSave: (updates: { name: string; notes: string; model: string }) => void;
  /** Persists partial session changes (API keys etc.) through App so its
   *  `sessions` state — and this `session` prop — don't go stale. */
  onUpdateSession: (id: string, updates: Partial<ChatSession>) => Promise<void>;
}


export function SessionSettingsModal({ session, onClose, onSave, onUpdateSession }: Props) {
  const { t, locale } = useT();
  const [name, setName] = useState(session.name);
  const [notes, setNotes] = useState(session.notes ?? '');
  const [model, setModel] = useState(session.model ?? '');
  const [models, setModels] = useState<ClaudeModelInfo[] | null>(null);
  // Local copy so the connection block flips to "connected" right after a
  // save, before App's refreshed `session` prop arrives.
  const [apiKey, setApiKey] = useState(session.apiKey ?? '');
  useEffect(() => { setApiKey(session.apiKey ?? ''); }, [session.apiKey]);
  const hasFinmapKey = apiKey.trim().length > 0;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [showAddTask, setShowAddTask] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [newTaskName, setNewTaskName] = useState('');
  const [newTaskPrompt, setNewTaskPrompt] = useState('');
  const [newTaskInterval, setNewTaskInterval] = useState(30);
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [editingIntegrationId, setEditingIntegrationId] = useState<string | null>(null);
  const [intgForm, setIntgForm] = useState({ serviceName: '', syncIntervalMin: 30, syncPrompt: '' });

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

  // Model list comes from the installed Claude Code (see main/claude-models.ts)
  // so it reflects the user's actual plan and never goes stale.
  useEffect(() => {
    let alive = true;
    api.listClaudeModels()
      .then((list: ClaudeModelInfo[]) => { if (alive) setModels(list); })
      .catch(() => { if (alive) setModels([]); });
    return () => { alive = false; };
  }, []);

  // Live-refresh tasks when any task status changes for this session
  useEffect(() => {
    const unsub = api.onTaskStatus((e: TaskStatusEvent) => {
      if (e.sessionId === session.id) loadTasks();
    });
    return unsub;
  }, [session.id, loadTasks]);

  const canSave = name.trim().length > 0;

  // Nested sections (API key, tasks, integrations, MCP servers) live inside
  // this form. Enter in any of their inputs would submit the whole form —
  // saving name/notes/model and closing the modal, losing what was typed.
  // Only the company-name field keeps Enter-to-save.
  function handleFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' && target !== nameInputRef.current) {
      e.preventDefault();
    }
  }

  async function handleSaveApiKey() {
    const key = apiKeyDraft.trim();
    if (!key) return;
    setApiKeySaving(true);
    try {
      await onUpdateSession(session.id, { apiKey: key });
      setApiKey(key);
      setShowApiKeyInput(false);
      setApiKeyDraft('');
      // Reload integrations because they need a valid key.
      loadIntegrations();
    } finally {
      setApiKeySaving(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canSave) {
      onSave({ name: name.trim(), notes: notes.trim(), model });
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

  function startEditIntegration(intg: Integration) {
    setEditingIntegrationId(intg.id);
    setIntgForm({
      serviceName: intg.serviceName,
      syncIntervalMin: intg.syncIntervalMin || 30,
      syncPrompt: intg.syncPrompt ?? '',
    });
  }

  function cancelEditIntegration() {
    setEditingIntegrationId(null);
    setIntgForm({ serviceName: '', syncIntervalMin: 30, syncPrompt: '' });
  }

  async function saveEditIntegration() {
    if (!editingIntegrationId) return;
    if (!intgForm.serviceName.trim() || !intgForm.syncPrompt.trim()) return;
    await api.updateIntegration(editingIntegrationId, {
      serviceName: intgForm.serviceName.trim(),
      syncIntervalMin: intgForm.syncIntervalMin,
      syncPrompt: intgForm.syncPrompt.trim(),
    });
    cancelEditIntegration();
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

  // '' = let Claude Code decide. The CLI reports that choice as a "default"
  // entry — we don't offer it as a model, but we do borrow its description so
  // the user can see what the default currently resolves to.
  const cliDefault = models?.find(m => m.value === 'default');
  const realModels = (models ?? []).filter(m => m.value !== 'default');
  const modelOptions = [
    {
      value: '',
      label: t('sessionSettings.modelDefault'),
      description: cliDefault?.description ?? '',
    },
    ...realModels.map(m => ({ value: m.value, label: m.displayName, description: m.description })),
  ];
  // A model saved earlier may no longer be offered (plan change, new CLI).
  // Keep it selectable so opening settings doesn't silently reset it.
  if (model && !modelOptions.some(o => o.value === model)) {
    modelOptions.push({ value: model, label: model, description: t('sessionSettings.modelStaleDescription') });
  }
  const selectedModel = modelOptions.find(o => o.value === model);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.modal} ${notesStyles.wide}`} onClick={e => e.stopPropagation()}>
        <h2>{t('sessionSettings.title')}</h2>
        <form onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
          <label className={styles.field}>
            <span>{t('sessionSettings.nameLabel')}</span>
            <input
              type="text"
              ref={nameInputRef}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </label>

          <div className={styles.field}>
            <span>{t('sessionSettings.finmapConnection')}</span>
            {hasFinmapKey ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.25)', borderRadius: 6 }}>
                <span style={{ fontSize: 13, color: '#86efac' }}>
                  {t('sessionSettings.connectedKeyEndsWith')} <code style={{ background: 'transparent' }}>…{apiKey.slice(-4)}</code>
                </span>
                <button
                  type="button"
                  onClick={() => { setShowApiKeyInput(true); setApiKeyDraft(''); }}
                  style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
                >
                  {t('sessionSettings.change')}
                </button>
              </div>
            ) : !showApiKeyInput ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: 'rgba(234, 179, 8, 0.06)', border: '1px solid rgba(234, 179, 8, 0.2)', borderRadius: 6 }}>
                <span style={{ fontSize: 13, color: '#fde68a' }}>
                  {t('sessionSettings.mcpOnlyMode')}
                </span>
                <button
                  type="button"
                  onClick={() => { setShowApiKeyInput(true); setApiKeyDraft(''); }}
                  style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '4px 12px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontWeight: 500 }}
                >
                  {t('sessionSettings.connectFinmap')}
                </button>
              </div>
            ) : null}
            {showApiKeyInput && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                <input
                  type="password"
                  placeholder={hasFinmapKey ? t('sessionSettings.newApiKeyPlaceholder') : t('sessionSettings.apiKeyPlaceholder')}
                  value={apiKeyDraft}
                  onChange={e => setApiKeyDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !apiKeySaving) void handleSaveApiKey(); }}
                  autoFocus
                  style={{ width: '100%', padding: '8px 10px', background: '#1a1a1f', border: '1px solid var(--border)', borderRadius: 6, color: '#fff', fontSize: 13 }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    onClick={() => { setShowApiKeyInput(false); setApiKeyDraft(''); }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}
                  >
                    {t('sessionSettings.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={!apiKeyDraft.trim() || apiKeySaving}
                    onClick={handleSaveApiKey}
                    style={{ background: 'var(--accent)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 4, fontSize: 12, cursor: !apiKeyDraft.trim() || apiKeySaving ? 'not-allowed' : 'pointer', opacity: !apiKeyDraft.trim() || apiKeySaving ? 0.5 : 1, fontWeight: 500 }}
                  >
                    {apiKeySaving ? t('sessionSettings.saving') : t('sessionSettings.save')}
                  </button>
                </div>
              </div>
            )}
          </div>

          <label className={styles.field}>
            <span>{t('sessionSettings.modelLabel')}</span>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={models === null}
              style={{ width: '100%', padding: '8px 10px', background: '#1a1a1f', border: '1px solid var(--border)', borderRadius: 6, color: '#fff', fontSize: 13, opacity: models === null ? 0.6 : 1 }}
            >
              {models === null ? (
                <option value={model}>{t('sessionSettings.loadingModels')}</option>
              ) : (
                modelOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))
              )}
            </select>
            <small className={styles.hint}>
              {selectedModel?.description
                ? t('sessionSettings.modelHintWithDescription', { description: selectedModel.description })
                : t('sessionSettings.modelHint')}
            </small>
          </label>

          <label className={styles.field}>
            <span>{t('sessionSettings.notesLabel')}</span>
            <textarea
              className={notesStyles.notes}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t('sessionSettings.notesPlaceholder')}
              rows={8}
            />
            <small className={styles.hint}>
              {t('sessionSettings.notesHint')}
            </small>
          </label>

          <section className={notesStyles.section}>
            <div className={notesStyles.sectionHead}>
              <span>{t('sessionSettings.integrations')}</span>
              <span className={notesStyles.sectionCount}>{integrations.length}</span>
            </div>

            {integrations.length === 0 ? (
              <div className={notesStyles.empty}>
                {t('sessionSettings.noIntegrationsBefore')} <b>{t('sessionSettings.integrationButtonLabel')}</b> {t('sessionSettings.noIntegrationsAfter')}
              </div>
            ) : (
              <div className={notesStyles.list}>
                {integrations.map(intg => (
                  <div
                    key={intg.id}
                    className={`${notesStyles.row} ${editingIntegrationId === intg.id ? notesStyles.rowEditing : ''}`}
                  >
                    <div className={notesStyles.rowHeader}>
                    <div className={notesStyles.rowMain}>
                      <div className={notesStyles.rowTitle}>
                        <span className={`${notesStyles.statusDot} ${intg.enabled ? (intg.lastStatus === 'error' ? notesStyles.err : notesStyles.on) : notesStyles.off}`} />
                        <span className={notesStyles.rowName}>{intg.serviceName}</span>
                        {intg.lastStatus === 'error' && (
                          <span className={notesStyles.errBadge} title={t('sessionSettings.errorBadgeTitle')}>{t('sessionSettings.errorBadge')}</span>
                        )}
                      </div>
                      <div className={notesStyles.rowMeta}>
                        <span>→ {intg.finmapAccountName ?? intg.finmapAccountId}</span>
                        <span>·</span>
                        <span>{t('sessionSettings.every', { interval: t('sessionSettings.minutes', { n: intg.syncIntervalMin }) })}</span>
                        {intg.lastSync && (
                          <>
                            <span>·</span>
                            <span title={new Date(intg.lastSync).toLocaleString(locale)}>
                              {t('sessionSettings.syncAgo', { ago: formatAgo(t, intg.lastSync) })}
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
                        title={intg.enabled ? t('sessionSettings.disable') : t('sessionSettings.enable')}
                      >
                        <span className={notesStyles.toggleKnob} />
                      </button>
                      <button
                        type="button"
                        className={notesStyles.editBtn}
                        onClick={() => editingIntegrationId === intg.id ? cancelEditIntegration() : startEditIntegration(intg)}
                        title={editingIntegrationId === intg.id ? t('sessionSettings.collapse') : t('sessionSettings.edit')}
                        aria-label={t('sessionSettings.edit')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={notesStyles.deleteBtn}
                        onClick={() => handleDelete(intg)}
                        title={t('sessionSettings.delete')}
                        aria-label={t('sessionSettings.delete')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        </svg>
                      </button>
                    </div>
                    </div>
                    {editingIntegrationId === intg.id && (
                      <div className={notesStyles.editForm}>
                        <label className={notesStyles.editLabel}>
                          <span>{t('sessionSettings.nameLabel')}</span>
                          <input
                            type="text"
                            value={intgForm.serviceName}
                            onChange={e => setIntgForm(s => ({ ...s, serviceName: e.target.value }))}
                          />
                        </label>
                        <label className={notesStyles.editLabel}>
                          <span>{t('sessionSettings.syncPromptLabel')}</span>
                          <textarea
                            value={intgForm.syncPrompt}
                            onChange={e => setIntgForm(s => ({ ...s, syncPrompt: e.target.value }))}
                            rows={8}
                            placeholder={t('sessionSettings.syncPromptPlaceholder')}
                          />
                          <small className={notesStyles.editHint}>
                            {t('sessionSettings.syncPromptHintBefore')} <b>{t('sessionSettings.hintCategories')}</b>, <b>{t('sessionSettings.hintCounterparties')}</b>, <b>{t('sessionSettings.hintProjects')}</b>, <b>{t('sessionSettings.hintTags')}</b>{t('sessionSettings.syncPromptHintAfter')}
                          </small>
                        </label>
                        <div className={notesStyles.editFormRow}>
                          <label className={notesStyles.intervalLabel}>
                            {t('sessionSettings.interval')}
                            <select
                              value={intgForm.syncIntervalMin}
                              onChange={e => setIntgForm(s => ({ ...s, syncIntervalMin: Number(e.target.value) }))}
                            >
                              <option value={5}>{t('sessionSettings.minutes', { n: 5 })}</option>
                              <option value={10}>{t('sessionSettings.minutes', { n: 10 })}</option>
                              <option value={15}>{t('sessionSettings.minutes', { n: 15 })}</option>
                              <option value={30}>{t('sessionSettings.minutes', { n: 30 })}</option>
                              <option value={60}>{t('sessionSettings.hours', { n: 1 })}</option>
                              <option value={180}>{t('sessionSettings.hours', { n: 3 })}</option>
                              <option value={360}>{t('sessionSettings.hours', { n: 6 })}</option>
                              <option value={720}>{t('sessionSettings.hours', { n: 12 })}</option>
                              <option value={1440}>{t('sessionSettings.oneDay')}</option>
                            </select>
                          </label>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button type="button" className={styles.cancelBtn} onClick={cancelEditIntegration}>
                              {t('sessionSettings.cancel')}
                            </button>
                            <button
                              type="button"
                              className={notesStyles.saveTaskBtn}
                              onClick={saveEditIntegration}
                              disabled={!intgForm.serviceName.trim() || !intgForm.syncPrompt.trim()}
                            >
                              {t('sessionSettings.save')}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={notesStyles.section}>
            <div className={notesStyles.sectionHead}>
              <span>{t('sessionSettings.scheduledTasks')}</span>
              <span className={notesStyles.sectionCount}>{tasks.length}</span>
              <button
                type="button"
                className={notesStyles.addBtn}
                onClick={handleToggleAddForm}
                title={showAddTask ? t('sessionSettings.cancel') : t('sessionSettings.newTask')}
              >
                {showAddTask ? '−' : '+'}
              </button>
            </div>

            {showAddTask && (
              <div className={notesStyles.addForm}>
                <input
                  type="text"
                  placeholder={t('sessionSettings.taskNamePlaceholder')}
                  value={newTaskName}
                  onChange={e => setNewTaskName(e.target.value)}
                />
                <textarea
                  placeholder={t('sessionSettings.taskPromptPlaceholder')}
                  value={newTaskPrompt}
                  onChange={e => setNewTaskPrompt(e.target.value)}
                  rows={4}
                />
                <div className={notesStyles.addFormRow}>
                  <label className={notesStyles.intervalLabel}>
                    {t('sessionSettings.interval')}
                    <select
                      value={newTaskInterval}
                      onChange={e => setNewTaskInterval(Number(e.target.value))}
                    >
                      <option value={10}>{t('sessionSettings.minutes', { n: 10 })}</option>
                      <option value={15}>{t('sessionSettings.minutes', { n: 15 })}</option>
                      <option value={30}>{t('sessionSettings.minutes', { n: 30 })}</option>
                      <option value={60}>{t('sessionSettings.hours', { n: 1 })}</option>
                      <option value={180}>{t('sessionSettings.hours', { n: 3 })}</option>
                      <option value={360}>{t('sessionSettings.hours', { n: 6 })}</option>
                      <option value={720}>{t('sessionSettings.hours', { n: 12 })}</option>
                      <option value={1440}>{t('sessionSettings.oneDay')}</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className={notesStyles.saveTaskBtn}
                    onClick={handleSaveTask}
                    disabled={!newTaskName.trim() || !newTaskPrompt.trim()}
                  >
                    {editingTaskId ? t('sessionSettings.save') : t('sessionSettings.add')}
                  </button>
                </div>
              </div>
            )}

            {tasks.length === 0 && !showAddTask ? (
              <div className={notesStyles.empty}>
                {t('sessionSettings.noTasksBefore')} <b>+</b> {t('sessionSettings.noTasksAfter')}
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
                          <span className={notesStyles.errBadge}>{t('sessionSettings.errorBadge')}</span>
                        )}
                      </div>
                      <div className={notesStyles.rowMeta}>
                        <span>{t('sessionSettings.every', { interval: formatInterval(t, task.intervalMin) })}</span>
                        {task.lastRun && (
                          <>
                            <span>·</span>
                            <span title={new Date(task.lastRun).toLocaleString(locale)}>
                              {t('sessionSettings.lastRunAgo', { ago: formatAgo(t, task.lastRun) })}
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
                              {expanded ? t('sessionSettings.hideResult') : t('sessionSettings.showResult')}
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
                        title={task.enabled ? t('sessionSettings.disable') : t('sessionSettings.enable')}
                      >
                        <span className={notesStyles.toggleKnob} />
                      </button>
                      <button
                        type="button"
                        className={notesStyles.editBtn}
                        onClick={() => api.triggerTask(task.id)}
                        title={t('sessionSettings.runNow')}
                        aria-label={t('sessionSettings.runNow')}
                        disabled={!task.enabled}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={notesStyles.editBtn}
                        onClick={() => handleEditTask(task)}
                        title={t('sessionSettings.edit')}
                        aria-label={t('sessionSettings.edit')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={notesStyles.deleteBtn}
                        onClick={() => handleDeleteTask(task)}
                        title={t('sessionSettings.delete')}
                        aria-label={t('sessionSettings.delete')}
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

          <McpServersSection sessionId={session.id} />

          <FileBindingsSection
            session={{ ...session, apiKey: apiKey || undefined }}
            onUpdateSession={onUpdateSession}
          />

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              {t('sessionSettings.cancel')}
            </button>
            <button type="submit" className={styles.createBtn} disabled={!canSave}>
              {t('sessionSettings.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatAgo(t: TFunction, ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('sessionSettings.justNow');
  if (m < 60) return t('sessionSettings.minutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('sessionSettings.hoursAgo', { n: h });
  const d = Math.floor(h / 24);
  return t('sessionSettings.daysAgo', { n: d });
}

function formatInterval(t: TFunction, min: number): string {
  if (min < 60) return t('sessionSettings.minutes', { n: min });
  if (min < 1440) return t('sessionSettings.hours', { n: Math.round(min / 60) });
  return t('sessionSettings.days', { n: Math.round(min / 1440) });
}
