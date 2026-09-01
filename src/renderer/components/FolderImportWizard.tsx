import { useState, useEffect } from 'react';
import type { ChatSession } from '../../shared/types';
import styles from '../styles/NewSessionModal.module.css';
import notesStyles from '../styles/SessionSettingsModal.module.css';

const api = (window as any).finmapAgent;

interface Props {
  session: ChatSession;
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

const INTERVAL_OPTIONS = [
  { value: 15, label: '15 хв' },
  { value: 30, label: '30 хв' },
  { value: 60, label: '1 година' },
  { value: 360, label: '6 годин' },
  { value: 1440, label: '1 день' },
];

/**
 * Native step-by-step wizard for setting up a Google Drive folder import.
 *
 * Why not chat-driven? Because Drive auth + folder browsing inside a chat
 * (where Claude can't run /mcp slash commands) was awkward. The wizard is
 * the predictable surface: paste API key once, paste folder URL, pick an
 * account, choose how to handle the latest file, save. Future runs happen
 * automatically via SyncScheduler.runBinding.
 */
export function FolderImportWizard({ session, onClose, onCreated }: Props) {
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
        await api.updateSession(session.id, { googleDriveApiKey: apiKey.trim() });
      }
      setStep('account');
    } catch (err: any) {
      setValidateError(err?.message ?? 'Помилка перевірки');
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
        setSaveError(`Не вдалося отримати повний список файлів: ${listResult.error}`);
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
      setSaveError(err?.message ?? 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  }

  const latestFile = files[0];

  return (
    <div className={styles.backdrop}>
      <div className={`${styles.modal} ${notesStyles.wide}`}>
        <div className={styles.header}>
          <h2>Авто-імпорт з Google Drive папки</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Закрити">×</button>
        </div>

        <div style={{ padding: '16px 24px 24px' }}>
          <Stepper step={step} />

          {step === 'apiKey' && (
            <section>
              <h3>Крок 1. Google Drive API Key</h3>
              <p className={notesStyles.editHint}>
                Потрібен особистий ключ, який ти створюєш у Google Cloud Console (5 хвилин).
                Він зберігається локально у Folio, прив'язаний до цієї сесії.
              </p>
              <ol style={{ fontSize: 13, lineHeight: 1.7, color: '#a1a1aa', paddingLeft: 20 }}>
                <li>Відкрий <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer">console.cloud.google.com</a> → створи (або обери) проект</li>
                <li>APIs & Services → Library → знайди <b>Google Drive API</b> → Enable</li>
                <li>Credentials → Create credentials → <b>API key</b></li>
                <li>(Опційно) Restrict key → API restrictions → Google Drive API only</li>
                <li>Копіюй ключ і встав сюди ↓</li>
              </ol>
              <input
                type="text"
                placeholder="AIzaSy..."
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                style={{ width: '100%', padding: 10, fontSize: 14, marginTop: 12, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, color: '#fff' }}
              />
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={onClose}>Скасувати</button>
                <button
                  type="button"
                  className={styles.createBtn}
                  onClick={() => setStep('folder')}
                  disabled={!apiKey.trim()}
                >Далі</button>
              </div>
            </section>
          )}

          {step === 'folder' && (
            <section>
              <h3>Крок 2. Папка Google Drive</h3>
              <p className={notesStyles.editHint}>
                У Drive: правою кнопкою на потрібну папку → <b>Share</b> → "Anyone with the link" → <b>Viewer</b>.
                Скопіюй URL і встав сюди.
              </p>
              <input
                type="text"
                placeholder="https://drive.google.com/drive/folders/1AbCdEf..."
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
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('apiKey')}>Назад</button>
                <button
                  type="button"
                  className={styles.createBtn}
                  onClick={validateFolder}
                  disabled={!folderUrl.trim() || validating}
                >{validating ? 'Перевіряю...' : 'Перевірити доступ →'}</button>
              </div>
            </section>
          )}

          {step === 'account' && (
            <section>
              <h3>Крок 3. Куди імпортувати у Finmap</h3>
              <p className={notesStyles.editHint}>
                Папка: <b>{folderName}</b> · {files.length} файлів (precheck)
              </p>
              {accountsLoading ? (
                <div style={{ padding: 20, textAlign: 'center', color: '#888' }}>Завантажую рахунки...</div>
              ) : accounts.length === 0 ? (
                <div style={{ padding: 12, background: 'rgba(220,38,38,0.1)', borderRadius: 6, color: '#fca5a5', fontSize: 13 }}>
                  Не вдалось отримати список рахунків з Finmap. Перевір API-ключ сесії.
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
                          <div style={{ fontSize: 12, color: '#888' }}>{acc.balance.toLocaleString('uk-UA')} {acc.currencyId ?? ''}</div>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('folder')}>Назад</button>
                <button type="button" className={styles.createBtn} onClick={() => setStep('context')} disabled={!accountId}>Далі</button>
              </div>
            </section>
          )}

          {step === 'context' && (
            <section>
              <h3>Крок 4. Як обробляти файли</h3>
              <p className={notesStyles.editHint}>
                Вільним текстом опиши: яка категорія за замовчуванням, як визначати контрагента, тип операції тощо.
                Claude інтерпретує це при кожному новому файлі. Можна редагувати потім.
              </p>
              <textarea
                rows={8}
                value={contextPrompt}
                onChange={e => setContextPrompt(e.target.value)}
                placeholder={'Приклад:\n\nКатегорія: "Продаж послуг"\nКонтрагент: брати з назви файла після першого пробілу\nТип: дохід\n\nЯкщо файл .pdf — це банківська виписка, парсити як reconcile.\nЯкщо файл .xlsx — таблиця з продажами, кожен рядок = окрема операція.'}
                style={{ width: '100%', padding: 10, fontSize: 13, marginTop: 8, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, color: '#fff', fontFamily: 'inherit' }}
              />
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('account')}>Назад</button>
                <button type="button" className={styles.createBtn} onClick={() => setStep('interval')} disabled={!contextPrompt.trim()}>Далі</button>
              </div>
            </section>
          )}

          {step === 'interval' && (
            <section>
              <h3>Крок 5. Як часто перевіряти папку</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {INTERVAL_OPTIONS.map(opt => (
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
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('context')}>Назад</button>
                <button type="button" className={styles.createBtn} onClick={() => setStep('firstFile')}>Далі</button>
              </div>
            </section>
          )}

          {step === 'firstFile' && (
            <section>
              <h3>Крок 6. Останній файл у папці</h3>
              {latestFile ? (
                <>
                  <p className={notesStyles.editHint}>
                    Усі попередні файли в папці будуть пропущені (вважаються вже обробленими).
                    Що з найновішим?
                  </p>
                  <div style={{ padding: 12, background: '#1a1a1f', border: '1px solid #2a2a30', borderRadius: 6, marginTop: 8 }}>
                    <div style={{ fontWeight: 500 }}>📄 {latestFile.name}</div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                      {latestFile.modifiedTime && new Date(latestFile.modifiedTime).toLocaleString('uk-UA')}
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
                        <div style={{ fontWeight: 500 }}>Пропустити</div>
                        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>Чекаємо ТІЛЬКИ майбутні файли</div>
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
                        <div style={{ fontWeight: 500 }}>Імпортувати цей</div>
                        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>Перший автозапуск обробить його</div>
                      </div>
                    </label>
                  </div>
                </>
              ) : (
                <p className={notesStyles.editHint}>Папка порожня — нема що пропускати. Запис створиться з порожнім baseline.</p>
              )}
              {saveError && (
                <div style={{ marginTop: 12, padding: 10, background: 'rgba(220, 38, 38, 0.1)', borderRadius: 6, color: '#fca5a5', fontSize: 13 }}>
                  {saveError}
                </div>
              )}
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button type="button" className={styles.cancelBtn} onClick={() => setStep('interval')}>Назад</button>
                <button type="button" className={styles.createBtn} onClick={finish} disabled={saving}>{saving ? 'Зберігаю...' : 'Створити авто-імпорт'}</button>
              </div>
            </section>
          )}

          {step === 'done' && (
            <section style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
              <h3>Готово</h3>
              <p style={{ color: '#a1a1aa', fontSize: 14, maxWidth: 400, margin: '12px auto' }}>
                Папка <b>{folderName}</b> підʼєднана до рахунку <b>{accountName}</b>.
                Перевірка кожні {INTERVAL_OPTIONS.find(o => o.value === intervalMin)?.label}. Усе налаштування — у Settings.
              </p>
              <button type="button" className={styles.createBtn} onClick={onClose} style={{ marginTop: 12 }}>Закрити</button>
            </section>
          )}
        </div>
      </div>
    </div>
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
