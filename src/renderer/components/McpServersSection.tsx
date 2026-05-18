import { useState, useEffect, useCallback } from 'react';
import type { McpServerConfig } from '../../shared/types';
import notesStyles from '../styles/SessionSettingsModal.module.css';

const api = (window as any).finmapAgent;

interface Props {
  sessionId: string;
}

interface FormState {
  name: string;
  command: string;
  args: string;          // newline-separated
  envText: string;       // "KEY=value" per line
  autoApproveAll: boolean;
}

const emptyForm: FormState = {
  name: '',
  command: 'npx',
  args: '',
  envText: '',
  autoApproveAll: false,
};

/**
 * Manages user-configured MCP servers attached to a session. Lives inside
 * SessionSettingsModal — mirrors the visual pattern of the Integrations
 * section so users get the same row/edit/toggle/delete affordances they
 * already know.
 */
interface TaskFormState {
  name: string;
  prompt: string;
  intervalMin: number;
}

const emptyTaskForm: TaskFormState = {
  name: '',
  prompt: '',
  intervalMin: 60,
};

export function McpServersSection({ sessionId }: Props) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  // Separate state for the inline "+ Автозадача" form attached to each server.
  // Holds the server-id whose form is open; null = no form open.
  const [creatingTaskFor, setCreatingTaskFor] = useState<string | null>(null);
  const [taskForm, setTaskForm] = useState<TaskFormState>(emptyTaskForm);
  const [taskCreated, setTaskCreated] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getMcpServers(sessionId).then(setServers);
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setShowAdd(false);
  }

  function startEdit(s: McpServerConfig) {
    setEditingId(s.id);
    setShowAdd(false);
    setForm({
      name: s.name,
      command: s.command,
      args: s.args.join('\n'),
      envText: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      autoApproveAll: s.autoApproveAll,
    });
  }

  function toggleAddForm() {
    if (showAdd) {
      resetForm();
    } else {
      setEditingId(null);
      setForm(emptyForm);
      setShowAdd(true);
    }
  }

  function parseEnv(text: string): Record<string, string> | undefined {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) env[k] = v;
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }

  async function save() {
    const name = form.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!name || !form.command.trim()) return;
    const args = form.args.split('\n').map(s => s.trim()).filter(Boolean);
    const env = parseEnv(form.envText);

    if (editingId) {
      await api.updateMcpServer(editingId, {
        name,
        command: form.command.trim(),
        args,
        env,
        autoApproveAll: form.autoApproveAll,
      });
    } else {
      await api.createMcpServer({
        sessionId,
        name,
        command: form.command.trim(),
        args,
        env,
        enabled: true,
        autoApproveAll: form.autoApproveAll,
      });
    }
    resetForm();
    load();
  }

  async function toggleServer(id: string) {
    await api.toggleMcpServer(id);
    load();
  }

  async function remove(s: McpServerConfig) {
    if (!confirm(`Видалити MCP-сервер "${s.name}"?`)) return;
    await api.deleteMcpServer(s.id);
    if (editingId === s.id) resetForm();
    load();
  }

  function startCreateTask(s: McpServerConfig) {
    setCreatingTaskFor(s.id);
    setTaskCreated(null);
    setTaskForm({
      ...emptyTaskForm,
      // Sensible defaults — Claude can edit but UX is faster with a name hinted.
      name: `Автозадача через ${s.name}`,
    });
  }

  function cancelCreateTask() {
    setCreatingTaskFor(null);
    setTaskForm(emptyTaskForm);
  }

  async function saveTask(s: McpServerConfig) {
    if (!taskForm.name.trim() || !taskForm.prompt.trim()) return;
    // Scaffold the prompt so Claude knows which MCP tools are in play.
    // The user's text stays raw — we just prepend a one-liner with context.
    const fullPrompt =
      `[Автозадача через MCP-сервер "${s.name}". Використовуй інструменти mcp__${s.name}__* для роботи з цим сервісом.]\n\n` +
      taskForm.prompt.trim();
    await api.createTask({
      sessionId,
      name: taskForm.name.trim(),
      prompt: fullPrompt,
      intervalMin: taskForm.intervalMin,
      enabled: true,
    });
    setTaskCreated(s.id);
    setCreatingTaskFor(null);
    setTaskForm(emptyTaskForm);
    // Clear "task created" hint after a few seconds
    setTimeout(() => setTaskCreated(null), 5000);
  }

  const canSave = form.name.trim().length > 0 && form.command.trim().length > 0;

  return (
    <section className={notesStyles.section}>
      <div className={notesStyles.sectionHead}>
        <span>MCP-сервери</span>
        <span className={notesStyles.sectionCount}>{servers.length}</span>
        <button
          type="button"
          className={notesStyles.addBtn}
          onClick={toggleAddForm}
          title={showAdd ? 'Скасувати' : 'Новий MCP-сервер'}
        >
          {showAdd ? '−' : '+'}
        </button>
      </div>

      {showAdd && (
        <div className={notesStyles.addForm}>
          <input
            type="text"
            placeholder="Назва (namespace): slack, notion, telegram..."
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
          />
          <input
            type="text"
            placeholder="Команда: npx / uvx / абсолютний шлях"
            value={form.command}
            onChange={e => setForm({ ...form, command: e.target.value })}
          />
          <textarea
            rows={2}
            placeholder={'Аргументи (по одному на рядок):\n-y\n@modelcontextprotocol/server-slack'}
            value={form.args}
            onChange={e => setForm({ ...form, args: e.target.value })}
          />
          <textarea
            rows={3}
            placeholder={'Env: KEY=value (по одній на рядок):\nSLACK_BOT_TOKEN=xoxb-...\nSLACK_TEAM_ID=T123...'}
            value={form.envText}
            onChange={e => setForm({ ...form, envText: e.target.value })}
          />
          <label className={notesStyles.intervalLabel} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={form.autoApproveAll}
              onChange={e => setForm({ ...form, autoApproveAll: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span>Авто-схвалювати всі інструменти</span>
          </label>
          <button
            type="button"
            className={notesStyles.saveTaskBtn}
            onClick={save}
            disabled={!canSave}
          >
            Додати
          </button>
        </div>
      )}

      {servers.length === 0 && !showAdd ? (
        <div className={notesStyles.empty}>
          Немає підключених MCP-серверів. Натисни <b>+</b> або скажи в чаті <b>"хочу підключити &lt;сервіс&gt;"</b>.
        </div>
      ) : (
        <div className={notesStyles.list}>
          {servers.map(s => (
            <div
              key={s.id}
              className={`${notesStyles.row} ${editingId === s.id ? notesStyles.rowEditing : ''}`}
            >
              <div className={notesStyles.rowHeader}>
                <div className={notesStyles.rowMain}>
                  <div className={notesStyles.rowTitle}>
                    <span className={`${notesStyles.statusDot} ${s.enabled ? notesStyles.on : notesStyles.off}`} />
                    <span className={notesStyles.rowName}>{s.name}</span>
                    {s.autoApproveAll && <span className={notesStyles.errBadge}>auto</span>}
                  </div>
                  <div className={notesStyles.rowMeta}>
                    <span><code>{s.command}{s.args.length > 0 ? ' ' + s.args.join(' ') : ''}</code></span>
                    {s.env && Object.keys(s.env).length > 0 && (
                      <>
                        <span>·</span>
                        <span>{Object.keys(s.env).length} env</span>
                      </>
                    )}
                  </div>
                </div>
                <div className={notesStyles.rowActions}>
                  <button
                    type="button"
                    className={`${notesStyles.toggle} ${s.enabled ? notesStyles.toggleOn : ''}`}
                    onClick={() => toggleServer(s.id)}
                    title={s.enabled ? 'Вимкнути' : 'Увімкнути'}
                  >
                    <span className={notesStyles.toggleKnob} />
                  </button>
                  <button
                    type="button"
                    className={notesStyles.editBtn}
                    onClick={() => creatingTaskFor === s.id ? cancelCreateTask() : startCreateTask(s)}
                    title={creatingTaskFor === s.id ? 'Згорнути' : 'Створити автозадачу для цього MCP'}
                    aria-label="Створити автозадачу"
                    disabled={!s.enabled}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={notesStyles.editBtn}
                    onClick={() => editingId === s.id ? resetForm() : startEdit(s)}
                    title={editingId === s.id ? 'Згорнути' : 'Редагувати'}
                    aria-label="Редагувати"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={notesStyles.deleteBtn}
                    onClick={() => remove(s)}
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

              {taskCreated === s.id && (
                <div className={notesStyles.editForm} style={{ background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.25)' }}>
                  <span style={{ color: '#86efac', fontSize: 13 }}>
                    ✅ Автозадача створена. Знайдеш її у секції <b>Автозадачі</b> вище — там же можна редагувати, запустити вручну, вимкнути.
                  </span>
                </div>
              )}

              {creatingTaskFor === s.id && (
                <div className={notesStyles.editForm}>
                  <label className={notesStyles.editLabel}>
                    <span>Назва задачі</span>
                    <input
                      type="text"
                      value={taskForm.name}
                      onChange={e => setTaskForm({ ...taskForm, name: e.target.value })}
                      placeholder={`Автозадача через ${s.name}`}
                    />
                  </label>
                  <label className={notesStyles.editLabel}>
                    <span>Що має робити задача</span>
                    <textarea
                      rows={5}
                      value={taskForm.prompt}
                      onChange={e => setTaskForm({ ...taskForm, prompt: e.target.value })}
                      placeholder={`Опиши що Claude має робити, використовуючи інструменти ${s.name}.\n\nПриклад для gsheets:\nЩодня тягни суми по категоріях за поточний місяць з Finmap і записуй у таблицю https://docs.google.com/spreadsheets/d/abc.../ аркуш "Звіт", колонки A:B`}
                    />
                  </label>
                  <label className={notesStyles.intervalLabel}>
                    Інтервал
                    <select
                      value={taskForm.intervalMin}
                      onChange={e => setTaskForm({ ...taskForm, intervalMin: Number(e.target.value) })}
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
                  <div className={notesStyles.editFormRow}>
                    <button
                      type="button"
                      className={notesStyles.saveTaskBtn}
                      onClick={() => saveTask(s)}
                      disabled={!taskForm.name.trim() || !taskForm.prompt.trim()}
                    >
                      Створити
                    </button>
                  </div>
                </div>
              )}

              {editingId === s.id && (
                <div className={notesStyles.editForm}>
                  <label className={notesStyles.editLabel}>
                    <span>Назва (namespace)</span>
                    <input
                      type="text"
                      value={form.name}
                      onChange={e => setForm({ ...form, name: e.target.value })}
                    />
                  </label>
                  <label className={notesStyles.editLabel}>
                    <span>Команда</span>
                    <input
                      type="text"
                      value={form.command}
                      onChange={e => setForm({ ...form, command: e.target.value })}
                    />
                  </label>
                  <label className={notesStyles.editLabel}>
                    <span>Аргументи (по одному на рядок)</span>
                    <textarea
                      rows={2}
                      value={form.args}
                      onChange={e => setForm({ ...form, args: e.target.value })}
                    />
                  </label>
                  <label className={notesStyles.editLabel}>
                    <span>Env (KEY=value, по одній на рядок)</span>
                    <textarea
                      rows={3}
                      value={form.envText}
                      onChange={e => setForm({ ...form, envText: e.target.value })}
                    />
                  </label>
                  <label className={notesStyles.intervalLabel} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={form.autoApproveAll}
                      onChange={e => setForm({ ...form, autoApproveAll: e.target.checked })}
                      style={{ width: 'auto' }}
                    />
                    <span>Авто-схвалювати всі інструменти</span>
                  </label>
                  <div className={notesStyles.editFormRow}>
                    <button
                      type="button"
                      className={notesStyles.saveTaskBtn}
                      onClick={save}
                      disabled={!canSave}
                    >
                      Зберегти
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
