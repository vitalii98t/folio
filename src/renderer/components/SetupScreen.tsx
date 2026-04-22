import type { ClaudeCodeStatus } from '../../shared/types';
import styles from '../styles/SetupScreen.module.css';

interface Props {
  status: ClaudeCodeStatus;
  onRetry: () => void;
  onLogin: () => void;
}

export function SetupScreen({ status, onRetry, onLogin }: Props) {
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Folio</h1>

        {status === 'not_installed' && (
          <>
            <div className={styles.icon}>&#9888;</div>
            <h2>Claude Code не встановлений</h2>
            <p>Для роботи Folio потрібен Claude Code CLI.</p>
            <div className={styles.steps}>
              <h3>Як встановити:</h3>
              <p className={styles.osLabel}>Windows (CMD):</p>
              <code className={styles.code}>curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd</code>
              <p className={styles.osLabel}>Windows (PowerShell):</p>
              <code className={styles.code}>curl -fsSL https://claude.ai/install.cmd -o install.cmd; .\install.cmd; del install.cmd</code>
              <p className={styles.osLabel}>macOS / Linux:</p>
              <code className={styles.code}>curl -fsSL https://claude.ai/install.sh | sh</code>
              <p className={styles.stepNote}>Після встановлення натисніть "Перевірити знову"</p>
            </div>
            <button className={styles.primaryBtn} onClick={onRetry}>
              Перевірити знову
            </button>
          </>
        )}

        {status === 'not_authenticated' && (
          <>
            <div className={styles.icon}>&#128274;</div>
            <h2>Потрібна авторизація</h2>
            <p>Claude Code встановлений, але потрібно увійти в акаунт.</p>
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
