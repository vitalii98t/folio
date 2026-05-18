import { useState } from 'react';
import styles from '../styles/NewSessionModal.module.css';

interface Props {
  onClose: () => void;
  /** apiKey is empty string when user chose "MCP-only" mode — session is created
   *  without Finmap connection, can be linked later via SessionSettingsModal. */
  onCreate: (name: string, apiKey: string) => void;
}

export function NewSessionModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');

  const canCreateFull = name.trim().length > 0 && apiKey.trim().length > 0;
  const canCreateMcpOnly = name.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canCreateFull) {
      onCreate(name.trim(), apiKey.trim());
    }
  }

  function handleSkipApiKey() {
    if (!canCreateMcpOnly) return;
    if (!confirm(
      'Створити сесію без Finmap API-ключа?\n\n' +
      'У цьому режимі будуть доступні MCP-сервери (Jira, GSheets, Notion, GitHub тощо), ' +
      'але Finmap-інструменти (операції, категорії, інвойси) не працюватимуть. ' +
      'Ключ можна додати пізніше у налаштуваннях сесії.'
    )) return;
    onCreate(name.trim(), '');
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h2>Додати компанію</h2>
        <form onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span>Назва компанії</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Моя компанія"
              autoFocus
            />
          </label>

          <label className={styles.field}>
            <span>Finmap API ключ</span>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Вставте API ключ з Finmap"
            />
            <small className={styles.hint}>
              Знайти можна в Finmap &rarr; Налаштування &rarr; API.{' '}
              <button
                type="button"
                onClick={handleSkipApiKey}
                disabled={!canCreateMcpOnly}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: canCreateMcpOnly ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: canCreateMcpOnly ? 'pointer' : 'not-allowed',
                  textDecoration: 'underline',
                  padding: 0,
                  font: 'inherit',
                }}
              >
                Пропустити — створити сесію тільки для MCP
              </button>
            </small>
          </label>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Скасувати
            </button>
            <button type="submit" className={styles.createBtn} disabled={!canCreateFull}>
              Додати
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
