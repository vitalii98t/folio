import { SessionStore } from './session-store';
import { AgentManager } from './agent-manager';
import type { Integration, ScheduledTask, ChatSession } from '../shared/types';

/**
 * Periodically triggers auto-sync for active integrations.
 * While the app is running, checks every minute if any integration
 * needs syncing based on its interval and last sync time.
 */
export class SyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = new Set<string>(); // integration IDs currently syncing
  private runningTasks = new Set<string>(); // task IDs currently running

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

  /** Run a task immediately by id. Used when a task is freshly created. */
  triggerTask(taskId: string) {
    const task = this.sessionStore.getAllTasks().find(t => t.id === taskId);
    if (!task || !task.enabled) return;
    if (this.runningTasks.has(task.id)) return;
    const session = this.sessionStore.get(task.sessionId);
    if (!session) return;
    this.runTask(session, task);
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
}

function truncate(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…[обрізано]';
}
