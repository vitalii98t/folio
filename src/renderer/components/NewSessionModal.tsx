import { useState } from 'react';
import { useT } from '../i18n';
import styles from '../styles/NewSessionModal.module.css';

interface Props {
  onClose: () => void;
  /** apiKey is empty string when user chose "MCP-only" mode — session is created
   *  without Finmap connection, can be linked later via SessionSettingsModal. */
  onCreate: (name: string, apiKey: string) => Promise<void>;
}

export function NewSessionModal({ onClose, onCreate }: Props) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  // Guards against a double Enter / double click creating two companies
  // while the first create is still in flight.
  const [creating, setCreating] = useState(false);

  const canCreateFull = !creating && name.trim().length > 0 && apiKey.trim().length > 0;
  const canCreateMcpOnly = !creating && name.trim().length > 0;

  async function create(apiKeyValue: string) {
    setCreating(true);
    try {
      await onCreate(name.trim(), apiKeyValue);
    } finally {
      // The modal usually unmounts on success; this only matters on failure.
      setCreating(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canCreateFull) {
      void create(apiKey.trim());
    }
  }

  function handleSkipApiKey() {
    if (!canCreateMcpOnly) return;
    if (!confirm(t('newSession.confirmMcpOnly'))) return;
    void create('');
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h2>{t('newSession.title')}</h2>
        <form onSubmit={handleSubmit}>
          <label className={styles.field}>
            <span>{t('newSession.nameLabel')}</span>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('newSession.namePlaceholder')}
              autoFocus
            />
          </label>

          <label className={styles.field}>
            <span>{t('newSession.apiKeyLabel')}</span>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={t('newSession.apiKeyPlaceholder')}
            />
            <small className={styles.hint}>
              {t('newSession.apiKeyHint')}{' '}
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
                {t('newSession.skipApiKey')}
              </button>
            </small>
          </label>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              {t('newSession.cancel')}
            </button>
            <button type="submit" className={styles.createBtn} disabled={!canCreateFull}>
              {t('newSession.create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
