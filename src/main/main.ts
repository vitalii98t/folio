import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { checkClaudeCodeStatus, getClaudePath } from './claude-status';

/** Open the OS-native terminal window and run the given command in it. */
function openTerminalWithCommand(command: string) {
  if (process.platform === 'darwin') {
    // Terminal.app via osascript
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    spawn('osascript', [
      '-e', 'tell application "Terminal" to activate',
      '-e', `tell application "Terminal" to do script "${escaped}"`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    // On Win11 with Windows Terminal as default, `start "" path.bat` opens an
    // empty wt host without ever invoking cmd to run the .bat. The reliable
    // structure is `start "" cmd /k <bat>` — start opens the window, cmd /k
    // runs the bat and stays at a prompt. The .bat itself wraps the command
    // so we don't have to escape long quoted strings on the command line.
    const batPath = path.join(os.tmpdir(), `folio-launch-${Date.now()}.bat`);
    const batBody =
      `@echo off\r\nchcp 65001 >nul\r\n${command}\r\nset _ec=%ERRORLEVEL%\r\necho.\r\nif not "%_ec%"=="0" echo [Folio] Команда завершилась з кодом %_ec%.\r\necho [Folio] Готово. Можеш закривати вікно.\r\n`;
    fs.writeFileSync(batPath, batBody);
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', batPath], {
      detached: true, stdio: 'ignore', shell: false,
    }).unref();
  } else {
    // Linux — try common terminal emulators
    const terms: [string, string[]][] = [
      ['gnome-terminal', ['--', 'bash', '-c', `${command}; exec bash`]],
      ['konsole', ['-e', `bash -c "${command}; exec bash"`]],
      ['xfce4-terminal', ['-x', 'bash', '-c', `${command}; exec bash`]],
      ['xterm', ['-e', `bash -c "${command}; exec bash"`]],
    ];
    for (const [cmd, args] of terms) {
      try {
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
        return;
      } catch {}
    }
  }
}
import { SessionStore } from './session-store';
import { AgentManager } from './agent-manager';
import { SyncScheduler } from './sync-scheduler';
import { setupAutoUpdater } from './updater';
import { listClaudeModels } from './claude-models';
import { installBundledSkills } from './skills-installer';
import { setupBundledBinariesPath } from './bundled-binaries';
import { parseFileToText } from './file-parser';
import { IPC } from '../shared/types';
import type { ChatSession, Integration, ScheduledTask, McpServerConfig, FileImportBinding } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
const sessionStore = new SessionStore();
const agentManager = new AgentManager(sessionStore);
const syncScheduler = new SyncScheduler(
  sessionStore,
  agentManager,
  (integration) => {
    console.log(`[Sync] Starting: ${integration.serviceName}`);
    mainWindow?.webContents.send('sync-status', integration.id, 'syncing');
  },
  (integration, result) => {
    console.log(`[Sync] Done: ${integration.serviceName}`);
    mainWindow?.webContents.send('sync-status', integration.id, 'done', result);
  },
  (integration, error) => {
    console.error(`[Sync] Error: ${integration.serviceName}:`, error);
    mainWindow?.webContents.send('sync-status', integration.id, 'error', error);
  },
  (task, kind) => {
    console.log(`[Task] Starting: ${task.name}`);
    mainWindow?.webContents.send(IPC.TASK_STATUS, {
      taskId: task.id, sessionId: task.sessionId, taskName: task.name, kind: kind ?? 'task', status: 'start',
    });
  },
  (task, result, kind) => {
    console.log(`[Task] Done: ${task.name}`);
    mainWindow?.webContents.send(IPC.TASK_STATUS, {
      taskId: task.id, sessionId: task.sessionId, taskName: task.name, kind: kind ?? 'task', status: 'done', result,
    });
  },
  (task, error, kind) => {
    console.error(`[Task] Error: ${task.name}:`, error);
    mainWindow?.webContents.send(IPC.TASK_STATUS, {
      taskId: task.id, sessionId: task.sessionId, taskName: task.name, kind: kind ?? 'task', status: 'error', result: error,
    });
  },
  (task, toolName, kind) => {
    mainWindow?.webContents.send(IPC.TASK_STATUS, {
      taskId: task.id, sessionId: task.sessionId, taskName: task.name, kind: kind ?? 'task', status: 'progress', currentTool: toolName,
    });
  },
);

