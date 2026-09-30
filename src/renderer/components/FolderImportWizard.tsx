import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '../../shared/types';
import { useT } from '../i18n';
import styles from '../styles/NewSessionModal.module.css';
import notesStyles from '../styles/SessionSettingsModal.module.css';
import wizardStyles from '../styles/FolderImportWizard.module.css';

const api = (window as any).finmapAgent;

interface Props {
  session: ChatSession;
  /** Persists session changes through App (keeps `sessions` state fresh). */
  onUpdateSession: (id: string, updates: Partial<ChatSession>) => Promise<void>;
  onClose: () => void;
  /** Called when binding is created — parent reloads its list. */
  onCreated?: () => void;
}

type Step = 'apiKey' | 'folder' | 'account' | 'context' | 'interval' | 'firstFile' | 'done';

interface Account {
  id: string;
  label: string;
  balance?: number;
  currencyId?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: number;
}

/**
 * Native step-by-step wizard for setting up a Google Drive folder import.
 *
 * Why not chat-driven? Because Drive auth + folder browsing inside a chat
 * (where Claude can't run /mcp slash commands) was awkward. The wizard is
 * the predictable surface: paste API key once, paste folder URL, pick an
 * account, choose how to handle the latest file, save. Future runs happen
 * automatically via SyncScheduler.runBinding.
 */
