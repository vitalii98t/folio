import { FinmapAPI } from './finmap-api';
import { buildFinmapMcpServer, MUTATION_TOOLS } from './mcp-tools';
import { SYSTEM_PROMPT, BACKGROUND_SYSTEM_PROMPT, MCP_ONLY_SYSTEM_PROMPT } from './system-prompt';
import { getClaudePath, isAuthError } from './claude-status';
import type { SessionStore } from './session-store';
import type { ChatSession } from '../shared/types';

let _sdk: typeof import('@anthropic-ai/claude-code') | null = null;
async function getSDK() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-code');
  return _sdk;
}

type PermissionResult = import('@anthropic-ai/claude-code').PermissionResult;

/** One mutation awaiting user confirmation. Multiple can be pending at once
 *  (Claude may call several tools in parallel) — they queue FIFO. */
interface PendingConfirm {
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  /** Auto-deny timer so an unanswered confirmation can't hang the run forever
   *  (e.g. UI crashed mid-confirmation). */
  timer: ReturnType<typeof setTimeout>;
}

/** How long a confirmation may sit unanswered before we auto-deny it. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;

interface ActiveSession {
  api: FinmapAPI;
  mcpServer: Awaited<ReturnType<typeof buildFinmapMcpServer>> | null;
  claudeSessionId: string | null;
  abortController: AbortController | null;
  /** FIFO queue of mutations awaiting user confirmation */
  pendingConfirms: PendingConfirm[];
  /** When true — auto-approve all mutations without asking user */
  autoApprove: boolean;
}

// Read-only tools — SDK auto-approves these via --allowedTools flag (canUseTool skipped).
// Mutations are intentionally NOT listed here, so canUseTool fires and we can prompt the user.
const ALLOWED_TOOLS = [
  // Built-in Claude Code tools needed for skill discovery & loading.
  // `Read` lets Claude pull SKILL.md and supporting reference files when a
  // task matches a skill's description. `Glob` lets it list available skills.
  'Read',
  'Glob',

  // Web access — used by `mcp-setup` skill to search for and read MCP server
  // documentation when user asks to connect a new service (Telegram, Figma,
  // Google Drive etc.). Read-only, safe to auto-approve.
  'WebFetch',
  'WebSearch',

  // Finmap MCP tools (read-only)
  'mcp__finmap__http_request',
  'mcp__finmap__get_accounts',
  'mcp__finmap__get_currencies',
  'mcp__finmap__get_exchange_rates',
  'mcp__finmap__get_categories',
  'mcp__finmap__get_tags',
  'mcp__finmap__get_projects',
  'mcp__finmap__get_counterparties',
  'mcp__finmap__get_operations',
  'mcp__finmap__get_operation_details',
  'mcp__finmap__check_externalIds',
  'mcp__finmap__get_invoices',
  'mcp__finmap__get_invoice_details',
  'mcp__finmap__get_invoice_goods',
  'mcp__finmap__get_invoice_companies',
  'mcp__finmap__get_webhooks',
  'mcp__finmap__list_integrations',
  'mcp__finmap__toggle_integration',

  // Pure computation — deterministic matcher used by reconcile-statement skill.
  // Read-only; no API side effects.
  'mcp__finmap__reconcile_match',

  // MCP self-management. `list_mcp_servers` is read-only and auto-approves;
  // add/update/remove are in MUTATION_TOOLS and route through user confirmation.
  'mcp__finmap__list_mcp_servers',
  'mcp__finmap__add_mcp_server',
  'mcp__finmap__update_mcp_server',
  'mcp__finmap__remove_mcp_server',
  // Saves user-pasted service account JSON to userData/credentials. Local
  // file-write only, no network — auto-approve so the wizard flow stays
  // smooth. add_mcp_server (which actually wires up the credentials) is
  // still a mutation and confirms.
  'mcp__finmap__save_service_account_key',

  // File import bindings. Same pattern: list/mark are auto-approved (read +
  // pure state bookkeeping), create/update/delete confirm via UI.
  'mcp__finmap__list_file_bindings',
  'mcp__finmap__create_file_binding',
  'mcp__finmap__update_file_binding',
  'mcp__finmap__delete_file_binding',
  'mcp__finmap__mark_files_processed',

  // Google Drive direct (via session API key) — read-only public-folder access.
  'mcp__finmap__gdrive_list_files',
  'mcp__finmap__gdrive_get_file_content',

  // Scheduled-task management. list_scheduled_tasks is read-only; mutations
  // route through user confirmation (they configure recurring background jobs).
  'mcp__finmap__list_scheduled_tasks',
  'mcp__finmap__create_scheduled_task',
  'mcp__finmap__update_scheduled_task',
  'mcp__finmap__delete_scheduled_task',
];