async function createWindow() {
  // Icon lives at <repo>/build/icon.png — two levels up from dist/main/main.js at dev time,
  // and in the asar root under "build/" at dist time.
  const iconCandidates = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.png'),
  ];
  const iconPath = iconCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 480,
    minHeight: 600,
    // Custom title bar — hides native chrome but keeps OS window controls as an overlay
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0e',
      symbolColor: '#a1a1aa',
      height: 38,
    },
    backgroundColor: '#05050a',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Try Vite dev server first, fall back to built files
  const devUrl = 'http://localhost:5173';
  let useDev = false;
  try {
    const res = await fetch(devUrl);
    useDev = res.ok;
  } catch {}

  if (useDev) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // External links must open in the user's default browser, not hijack the
  // app window. Two handlers cover both ways a link can fire:
  //   • target="_blank" / window.open()  → setWindowOpenHandler
  //   • plain <a href> click             → will-navigate
  // We let local (dev-server + file://) URLs through so the renderer can
  // do its own routing without us blocking it.
  const isInternalUrl = (url: string) =>
    url.startsWith(devUrl) || url.startsWith('file://') || url === 'about:blank';

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ──────────────────────────────────────────────

function setupIPC() {
  // App version — single source of truth is package.json `version`, read via
  // app.getVersion(). Renderer shows it in the sidebar; after an auto-update
  // it reflects the new build automatically (no hardcoded string to bump).
  ipcMain.handle(IPC.GET_APP_VERSION, async () => {
    return app.getVersion();
  });

  // Model picker options. Asks the installed Claude Code which models the
  // user's plan actually offers instead of shipping a list that goes stale.
  ipcMain.handle(IPC.LIST_CLAUDE_MODELS, async () => {
    return listClaudeModels(agentManager.getWorkspaceCwd());
  });

  // Claude Code status check
  ipcMain.handle(IPC.CHECK_CLAUDE_STATUS, async () => {
    return checkClaudeCodeStatus();
  });

  // Full logout from Claude Code — used when an account was blocked/revoked
  // and the cached credentials block any further work. Two cleanups happen
  // together: (1) `claude logout` invalidates the CLI's stored token; (2) we
  // wipe Folio's per-session `claudeSessionId` because those session ids
  // belong to the now-invalid account and resume would fail on first message.
  ipcMain.handle(IPC.CLAUDE_LOGOUT, async () => {
    const claudePath = getClaudePath();
    if (!claudePath) return { ok: false, error: 'Claude Code не знайдено на цій машині.' };

    const { execSync } = await import('child_process');
    try {
      execSync(`"${claudePath}" logout`, { stdio: 'pipe', timeout: 10_000, encoding: 'utf-8' });
    } catch (err: any) {
      // `claude logout` returns non-zero if already logged out — that's
      // success for our purposes (target state achieved).
      const msg = err?.message ?? '';
      if (!/not logged in|already|no credentials/i.test(msg)) {
        // Real failure — surface it
        return { ok: false, error: msg || 'Не вдалося виконати logout.' };
      }
    }

    sessionStore.resetAllClaudeSessions();
    // Drop in-memory AgentManager state too — fresh login should not reuse
    // the now-orphaned `ActiveSession.claudeSessionId` cache.
    for (const s of sessionStore.getAll()) {
      agentManager.resetClaudeSession(s.id);
    }

    return { ok: true };
  });

  ipcMain.handle(IPC.OPEN_CLAUDE_LOGIN, async () => {
    // After a fresh install, `claude` may not be on PATH yet (Windows needs
    // a terminal restart to pick up PATH changes). Use the resolved binary
    // path so the new terminal can invoke it directly. Running claude with
    // no args triggers its interactive login flow when credentials are missing.
    const claudePath = getClaudePath();
    const cmd = claudePath ? `"${claudePath}"` : 'claude';
    openTerminalWithCommand(cmd);
  });

  ipcMain.handle(IPC.INSTALL_CLAUDE_CODE, async () => {
    if (process.platform === 'win32') {
      // Multi-line script — easier to follow in the terminal than one mega &&-chain,
      // and lets us bail out early with a clear message if curl fails.
      const cmds = [
        'echo [Folio] Завантажую інсталятор Claude Code...',
        'curl -fsSL https://claude.ai/install.cmd -o "%TEMP%\\claude-install.cmd"',
        'if errorlevel 1 (echo [Folio] Не вдалося завантажити інсталятор. Перевір підключення до інтернету. && goto :end)',
        'echo [Folio] Запускаю інсталятор...',
        'call "%TEMP%\\claude-install.cmd"',
        'del "%TEMP%\\claude-install.cmd" 2>nul',
        ':end',
      ].join('\r\n');
      openTerminalWithCommand(cmds);
    } else {
      openTerminalWithCommand('curl -fsSL https://claude.ai/install.sh | sh');
    }
  });

  // Sessions
  ipcMain.handle(IPC.GET_SESSIONS, async () => {
    return sessionStore.getAll();
  });

  ipcMain.handle(IPC.CREATE_SESSION, async (_event, session: Omit<ChatSession, 'id' | 'createdAt'>) => {
    return sessionStore.create(session);
  });

  ipcMain.handle(IPC.DELETE_SESSION, async (_event, id: string) => {
    agentManager.removeSession(id);
    return sessionStore.delete(id);
  });

  ipcMain.handle(IPC.UPDATE_SESSION, async (_event, id: string, updates: Partial<ChatSession>) => {
    return sessionStore.update(id, updates);
  });

  // Messages persistence
  ipcMain.handle(IPC.GET_MESSAGES, async (_event, sessionId: string) => {
    return sessionStore.getMessages(sessionId);
  });

  ipcMain.handle(IPC.ADD_MESSAGE, async (_event, sessionId: string, message: any) => {
    sessionStore.addMessage(sessionId, message);
  });

  ipcMain.handle(IPC.CLEAR_MESSAGES, async (_event, sessionId: string) => {
    sessionStore.clearMessages(sessionId);
  });

  ipcMain.handle(IPC.SEARCH_MESSAGES, async (_event, query: string) => {
    return sessionStore.searchMessages(query);
  });

  // Start a new Claude chat (clear both messages and claudeSessionId)
  ipcMain.handle(IPC.NEW_CHAT, async (_event, sessionId: string) => {
    sessionStore.clearMessages(sessionId);
    agentManager.resetClaudeSession(sessionId);
  });

  ipcMain.handle(IPC.SET_AUTO_APPROVE, async (_event, sessionId: string, enabled: boolean) => {
    agentManager.setAutoApprove(sessionId, enabled);
  });

  ipcMain.handle(IPC.GET_AUTO_APPROVE, async (_event, sessionId: string) => {
    return agentManager.getAutoApprove(sessionId);
  });

  ipcMain.handle(IPC.GET_CLAUDE_SESSION_ID, async (_event, sessionId: string) => {
    return agentManager.getClaudeSessionId(sessionId);
  });

  // Chat messages
  ipcMain.on(IPC.SEND_MESSAGE, async (event, sessionId: string, message: string) => {
    const session = sessionStore.get(sessionId);
    if (!session) {
      event.reply(IPC.STREAM_ERROR, sessionId, 'Session not found');
      return;
    }

    try {
      await agentManager.sendMessage(
        session,
        message,
        (text: string) => event.reply(IPC.STREAM_CHUNK, sessionId, text),
        (toolName: string, input: Record<string, unknown>) =>
          event.reply(IPC.STREAM_TOOL_CALL, sessionId, toolName, input),
        (fullText: string) => event.reply(IPC.STREAM_DONE, sessionId, fullText),
        (error: string) => event.reply(IPC.STREAM_ERROR, sessionId, error),
        (toolName: string, input: Record<string, unknown>) =>
          event.reply(IPC.STREAM_TOOL_PERMISSION, sessionId, toolName, input),
        undefined,
        (authMsg: string) => event.reply(IPC.STREAM_AUTH_ERROR, sessionId, authMsg),
      );
    } catch (err: any) {
      event.reply(IPC.STREAM_ERROR, sessionId, err.message ?? 'Unknown error');
    }
  });

  ipcMain.on(IPC.CANCEL_MESSAGE, (_event, sessionId: string) => {
    agentManager.cancel(sessionId);
  });

  ipcMain.handle(IPC.CONFIRM_MUTATION, async (_event, sessionId: string) => {
    return agentManager.confirmMutation(sessionId);
  });

  ipcMain.handle(IPC.REJECT_MUTATION, async (_event, sessionId: string) => {
    return agentManager.rejectMutation(sessionId);
  });

  // File picker
  ipcMain.handle(IPC.SELECT_FILES, async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All supported', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf', 'txt', 'csv', 'json', 'xml', 'xlsx', 'xls', 'docx', 'doc', 'md', 'log', 'tsv'] },
        { name: 'Documents', extensions: ['pdf', 'txt', 'csv', 'json', 'xml', 'xlsx', 'xls', 'docx', 'doc', 'md', 'log', 'tsv'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];

    return result.filePaths.map(filePath => {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
      let dataUrl: string | undefined;
      if (isImage && stat.size < 10 * 1024 * 1024) {
        const buf = fs.readFileSync(filePath);
        const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      }
      return {
        name: path.basename(filePath),
        path: filePath,
        type: isImage ? 'image' : 'document',
        size: stat.size,
        dataUrl,
      };
    });
  });

  // Chat with file attachments
  ipcMain.on(IPC.SEND_MESSAGE_WITH_FILES, async (event, sessionId: string, message: string, filePaths: string[]) => {
    const session = sessionStore.get(sessionId);
    if (!session) {
      event.reply(IPC.STREAM_ERROR, sessionId, 'Session not found');
      return;
    }

    // Build prompt with file references — parse Excel/PDF/CSV/etc properly
    let prompt = message;
    if (filePaths.length > 0) {
      const fileDescriptions = await Promise.all(filePaths.map(async (fp) => {
        const ext = path.extname(fp).toLowerCase();
        const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
        if (isImage) {
          return `[Image: ${path.basename(fp)}] (path: ${fp})`;
        }
        const parsed = await parseFileToText(fp);
        return parsed ?? `[File: ${path.basename(fp)}] (could not parse)`;
      }));
      prompt = `${message}\n\n${fileDescriptions.join('\n\n')}`;
    }

    try {
      await agentManager.sendMessage(
        session, prompt,
        (text: string) => event.reply(IPC.STREAM_CHUNK, sessionId, text),
        (toolName: string, input: Record<string, unknown>) => event.reply(IPC.STREAM_TOOL_CALL, sessionId, toolName, input),
        (fullText: string) => event.reply(IPC.STREAM_DONE, sessionId, fullText),
        (error: string) => event.reply(IPC.STREAM_ERROR, sessionId, error),
        (toolName: string, input: Record<string, unknown>) =>
          event.reply(IPC.STREAM_TOOL_PERMISSION, sessionId, toolName, input),
        undefined,
        (authMsg: string) => event.reply(IPC.STREAM_AUTH_ERROR, sessionId, authMsg),
      );
    } catch (err: any) {
      event.reply(IPC.STREAM_ERROR, sessionId, err.message ?? 'Unknown error');
    }
  });

  // Integrations
  ipcMain.handle(IPC.GET_INTEGRATIONS, async (_event, sessionId: string) => {
    return sessionStore.getIntegrations(sessionId);
  });

  ipcMain.handle(IPC.CREATE_INTEGRATION, async (_event, integration: Omit<Integration, 'id'>) => {
    return sessionStore.createIntegration(integration);
  });

  ipcMain.handle(IPC.UPDATE_INTEGRATION, async (_event, id: string, updates: Partial<Integration>) => {
    return sessionStore.updateIntegration(id, updates);
  });

  ipcMain.handle(IPC.DELETE_INTEGRATION, async (_event, id: string) => {
    return sessionStore.deleteIntegration(id);
  });

  ipcMain.handle(IPC.TOGGLE_INTEGRATION, async (_event, id: string) => {
    return sessionStore.toggleIntegration(id);
  });

  // Scheduled tasks
  ipcMain.handle(IPC.GET_TASKS, async (_event, sessionId: string) => {
    return sessionStore.getTasks(sessionId);
  });
  ipcMain.handle(IPC.CREATE_TASK, async (_event, task: Omit<ScheduledTask, 'id'>) => {
    const created = sessionStore.createTask(task);
    // Fire first run immediately without waiting for the next 60s tick
    syncScheduler.triggerTask(created.id);
    return created;
  });
  ipcMain.handle(IPC.UPDATE_TASK, async (_event, id: string, updates: Partial<ScheduledTask>) => {
    return sessionStore.updateTask(id, updates);
  });
  ipcMain.handle(IPC.DELETE_TASK, async (_event, id: string) => {
    return sessionStore.deleteTask(id);
  });
  ipcMain.handle(IPC.TOGGLE_TASK, async (_event, id: string) => {
    return sessionStore.toggleTask(id);
  });
  ipcMain.handle(IPC.CANCEL_TASK, async (_event, id: string) => {
    syncScheduler.cancelTask(id);
  });

  // User-configured MCP servers
  ipcMain.handle(IPC.GET_MCP_SERVERS, async (_event, sessionId: string) => {
    return sessionStore.getMcpServers(sessionId);
  });
  ipcMain.handle(IPC.CREATE_MCP_SERVER, async (_event, cfg: Omit<McpServerConfig, 'id'>) => {
    return sessionStore.createMcpServer(cfg);
  });
  ipcMain.handle(IPC.UPDATE_MCP_SERVER, async (_event, id: string, updates: Partial<McpServerConfig>) => {
    return sessionStore.updateMcpServer(id, updates);
  });
  ipcMain.handle(IPC.DELETE_MCP_SERVER, async (_event, id: string) => {
    return sessionStore.deleteMcpServer(id);
  });
  ipcMain.handle(IPC.TOGGLE_MCP_SERVER, async (_event, id: string) => {
    return sessionStore.toggleMcpServer(id);
  });

  // File import bindings (folder → Finmap account auto-sync)
  ipcMain.handle(IPC.GET_FILE_BINDINGS, async (_event, sessionId: string) => {
    return sessionStore.getFileBindings(sessionId);
  });
  ipcMain.handle(IPC.CREATE_FILE_BINDING, async (_event, cfg: Omit<FileImportBinding, 'id'>) => {
    return sessionStore.createFileBinding(cfg);
  });
  ipcMain.handle(IPC.UPDATE_FILE_BINDING, async (_event, id: string, updates: Partial<FileImportBinding>) => {
    return sessionStore.updateFileBinding(id, updates);
  });
  ipcMain.handle(IPC.DELETE_FILE_BINDING, async (_event, id: string) => {
    return sessionStore.deleteFileBinding(id);
  });
  ipcMain.handle(IPC.TOGGLE_FILE_BINDING, async (_event, id: string) => {
    return sessionStore.toggleFileBinding(id);
  });
  ipcMain.handle(IPC.TRIGGER_FILE_BINDING, async (_event, id: string) => {
    syncScheduler.triggerBinding(id);
  });
  ipcMain.handle(IPC.CANCEL_FILE_BINDING, async (_event, id: string) => {
    syncScheduler.cancelBinding(id);
  });

  // Manual trigger for an already-scheduled task — runs it immediately
  // regardless of the scheduler tick. Useful for testing or "run now".
  ipcMain.handle(IPC.TRIGGER_TASK, async (_event, id: string) => {
    syncScheduler.triggerTask(id);
  });

  // Google Drive direct — used by the FolderImportWizard UI to validate a
  // folder URL and inspect contents before creating a binding.
  ipcMain.handle(IPC.GDRIVE_VALIDATE, async (_event, payload: { apiKey: string; folderUrl: string }) => {
    const { GDriveClient } = await import('./gdrive-client');
    const folderId = GDriveClient.parseFolderUrl(payload.folderUrl);
    if (!folderId) return { ok: false, error: 'Не вдалося розпізнати ID папки з URL.' };
    try {
      const client = new GDriveClient(payload.apiKey);
      const meta = await client.getFolderMetadata(folderId);
      const files = await client.listFiles(folderId, { pageSize: 10 });
      return { ok: true, folderId, folder: meta, sampleFiles: files };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Drive request failed' };
    }
  });
  ipcMain.handle(IPC.GDRIVE_LIST_FILES, async (_event, payload: { apiKey: string; folderId: string }) => {
    const { GDriveClient } = await import('./gdrive-client');
    try {
      const files = await new GDriveClient(payload.apiKey).listFiles(payload.folderId, { pageSize: 1000 });
      return { ok: true, files };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Drive request failed' };
    }
  });

  // Used by the FolderImportWizard to populate the "where to import" picker.
  // Takes a Finmap apiKey from the session so renderer doesn't need to keep
  // it around — main creates a fresh FinmapAPI client per call.
  ipcMain.handle(IPC.GET_FINMAP_ACCOUNTS, async (_event, finmapApiKey: string) => {
    const { FinmapAPI } = await import('./finmap-api');
    try {
      const list = await new FinmapAPI(finmapApiKey).getAccounts(true);
      return list.map((a: any) => ({
        id: a.id,
        label: a.label,
        currencyId: a.currencyId,
        balance: a.balance,
      }));
    } catch {
      return [];
    }
  });
}

