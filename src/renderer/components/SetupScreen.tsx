import { useState } from 'react';
import type { ClaudeCodeStatus } from '../../shared/types';
import styles from '../styles/SetupScreen.module.css';

const api = (window as any).finmapAgent;

interface Props {
  status: ClaudeCodeStatus;
  onRetry: () => void;
  onLogin: () => void;
}

export function SetupScreen({ status, onRetry, onLogin }: Props) {
  const [installing, setInstalling] = useState(false);

  const handleInstall = async () => {
    setInstalling(true);
    await api.installClaudeCode();
    // Installer opens in external terminal — we just unlock the "check again" button
    setTimeout(() => setInstalling(false), 1500);
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Folio</h1>

        {status === 'not_installed' && (
          <>
            <div className={styles.icon}>&#9888;</div>
            <h2>Claude Code не встановлений</h2>
            <p>Для роботи Folio потрібен Claude Code CLI. Натисни кнопку — відкриється термінал і встановлення пройде автоматично.</p>
            <div className={styles.btnGroup}>
              <button
                className={styles.primaryBtn}
                onClick={handleInstall}
                disabled={installing}
              >
                {installing ? 'Відкриваю термінал…' : 'Встановити Claude Code'}
              </button>
              <button className={styles.secondaryBtn} onClick={onRetry}>
                Перевірити знову
              </button>
            </div>
            <details className={styles.manual}>
              <summary>Встановити вручну</summary>
              <p className={styles.osLabel}>macOS / Linux:</p>
              <code className={styles.code}>curl -fsSL https://claude.ai/install.sh | sh</code>
              <p className={styles.osLabel}>Windows (cmd):</p>
              <code className={styles.code}>curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd</code>
            </details>
          </>
        )}

        {status === 'not_authenticated' && (
          <>
            <div className={styles.icon}>&#128274;</div>
            <h2>Потрібна авторизація</h2>
            <p>Claude Code встановлений, але потрібно увійти в акаунт. Натисни — відкриється термінал і пройдеш авторизацію через браузер.</p>
            <div className={styles.btnGroup}>
              <button className={styles.primaryBtn} onClick={onLogin}>
                Увійти в Claude Code
              </button>
              <button className={styles.secondaryBtn} onClick={onRetry}>
                Перевірити знову
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