/**
 * Manages Claude Agent SDK sessions with conversation history via resume.
 */
export class AgentManager {
  private sessions = new Map<string, ActiveSession>();
  private sessionStore: SessionStore;
  /**
   * Working directory we hand to the Claude Agent SDK. Set by main on startup
   * to a workspace dir that contains `.claude/skills/` so Claude Code can
   * auto-discover Folio's bundled skills. Defaults to process.cwd() until set.
   */
  private workspaceCwd: string = process.cwd();

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  setWorkspaceCwd(cwd: string) {
    this.workspaceCwd = cwd;
  }

  getWorkspaceCwd(): string {
    return this.workspaceCwd;
  }

  private getOrCreate(session: ChatSession): ActiveSession {
    let active = this.sessions.get(session.id);
    if (!active) {
      active = {
        api: new FinmapAPI(session.apiKey),
        mcpServer: null,
        claudeSessionId: session.claudeSessionId || null,
        abortController: null,
        pendingConfirms: [],
        autoApprove: false,
      };
      this.sessions.set(session.id, active);
    }
    return active;
  }

  setAutoApprove(sessionId: string, enabled: boolean) {
    const active = this.sessions.get(sessionId);
    if (active) active.autoApprove = enabled;
  }

  getAutoApprove(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.autoApprove ?? false;
  }

  /** Get current Claude session ID for a Finmap session (for debugging) */
  getClaudeSessionId(sessionId: string): string | null {
    const active = this.sessions.get(sessionId);
    if (active?.claudeSessionId) return active.claudeSessionId;
    // Fallback to persisted value
    const session = this.sessionStore.get(sessionId);
    return session?.claudeSessionId ?? null;
  }

  removeSession(id: string) {
    const active = this.sessions.get(id);
    if (active?.abortController) active.abortController.abort();
    this.sessions.delete(id);
  }

  /** Start a fresh Claude conversation — clears session_id so next message creates new chat */
  resetClaudeSession(sessionId: string) {
    const active = this.sessions.get(sessionId);
    if (active) {
      if (active.abortController) active.abortController.abort();
      active.claudeSessionId = null;
    }
    this.sessionStore.update(sessionId, { claudeSessionId: undefined });
  }

  cancel(sessionId: string) {
    const active = this.sessions.get(sessionId);
    if (active?.abortController) {
      active.abortController.abort();
      active.abortController = null;
    }
  }

  /** Confirm the OLDEST pending mutation (FIFO — matches the order the UI
   *  shows them in). Returns false if nothing was pending. */
  async confirmMutation(sessionId: string): Promise<boolean> {
    const active = this.sessions.get(sessionId);
    const pending = active?.pendingConfirms.shift();
    if (pending) {
      clearTimeout(pending.timer);
      // Use original input — passing {} would execute tool with empty data!
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
      return true;
    }
    return false;
  }