export function FolderImportWizard({ session, onUpdateSession, onClose, onCreated }: Props) {
  const { t, locale } = useT();
  const [step, setStep] = useState<Step>(session.googleDriveApiKey ? 'folder' : 'apiKey');
  const [apiKey, setApiKey] = useState(session.googleDriveApiKey ?? '');
  const [folderUrl, setFolderUrl] = useState('');
  const [folderId, setFolderId] = useState('');
  const [folderName, setFolderName] = useState('');
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [accountName, setAccountName] = useState('');

  const [contextPrompt, setContextPrompt] = useState('');
  const [intervalMin, setIntervalMin] = useState(30);

  const [importLatest, setImportLatest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Polling interval choices (minutes) with localised labels
  const intervalOptions = [
    { value: 15, label: t('folderImport.interval.fifteenMin') },
    { value: 30, label: t('folderImport.interval.thirtyMin') },
    { value: 60, label: t('folderImport.interval.oneHour') },
    { value: 360, label: t('folderImport.interval.sixHours') },
    { value: 1440, label: t('folderImport.interval.oneDay') },
  ];

  // Load Finmap accounts when we reach the account step
  useEffect(() => {
    if (step !== 'account' || accounts.length > 0) return;
    setAccountsLoading(true);
    // The MCP tool isn't directly callable from renderer — use direct REST
    // through the api proxy. We rely on the SDK's get_accounts being exposed
    // via a future IPC, but for now use a fallback: trigger Claude to list
    // accounts. For MVP just expose via an IPC we already have.
    // Actually we don't have a direct getAccounts IPC. Use a fetch to Finmap
    // API directly via main process.
    api.getFinmapAccounts?.(session.apiKey)
      .then((list: Account[]) => setAccounts(list ?? []))
      .catch(() => setAccounts([]))
      .finally(() => setAccountsLoading(false));
  }, [step, session.apiKey, accounts.length]);

  async function validateFolder() {
    setValidating(true);
    setValidateError(null);
    try {
      const result = await api.gdriveValidate(apiKey.trim(), folderUrl.trim());
      if (!result.ok) {
        setValidateError(result.error);
        return;
      }
      setFolderId(result.folderId);
      setFolderName(result.folder.name);
      // We need full file list for baseline; sample is enough for preview.
      setFiles(result.sampleFiles);
      // Persist API key on session if it changed
      if (session.googleDriveApiKey !== apiKey.trim()) {
        await onUpdateSession(session.id, { googleDriveApiKey: apiKey.trim() });
      }
      setStep('account');
    } catch (err: any) {
      setValidateError(err?.message ?? t('folderImport.validateError'));
    } finally {
      setValidating(false);
    }
  }

  async function finish() {
    setSaving(true);
    setSaveError(null);
    try {
      // Fetch the complete file list to seed baseline correctly
      const listResult = await api.gdriveListFiles(apiKey.trim(), folderId);
      if (!listResult.ok) {
        setSaveError(t('folderImport.listFilesError', { error: listResult.error }));
        return;
      }
      const allFiles: DriveFile[] = listResult.files ?? [];
      const latestId = allFiles[0]?.id;

      // If user wants to import the latest one, exclude its ID from the
      // baseline. Everything else (older files) goes straight into processed
      // so they're never imported.
      const processedFileIds = importLatest && latestId
        ? allFiles.filter(f => f.id !== latestId).map(f => f.id)
        : allFiles.map(f => f.id);

      const created = await api.createFileBinding({
        sessionId: session.id,
        sourceServerName: 'gdrive-direct',
        sourceFolderId: folderId,
        sourceFolderName: folderName,
        finmapAccountId: accountId,
        finmapAccountName: accountName,
        contextPrompt: contextPrompt.trim(),
        syncIntervalMin: intervalMin,
        enabled: true,
        processedFileIds,
      });

      // User opted to import the latest file — run the binding right away
      // instead of waiting for the next scheduler tick. The run will see the
      // latest file is NOT in processedFileIds and process it.
      if (importLatest && latestId && created?.id) {
        await api.triggerFileBinding(created.id);
      }

      setStep('done');
      onCreated?.();
    } catch (err: any) {
      setSaveError(err?.message ?? t('folderImport.saveError'));
    } finally {
      setSaving(false);
    }
  }

  const latestFile = files[0];

  // Portal to <body> so the wizard gets its own full-screen overlay above the
  // settings modal instead of being laid out inside its scroll container.
  // React events still bubble through portals along the component tree, so
  // stop them here — otherwise clicks/keys reach SessionSettingsModal (whose
  // overlay click closes it and whose form handles Enter).
  return createPortal(
    <div
      className={`${styles.overlay} ${wizardStyles.overlay}`}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <div
        className={`${styles.modal} ${wizardStyles.modal}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('folderImport.title')}
      >
        <div className={wizardStyles.header}>
          <h2>{t('folderImport.title')}</h2>
          <button type="button" className={wizardStyles.closeBtn} onClick={onClose} aria-label={t('folderImport.close')}>×</button>
        </div>

        <div className={wizardStyles.body}>
          <Stepper step={step} />

          {step === 'apiKey' && (
            <section>
              <h3>{t('folderImport.apiKeyStep.title')}</h3>
              <p className={notesStyles.editHint}>
                {t('folderImport.apiKeyStep.hint')}
              </p>
              <ol style={{ fontSize: 13, lineHeight: 1.7, color: '#a1a1aa', paddingLeft: 20 }}>
                <li>{t('folderImport.apiKeyStep.openConsole')} <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer">console.cloud.google.com</a> {t('folderImport.apiKeyStep.createProject')}</li>
                <li>{t('folderImport.apiKeyStep.enableApiBefore')} <b>Google Drive API</b> {t('folderImport.apiKeyStep.enableApiAfter')}</li>
                <li>{t('folderImport.apiKeyStep.createCredentials')} <b>API key</b></li>
                <li>{t('folderImport.apiKeyStep.restrictKey')}</li>
                <li>{t('folderImport.apiKeyStep.copyKey')}</li>
              </ol>
              <input
                type="text"
                placeholder={t('folderImport.apiKeyStep.placeholder')}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                style={{ width: '100%', padding: 10, fontSize: 14, marginTop: 12, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, color: '#fff' }}
              />
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={onClose}>{t('folderImport.cancel')}</button>
                <button
                  type="button"
                  className={styles.createBtn}
                  onClick={() => setStep('folder')}
                  disabled={!apiKey.trim()}
                >{t('folderImport.next')}</button>
              </div>
            </section>
          )}

          {step === 'folder' && (
            <section>
              <h3>{t('folderImport.folderStep.title')}</h3>
              <p className={notesStyles.editHint}>
                {t('folderImport.folderStep.shareHintBefore')} <b>Share</b> {t('folderImport.folderStep.shareHintMiddle')} <b>Viewer</b>{t('folderImport.folderStep.shareHintAfter')}
              </p>
              <input
                type="text"
                placeholder={t('folderImport.folderStep.placeholder')}
                value={folderUrl}
                onChange={e => setFolderUrl(e.target.value)}
                style={{ width: '100%', padding: 10, fontSize: 14, marginTop: 8, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, color: '#fff' }}
              />
              {validateError && (
                <div style={{ marginTop: 12, padding: 10, background: 'rgba(220, 38, 38, 0.1)', border: '1px solid rgba(220, 38, 38, 0.3)', borderRadius: 6, color: '#fca5a5', fontSize: 13 }}>
                  {validateError}
                </div>
              )}
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('apiKey')}>{t('folderImport.back')}</button>
                <button
                  type="button"
                  className={styles.createBtn}
                  onClick={validateFolder}
                  disabled={!folderUrl.trim() || validating}
                >{validating ? t('folderImport.folderStep.validating') : t('folderImport.folderStep.checkAccess')}</button>
              </div>
            </section>
          )}

          {step === 'account' && (
            <section>
              <h3>{t('folderImport.accountStep.title')}</h3>
              <p className={notesStyles.editHint}>
                {t('folderImport.accountStep.folderLabel')} <b>{folderName}</b> {t('folderImport.accountStep.filesCount', { n: files.length })}
              </p>
              {accountsLoading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>{t('folderImport.accountStep.loading')}</div>
              ) : accounts.length === 0 ? (
                <div style={{ padding: 12, background: 'rgba(220,38,38,0.1)', borderRadius: 6, color: '#fca5a5', fontSize: 13 }}>
                  {t('folderImport.accountStep.loadError')}
                </div>
              ) : (
                <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid #2a2a30', borderRadius: 6 }}>
                  {accounts.map(acc => (
                    <label
                      key={acc.id}
                      style={{
                        display: 'flex', alignItems: 'center', padding: '10px 12px', cursor: 'pointer',
                        background: accountId === acc.id ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                        borderBottom: '1px solid #1f1f24',
                      }}
                    >
                      <input
                        type="radio"
                        name="account"
                        checked={accountId === acc.id}
                        onChange={() => { setAccountId(acc.id); setAccountName(acc.label); }}
                        style={{ marginRight: 12 }}
                      />
                      <div style={{ flex: 1, fontSize: 14 }}>
                        <div style={{ fontWeight: 500 }}>{acc.label}</div>
                        {typeof acc.balance === 'number' && (
                          <div style={{ fontSize: 12, color: '#888' }}>{acc.balance.toLocaleString(locale)} {acc.currencyId ?? ''}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('folder')}>{t('folderImport.back')}</button>
                <button type="button" className={styles.createBtn} onClick={() => setStep('context')} disabled={!accountId}>{t('folderImport.next')}</button>
              </div>
            </section>
          )}

          {step === 'context' && (
            <section>
              <h3>{t('folderImport.contextStep.title')}</h3>
              <p className={notesStyles.editHint}>
                {t('folderImport.contextStep.hint')}
              </p>
              <textarea
                rows={8}
                value={contextPrompt}
                onChange={e => setContextPrompt(e.target.value)}
                placeholder={t('folderImport.contextStep.placeholder')}
                style={{ width: '100%', padding: 10, fontSize: 13, marginTop: 8, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, color: '#fff', fontFamily: 'inherit' }}
              />
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('account')}>{t('folderImport.back')}</button>
                <button type="button" className={styles.createBtn} onClick={() => setStep('interval')} disabled={!contextPrompt.trim()}>{t('folderImport.next')}</button>
              </div>
            </section>
          )}

          {step === 'interval' && (
            <section>
              <h3>{t('folderImport.intervalStep.title')}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {intervalOptions.map(opt => (
                  <label
                    key={opt.value}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '10px 12px', borderRadius: 6, cursor: 'pointer',
                      background: intervalMin === opt.value ? 'rgba(59, 130, 246, 0.15)' : '#1a1a1f',
                      border: '1px solid #2a2a30',
                    }}
                  >
                    <input
                      type="radio"
                      name="interval"
                      checked={intervalMin === opt.value}
                      onChange={() => setIntervalMin(opt.value)}
                      style={{ marginRight: 12 }}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('context')}>{t('folderImport.back')}</button>
                <button type="button" className={styles.createBtn} onClick={() => setStep('firstFile')}>{t('folderImport.next')}</button>
              </div>
            </section>
          )}

          {step === 'firstFile' && (
            <section>
              <h3>{t('folderImport.firstFileStep.title')}</h3>
              {latestFile ? (
                <>
                  <p className={notesStyles.editHint}>
                    {t('folderImport.firstFileStep.hint')}
                  </p>
                  <div style={{ padding: 12, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, marginTop: 8 }}>
                    <div style={{ fontWeight: 500 }}>📄 {latestFile.name}</div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                      {latestFile.modifiedTime && new Date(latestFile.modifiedTime).toLocaleString(locale)}
                      {typeof latestFile.size === 'number' && ` · ${formatSize(latestFile.size)}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                    <label
                      style={{
                        flex: 1, display: 'flex', alignItems: 'flex-start', padding: 12, borderRadius: 6, cursor: 'pointer',
                        background: !importLatest ? 'rgba(59, 130, 246, 0.15)' : '#1a1a1f',
                        border: '1px solid #2a2a30',
                      }}
                    >
                      <input type="radio" checked={!importLatest} onChange={() => setImportLatest(false)} style={{ marginRight: 10, marginTop: 3 }} />
                      <div>
                        <div style={{ fontWeight: 500 }}>{t('folderImport.firstFileStep.skip')}</div>
                        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{t('folderImport.firstFileStep.skipHint')}</div>
                      </div>
                    </label>
                    <label
                      style={{
                        flex: 1, display: 'flex', alignItems: 'flex-start', padding: 12, borderRadius: 6, cursor: 'pointer',
                        background: importLatest ? 'rgba(59, 130, 246, 0.15)' : '#1a1a1f',
                        border: '1px solid #2a2a30',
                      }}
                    >
                      <input type="radio" checked={importLatest} onChange={() => setImportLatest(true)} style={{ marginRight: 10, marginTop: 3 }} />
                      <div>
                        <div style={{ fontWeight: 500 }}>{t('folderImport.firstFileStep.importThis')}</div>
                        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{t('folderImport.firstFileStep.importHint')}</div>
                      </div>
                    </label>
                  </div>
                </>
              ) : (
                <p className={notesStyles.editHint}>{t('folderImport.firstFileStep.emptyFolder')}</p>
              )}
              {saveError && (
                <div style={{ marginTop: 12, padding: 10, background: 'rgba(220, 38, 38, 0.1)', borderRadius: 6, color: '#fca5a5', fontSize: 13 }}>
                  {saveError}
                </div>
              )}
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('interval')}>{t('folderImport.back')}</button>
                <button type="button" className={styles.createBtn} onClick={finish} disabled={saving}>{saving ? t('folderImport.firstFileStep.saving') : t('folderImport.firstFileStep.create')}</button>
              </div>
            </section>
          )}

          {step === 'done' && (
            <section style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <h3>{t('folderImport.doneStep.title')}</h3>
              <p style={{ color: '#a1a1aa', fontSize: 14, maxWidth: 400, margin: '12px auto' }}>
                {t('folderImport.doneStep.folderConnectedBefore')} <b>{folderName}</b> {t('folderImport.doneStep.folderConnectedMiddle')} <b>{accountName}</b>{t('folderImport.doneStep.summary', { interval: intervalOptions.find(o => o.value === intervalMin)?.label ?? '' })}
              </p>
              <button type="button" className={styles.createBtn} onClick={onClose} style={{ marginTop: 12 }}>{t('folderImport.close')}</button>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Stepper({ step }: { step: Step }) {
  const order: Step[] = ['apiKey', 'folder', 'account', 'context', 'interval', 'firstFile', 'done'];
  const idx = order.indexOf(step);
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 24 }}>
      {order.slice(0, 6).map((s, i) => (
        <div
          key={s}
          style={{
            flex: 1,
            height: 3,
            borderRadius: 2,
            background: i <= idx ? '#3b82f6' : '#2a2a30',
          }}
        />
      ))}
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
