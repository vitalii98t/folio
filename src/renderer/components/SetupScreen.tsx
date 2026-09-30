import { useState } from 'react';
import type { ClaudeCodeStatus } from '../../shared/types';
import { useT } from '../i18n';
import styles from '../styles/SetupScreen.module.css';

const api = (window as any).finmapAgent;

interface Props {
  status: ClaudeCodeStatus;
  onRetry: () => void;
  onLogin: () => void;
}

export function SetupScreen({ status, onRetry, onLogin }: Props) {
  const { t } = useT();
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
            <h2>{t('setup.notInstalledTitle')}</h2>
            <p>{t('setup.notInstalledText')}</p>
            <div className={styles.btnGroup}>
              <button
                className={styles.primaryBtn}
                onClick={handleInstall}
                disabled={installing}
              >
                {installing ? t('setup.openingTerminal') : t('setup.install')}
              </button>
              <button className={styles.secondaryBtn} onClick={onRetry}>
                {t('setup.checkAgain')}
              </button>
            </div>
            <details className={styles.manual}>
              <summary>{t('setup.installManually')}</summary>
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
            <h2>{t('setup.needAuthTitle')}</h2>
            <p>{t('setup.needAuthText')}</p>
            <div className={styles.btnGroup}>
              <button className={styles.primaryBtn} onClick={onLogin}>
                {t('setup.login')}
              </button>
              <button className={styles.secondaryBtn} onClick={onRetry}>
                {t('setup.checkAgain')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
