import { useState } from 'react';
import styles from '../styles/NewSessionModal.module.css';

interface Props {
  onClose: () => void;
  onCreate: (name: string, apiKey: string) => void;
}

export function NewSessionModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');

  const canCreate = name.trim().length > 0 && apiKey.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canCreate) {
      onCreate(name.trim(), apiKey.trim());
    }
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
              Знайти можна в Finmap &rarr; Налаштування &rarr; API
            </small>
          </label>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              Скасувати
            </button>
            <button type="submit" className={styles.createBtn} disabled={!canCreate}>
              Додати
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
