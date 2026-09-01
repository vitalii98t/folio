import { app, ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../shared/types';
import type { UpdateStatusEvent } from '../shared/types';

/**
 * Auto-update via electron-updater + GitHub Releases.
 *
 * How it works: electron-builder (with `publish: github` in package.json)
 * generates `latest.yml` / `latest-mac.yml` / `latest-linux.yml` next to the
 * installers in each GitHub Release. electron-updater reads that file from the
 * latest release, compares versions, downloads the new installer in the
 * background and emits `update-downloaded`. We surface a banner in the
 * renderer; the user clicks "Перезапустити" → quitAndInstall().
 *
 * Platform notes:
 *  • Windows (NSIS) — fully supported.
 *  • Linux (AppImage) — supported.
 *  • macOS — requires a signed app for quitAndInstall; Folio ships unsigned
 *    (identity: null), so updates are disabled there. Mac users download
 *    new .dmg manually, as before.
 */
export function setupAutoUpdater(getWindow: () => BrowserWindow | null) {
  // Dev runs have no app-update.yml and would just spam errors.
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') return;

  let autoUpdater: typeof import('electron-updater').autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err) {
    console.error('[Updater] electron-updater not available:', err);
    return;
  }

  const send = (event: UpdateStatusEvent) => {
    getWindow()?.webContents.send(IPC.UPDATE_STATUS, event);
  };

  autoUpdater.autoDownload = true;
  // Install on quit too, so even if user ignores the banner they get the
  // update on next restart.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => send({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => send({ status: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update ${info.version} downloaded`);
    send({ status: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // Network failures are routine (offline laptop) — log, don't bother user.
    console.error('[Updater] Error:', err?.message ?? err);
    send({ status: 'error', error: err?.message ?? String(err) });
  });

  ipcMain.handle(IPC.INSTALL_UPDATE, () => {
    autoUpdater.quitAndInstall();
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  // First check shortly after startup (let the window load first), then
  // every 4 hours for long-running instances.
  setTimeout(check, 15_000);
  setInterval(check, 4 * 60 * 60_000);
}
