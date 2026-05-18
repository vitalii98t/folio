import { SessionStore } from './session-store';
import { AgentManager } from './agent-manager';
import type { Integration, ScheduledTask, ChatSession, FileImportBinding } from '../shared/types';

/**
 * Periodically triggers auto-sync for active integrations.
 * While the app is running, checks every minute if any integration
 * needs syncing based on its interval and last sync time.
 */
export class SyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = new Set<string>(); // integration IDs currently syncing
  private runningTasks = new Set<string>(); // task IDs currently running
  private runningBindings = new Set<string>(); // file-import binding IDs currently running

  constructor(
    private sessionStore: SessionStore,
    private agentManager: AgentManager,
    private onSyncStart?: (integration: Integration) => void,
    private onSyncDone?: (integration: Integration, result: string) => void,
    private onSyncError?: (integration: Integration, error: string) => void,
    private onTaskStart?: (task: ScheduledTask) => void,
    private onTaskDone?: (task: ScheduledTask, result: string) => void,
    private onTaskError?: (task: ScheduledTask, error: string) => void,
    private onTaskProgress?: (task: ScheduledTask, toolName: string) => void,
  ) {}

  start() {
    if (this.timer) return;
    // Check every 60 seconds
    this.timer = setInterval(() => this.tick(), 60_000);
    // Also run immediately
    this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a task immediately by id. Used when a task is freshly created, or
   *  when the user clicks "Run now" in the UI. */
  triggerTask(taskId: string) {
    const task = this.sessionStore.getAllTasks().find(t => t.id === taskId);
    if (!task || !task.enabled) return;
    if (this.runningTasks.has(task.id)) return;
    const session = this.sessionStore.get(task.sessionId);
    if (!session) return;
    this.runTask(session, task);
  }

  /** Run a file-import binding immediately. Same access pattern as triggerTask
   *  — manual button in the UI, or programmatic from elsewhere. */
  triggerBinding(bindingId: string) {
    const binding = this.sessionStore.getAllFileBindings().find(b => b.id === bindingId);
    if (!binding || !binding.enabled) return;
    if (this.runningBindings.has(binding.id)) return;
    const session = this.sessionStore.get(binding.sessionId);
    if (!session) return;
    this.runBinding(session, binding);
  }

  /** Cancel a currently running task by aborting its Claude invocation. */
  cancelTask(taskId: string) {
    const task = this.sessionStore.getAllTasks().find(t => t.id === taskId);
    if (!task || !this.runningTasks.has(task.id)) return;
    this.agentManager.cancel(task.sessionId);
  }

  private async tick() {
    const sessions = this.sessionStore.getAll();
    const now = Date.now();

    for (const session of sessions) {
      const integrations = this.sessionStore.getIntegrations(session.id);
      for (const integration of integrations) {
        if (!integration.enabled) continue;
        if (this.syncing.has(integration.id)) continue;
        const interval = (integration.syncIntervalMin || 30) * 60_000;
        const lastSync = integration.lastSync || 0;
        if (now - lastSync >= interval) {
          this.runSync(session, integration);
        }
      }

      const tasks = this.sessionStore.getTasks(session.id);
      for (const task of tasks) {
        if (!task.enabled) continue;
        if (this.runningTasks.has(task.id)) continue;
        const interval = (task.intervalMin || 30) * 60_000;
        const lastRun = task.lastRun || 0;
        if (now - lastRun >= interval) {
          this.runTask(session, task);
        }
      }

      const bindings = this.sessionStore.getFileBindings(session.id);
      for (const binding of bindings) {
        if (!binding.enabled) continue;
        if (this.runningBindings.has(binding.id)) continue;
        const interval = (binding.syncIntervalMin || 30) * 60_000;
        const lastSync = binding.lastSync || 0;
        if (now - lastSync >= interval) {
          this.runBinding(session, binding);
        }
      }
    }
  }

  private async runSync(session: ChatSession, integration: Integration) {
    this.syncing.add(integration.id);
    this.onSyncStart?.(integration);

    const syncPrompt = integration.syncPrompt
      || `Виконай автоматичну синхронізацію з ${integration.serviceName}. Завантаж нові транзакції та створи операції в Finmap на рахунку "${integration.finmapAccountName || integration.finmapAccountId}". Використовуй externalId для дедуплікації. Не питай підтвердження — це автоматичний синк.`;

    try {
      let result = '';

      await this.agentManager.sendMessage(
        session,
        syncPrompt,
        () => {}, // onChunk — silent
        () => {}, // onToolCall — silent
        (fullText) => { result = fullText; },
        (error) => { result = `Error: ${error}`; },
        undefined, // onToolPermission — silent
        true,      // forceAutoApprove — integrations must not block
      );

      // Update last sync time
      this.sessionStore.updateIntegration(integration.id, { lastSync: Date.now() });

      this.onSyncDone?.(integration, result);
    } catch (err: any) {
      this.onSyncError?.(integration, err.message ?? 'Unknown error');
    } finally {
      this.syncing.delete(integration.id);
    }
  }

  private async runTask(session: ChatSession, task: ScheduledTask) {
    this.runningTasks.add(task.id);
    this.onTaskStart?.(task);

    const prompt = `[Автозадача "${task.name}" — запущена за розкладом, не питай підтвердження для рутинних дій]\n\n${task.prompt}`;

    try {
      let result = '';
      await this.agentManager.sendMessage(
        session,
        prompt,
        () => {}, // onChunk — ignored for silent runs
        (toolName) => this.onTaskProgress?.(task, toolName),
        (fullText) => { result = fullText; },
        (error) => { result = `Error: ${error}`; },
        undefined, // onToolPermission — tasks never prompt
        true,      // forceAutoApprove — scheduled runs must not block on confirmation
      );
      const trimmed = truncate(result);
      const hasError = /^Error:/.test(result);
      this.sessionStore.updateTask(task.id, {
        lastRun: Date.now(),
        lastResult: trimmed,
        lastStatus: hasError ? 'error' : 'done',
      });
      if (hasError) {
        this.onTaskError?.(task, trimmed.replace(/^Error:\s*/, ''));
      } else {
        this.onTaskDone?.(task, trimmed);
      }
    } catch (err: any) {
      const msg = err.message ?? 'Unknown error';
      this.sessionStore.updateTask(task.id, {
        lastRun: Date.now(),
        lastResult: msg,
        lastStatus: 'error',
      });
      this.onTaskError?.(task, msg);
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Run one file-import binding. Hands Claude a structured prompt that:
   *  1. lists the folder via the bound MCP server
   *  2. diffs against processedFileIds (passed inline so Claude doesn't have
   *     to fetch from us)
   *  3. for each new file: parse → create_operation per contextPrompt
   *  4. calls mark_files_processed to update the dedup state
   *
   * Reuses the existing task-progress event channel for UI feedback —
   * frontend listens to `task-status` already; we surface bindings under the
   * same channel using the binding's id as taskId.
   */
  private async runBinding(session: ChatSession, binding: FileImportBinding) {
    this.runningBindings.add(binding.id);

    // Reuse task-status callbacks so the existing TaskToasts pipeline works
    // for bindings without any UI changes.
    const asTaskShim: ScheduledTask = {
      id: binding.id,
      sessionId: binding.sessionId,
      name: `📁 ${binding.sourceFolderName} → ${binding.finmapAccountName}`,
      prompt: '',
      intervalMin: binding.syncIntervalMin,
      enabled: binding.enabled,
    };
    this.onTaskStart?.(asTaskShim);

    const prompt =
      `[Авто-імпорт з папки — bindingId: ${binding.id}]\n\n` +
      `Папка у ${binding.sourceServerName}: "${binding.sourceFolderName}" (id: ${binding.sourceFolderId})\n` +
      `Цільовий рахунок Finmap: "${binding.finmapAccountName}" (id: ${binding.finmapAccountId})\n\n` +
      `КОНТЕКСТ ІМПОРТУ (як обробляти кожен файл):\n${binding.contextPrompt}\n\n` +
      `ВЖЕ ОБРОБЛЕНІ ФАЙЛИ (id) — НЕ імпортуй їх повторно:\n` +
      (binding.processedFileIds.length > 0
        ? binding.processedFileIds.join(', ')
        : '(порожній baseline — це перший запуск, обробляй усі)') +
      `\n\nЗАВДАННЯ:\n` +
      `1) Виклич інструмент списку файлів MCP-сервера "${binding.sourceServerName}" (наприклад mcp__${binding.sourceServerName}__list_files або search_files) для папки ${binding.sourceFolderId}.\n` +
      `2) Відфільтруй: бери ТІЛЬКИ файли, чий id НЕ в списку вже оброблених.\n` +
      `3) Якщо нових файлів немає — заверши коротким "немає нових файлів" і НЕ викликай mark_files_processed.\n` +
      `4) Для КОЖНОГО нового файлу:\n` +
      `   • Зчитай вміст файла відповідним інструментом (read_file / get_file / тощо).\n` +
      `   • Інтерпретуй за контекстом імпорту (вище). Створи в Finmap відповідні операції через create_operation з accountToId/accountFromId = ${binding.finmapAccountId}.\n` +
      `   • externalId операції = "fileimport_<file-id>" — для дедуплікації на рівні Finmap.\n` +
      `5) Після обробки всіх нових файлів виклич mcp__finmap__mark_files_processed({bindingId: "${binding.id}", fileIds: [<усі нові id, які щойно обробив>]}).\n` +
      `6) Поверни короткий підсумок: "Імпортовано N файлів, створено M операцій".\n\n` +
      `Не питай підтверджень — це автоматичний запуск без UI.`;

    try {
      let result = '';
      await this.agentManager.sendMessage(
        session,
        prompt,
        () => {},
        (toolName) => this.onTaskProgress?.(asTaskShim, toolName),
        (fullText) => { result = fullText; },
        (error) => { result = `Error: ${error}`; },
        undefined,
        true, // forceAutoApprove — background run
      );

      const trimmed = truncate(result);
      const hasError = /^Error:/.test(result);
      this.sessionStore.updateFileBinding(binding.id, {
        lastSync: Date.now(),
        lastResult: trimmed,
        lastStatus: hasError ? 'error' : 'done',
      });

      if (hasError) {
        this.onTaskError?.(asTaskShim, trimmed.replace(/^Error:\s*/, ''));
      } else {
        this.onTaskDone?.(asTaskShim, trimmed);
      }
    } catch (err: any) {
      const msg = err.message ?? 'Unknown error';
      this.sessionStore.updateFileBinding(binding.id, {
        lastSync: Date.now(),
        lastResult: msg,
        lastStatus: 'error',
      });
      this.onTaskError?.(asTaskShim, msg);
    } finally {
      this.runningBindings.delete(binding.id);
    }
  }
}

function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…[обрізано]';
}
