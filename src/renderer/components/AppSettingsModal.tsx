import { useState, useEffect } from 'react';
import type { AppSettings, UiLanguage, ResponseLanguage } from '../../shared/types';
import { DEFAULT_UI_LANGUAGE } from '../../shared/types';
import { VOICE_LANGUAGES, DEFAULT_VOICE_LANGUAGE } from '../../shared/voice-presets';
import { useT } from '../i18n';
import styles from '../styles/NewSessionModal.module.css';
import sectionStyles from '../styles/SessionSettingsModal.module.css';
import own from '../styles/AppSettingsModal.module.css';

const api = (window as any).finmapAgent;

interface Props {
  settings: AppSettings;
  /** Whether this build ships a speech-recognition key. */
  voiceAvailable: boolean;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}

// Endonyms on purpose — a language picker names each language in itself.
const UI_LANGUAGES: { value: UiLanguage; label: string }[] = [
  { value: 'uk', label: 'Українська' }, // i18n-ok
  { value: 'en', label: 'English' },
];

/** App-wide settings (as opposed to per-company SessionSettingsModal):
 *  interface language, assistant reply language, voice recognition language.
 *  Voice provider, model and key are fixed in the build. */
export function AppSettingsModal({ settings, voiceAvailable, onClose, onSaved }: Props) {
  const { t } = useT();
  const [uiLanguage, setUiLanguage] = useState<UiLanguage>(settings.uiLanguage ?? DEFAULT_UI_LANGUAGE);
  const [responseLanguage, setResponseLanguage] = useState<ResponseLanguage>(settings.responseLanguage ?? 'auto');
  const [voiceLanguage, setVoiceLanguage] = useState(settings.voice?.language ?? DEFAULT_VOICE_LANGUAGE);
  const [saving, setSaving] = useState(false);

  // Escape closes, same as clicking the backdrop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const saved: AppSettings = await api.updateAppSettings({
        uiLanguage,
        responseLanguage,
        voice: { language: voiceLanguage },
      });
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={`${styles.modal} ${sectionStyles.wide}`} onClick={e => e.stopPropagation()}>
        <h2>{t('appSettings.title')}</h2>
        <form onSubmit={handleSubmit}>
          {/* ── Language ── */}
          <section className={own.section}>
            <div className={sectionStyles.sectionHead}>
              <span>{t('appSettings.langSection')}</span>
            </div>

            <div className={own.twoCol}>
              <div className={styles.field}>
                <span>{t('appSettings.uiLanguage')}</span>
                <div className={own.segmented} role="radiogroup">
                  {UI_LANGUAGES.map(l => (
                    <button
                      key={l.value}
                      type="button"
                      role="radio"
                      aria-checked={uiLanguage === l.value}
                      className={`${own.segBtn} ${uiLanguage === l.value ? own.segBtnActive : ''}`}
                      onClick={() => setUiLanguage(l.value)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
                <small className={styles.hint}>{t('appSettings.uiLanguageHint')}</small>
              </div>

              <label className={styles.field}>
                <span>{t('appSettings.responseLanguage')}</span>
                <select
                  className={own.select}
                  value={responseLanguage}
                  onChange={e => setResponseLanguage(e.target.value as ResponseLanguage)}
                >
                  <option value="auto">{t('appSettings.responseAuto')}</option>
                  <option value="uk">{t('appSettings.responseUk')}</option>
                  <option value="en">{t('appSettings.responseEn')}</option>
                </select>
                <small className={styles.hint}>{t('appSettings.responseHint')}</small>
              </label>
            </div>
          </section>

          {/* ── Voice input ── */}
          <section className={sectionStyles.section}>
            <div className={sectionStyles.sectionHead}>
              <span>{t('appSettings.voiceSection')}</span>
              {voiceAvailable
                ? <span className={own.okBadge}>{t('appSettings.enabled')}</span>
                : <span className={own.offBadge}>{t('appSettings.unavailable')}</span>}
            </div>

            <p className={own.intro}>
              {voiceAvailable ? t('appSettings.intro') : t('appSettings.unavailableHint')}
            </p>

            <label className={styles.field}>
              <span>{t('appSettings.voiceLanguage')}</span>
              <select
                className={own.select}
                value={voiceLanguage}
                onChange={e => setVoiceLanguage(e.target.value)}
                disabled={!voiceAvailable}
              >
                {VOICE_LANGUAGES.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
                <option value="">{t('appSettings.voiceLangAuto')}</option>
              </select>
              <small className={styles.hint}>{t('appSettings.voiceLanguageHint')}</small>
            </label>
          </section>

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>
              {t('appSettings.cancel')}
            </button>
            <button type="submit" className={styles.createBtn} disabled={saving}>
              {saving ? t('appSettings.saving') : t('appSettings.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