  async rejectMutation(sessionId: string): Promise<boolean> {
    const active = this.sessions.get(sessionId);
    const pending = active?.pendingConfirms.shift();
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message: 'User rejected this action.' });
      return true;
    }
    return false;
  }

  async sendMessage(
    session: ChatSession,
    userMessage: string,
    onChunk: (text: string) => void,
    onToolCall: (toolName: string, input: Record<string, unknown>) => void,
    onDone: (fullText: string) => void,
    onError: (error: string) => void,
    onToolPermission?: (toolName: string, input: Record<string, unknown>) => void,
    /** Force auto-approve of all mutations regardless of session toggle.
     *  Used for scheduled tasks which have no UI to confirm. */
    forceAutoApprove?: boolean,
    /** Called when Claude SDK reports an auth/expired-token error so the UI
     *  can prompt the user to re-login without losing chat context. */
    onAuthError?: (message: string) => void,
  ) {
    const active = this.getOrCreate(session);
    const abortController = new AbortController();
    active.abortController = abortController;

    if (!active.mcpServer) {
      active.mcpServer = await buildFinmapMcpServer(active.api, this.sessionStore, session.id);
    }

    // Resolve user-configured MCP servers for this session. Each enabled one
    // is passed to Claude Agent SDK as a stdio child-process spec — SDK spawns
    // it, manages its lifecycle, and exposes its tools as mcp__<name>__<tool>.
    const userMcpConfigs = this.sessionStore.getMcpServers(session.id).filter(s => s.enabled);
    const userMcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const cfg of userMcpConfigs) {
      userMcpServers[cfg.name] = {
        type: 'stdio',
        command: cfg.command,
        args: cfg.args,
        ...(cfg.env && Object.keys(cfg.env).length > 0 ? { env: cfg.env } : {}),
      };
    }
    // Fast lookup: tool prefix → autoApproveAll flag
    const autoApproveByPrefix = new Map<string, boolean>();
    for (const cfg of userMcpConfigs) {
      autoApproveByPrefix.set(`mcp__${cfg.name}__`, cfg.autoApproveAll);
    }

    try {
      const sdk = await getSDK();
      let fullResponse = '';

      const canUseTool: import('@anthropic-ai/claude-code').CanUseTool = async (toolName, input, { signal }) => {
        // Session-wide auto-approve OR background run → allow everything.
        if (active.autoApprove || forceAutoApprove) {
          return { behavior: 'allow', updatedInput: input };
        }

        // Folio's own Finmap tools — known mutation list, ask only on writes.
        if (toolName.startsWith('mcp__finmap__')) {
          if (!MUTATION_TOOLS.has(toolName)) {
            return { behavior: 'allow', updatedInput: input };
          }
          // Fall through to user-confirmation flow below.
        } else {
          // User-configured MCP tool — auto-approve if that server allows;
          // otherwise route through confirmation.
          let matched = false;
          for (const [prefix, autoOk] of autoApproveByPrefix) {
            if (toolName.startsWith(prefix)) {
              matched = true;
              if (autoOk) return { behavior: 'allow', updatedInput: input };
              break;
            }
          }
          // Tool name doesn't match any known prefix — unknown source, be
          // permissive (Claude Code built-ins like Read/Glob already on
          // allowedTools, but anything else falls through here).
          if (!matched) {
            return { behavior: 'allow', updatedInput: input };
          }
        }

        // Needs user confirmation — queue it (Claude can fire several
        // mutations in parallel; each gets its own entry and the UI walks
        // the queue FIFO).
        onToolPermission?.(toolName, input);
        return new Promise<PermissionResult>((resolve) => {
          const entry: PendingConfirm = {
            toolName,
            input,
            resolve,
            timer: setTimeout(() => {
              // Nobody answered — deny so the run can finish instead of
              // hanging forever (UI may have crashed or user walked away).
              const idx = active.pendingConfirms.indexOf(entry);
              if (idx !== -1) active.pendingConfirms.splice(idx, 1);
              resolve({
                behavior: 'deny',
                message: 'Користувач не підтвердив дію протягом 10 хвилин — скасовано автоматично.',
              });
            }, CONFIRM_TIMEOUT_MS),
          };
          active.pendingConfirms.push(entry);
          signal.addEventListener('abort', () => {
            const idx = active.pendingConfirms.indexOf(entry);
            if (idx !== -1) active.pendingConfirms.splice(idx, 1);
            clearTimeout(entry.timer);
            resolve({ behavior: 'deny', message: 'Cancelled' });
          });
        });
      };

      const claudePath = getClaudePath() || undefined;

      // Three prompt variants:
      //   • Background runs (scheduled tasks, auto-syncs) — lean prompt, the
      //     task.prompt itself drives behaviour, skills list is dead weight.
      //   • Sessions with no Finmap API key — MCP-only orchestrator persona,
      //     Finmap tools will 401 anyway so we tell Claude not to suggest them.
      //   • Default interactive session with Finmap — full prompt + skills.
      const hasFinmap = typeof session.apiKey === 'string' && session.apiKey.trim().length > 0;
      const basePrompt = forceAutoApprove
        ? BACKGROUND_SYSTEM_PROMPT
        : hasFinmap ? SYSTEM_PROMPT : MCP_ONLY_SYSTEM_PROMPT;
      const systemPrompt = session.notes?.trim()
        ? `${basePrompt}\n\n## Company context (from user)\n${session.notes.trim()}`
        : basePrompt;

      const options: import('@anthropic-ai/claude-code').Options = {
        customSystemPrompt: systemPrompt,
        maxTurns: 20,
        abortController,
        canUseTool,
        // Use Folio's workspace dir so Claude Code auto-discovers our skills
        // from `<cwd>/.claude/skills/`.
        cwd: this.workspaceCwd,
        pathToClaudeCodeExecutable: claudePath,
        mcpServers: { finmap: active.mcpServer, ...userMcpServers },
        allowedTools: ALLOWED_TOOLS,
        permissionMode: 'default',
      };

      // Per-session model override. Aliases ("opus"/"sonnet"/"haiku") are
      // resolved by Claude Code itself to the newest model of that tier
      // available on the user's plan. Unset = Claude Code's own default.
      if (session.model?.trim()) {
        options.model = session.model.trim();
      }

      // Resume previous conversation to maintain history.
      // Do NOT set `continue: true` — it overrides `resume` and latches to the
      // newest session in cwd, which can hijack another Claude Code instance.
      if (active.claudeSessionId) {
        options.resume = active.claudeSessionId;
      }

      const stream = sdk.query({ prompt: userMessage, options });

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        // Capture session ID from any message for resume — persist to disk
        if ('session_id' in message && message.session_id && !active.claudeSessionId) {
          active.claudeSessionId = message.session_id;
          this.sessionStore.update(session.id, { claudeSessionId: message.session_id });
        }

        switch (message.type) {
          case 'assistant': {
            const content = message.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!('type' in block)) continue;
                if (block.type === 'text' && 'text' in block) {
                  fullResponse += (block as any).text;
                  onChunk((block as any).text);
                } else if (block.type === 'tool_use' && 'name' in block) {
                  const toolName = (block as any).name as string;
                  const toolInput = ('input' in block ? (block as any).input : {}) as Record<string, unknown>;
                  onToolCall(toolName, toolInput);
                }
              }
            }
            break;
          }
          case 'result': {
            if ('session_id' in message && message.session_id && !active.claudeSessionId) {
              active.claudeSessionId = message.session_id;
              this.sessionStore.update(session.id, { claudeSessionId: message.session_id });
            }
            if (message.subtype === 'success' && !fullResponse) {
              fullResponse = message.result;
              onChunk(message.result);
            } else if (message.subtype !== 'success') {
              const text = (message as any).result ?? `Claude returned subtype=${message.subtype}`;
              if (isAuthError(text)) {
                onAuthError?.(text);
                return;
              }
              onError(text);
              return;
            }
            break;
          }
        }
      }

      onDone(fullResponse);
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      const msg = err.message ?? 'Unknown error';
      if (isAuthError(msg)) {
        onAuthError?.(msg);
        return;
      }
      onError(msg);
    } finally {
      active.abortController = null;
    }
  }
}