// ── App lifecycle ─────────────────────────────────────────────

/** Copy data from the legacy `vital-ai/` userData folder into the new `folio/`
 *  one on first launch after the rename. Safe to call multiple times — only acts
 *  if new file is missing AND old file exists. */
function migrateLegacyData() {
  try {
    const newDir = app.getPath('userData');
    const newFile = path.join(newDir, 'finmap-agent-data.json');
    if (fs.existsSync(newFile)) return;
    const legacyDir = path.join(path.dirname(newDir), 'vital-ai');
    const legacyFile = path.join(legacyDir, 'finmap-agent-data.json');
    if (!fs.existsSync(legacyFile)) return;
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(legacyFile, newFile);
    console.log(`[Migration] Copied data from ${legacyDir} to ${newDir}`);
  } catch (err) {
    console.error('[Migration] Failed:', err);
  }
}

app.whenReady().then(() => {
  migrateLegacyData();

  // MUST be before AgentManager spawns anything — child processes inherit
  // PATH at spawn time, so prepending bundled `uv`/`uvx` first ensures
  // Python-based MCP servers find them.
  setupBundledBinariesPath();

  // Install bundled skills into a stable workspace dir, then point the agent
  // at it as cwd — Claude Code auto-discovers `.claude/skills/` from cwd.
  const { cwd: workspaceCwd, installed } = installBundledSkills();
  agentManager.setWorkspaceCwd(workspaceCwd);
  console.log(`[Folio] Workspace ready at ${workspaceCwd} (${installed} skill(s))`);

  // Warm the model list in the background — the CLI spawn takes a few seconds
  // and we'd rather pay it here than when the user opens session settings.
  setTimeout(() => { listClaudeModels(workspaceCwd).catch(() => {}); }, 20_000);

  setupIPC();
  createWindow();

  // Background download of new releases from GitHub; banner in renderer
  // when ready. No-op in dev and on macOS (unsigned build).
  setupAutoUpdater(() => mainWindow);

  // Start auto-sync scheduler for integrations
  syncScheduler.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  syncScheduler.stop();
  if (process.platform !== 'darwin') app.quit();
});
