import { FinmapAPI } from './finmap-api';
import { buildFinmapMcpServer, MUTATION_TOOLS } from './mcp-tools';
import { SYSTEM_PROMPT } from './system-prompt';
import { getClaudePath, isAuthError } from './claude-status';
import type { SessionStore } from './session-store';
import type { ChatSession } from '../shared/types';

let _sdk: typeof import('@anthropic-ai/claude-code') | null = null;
async function getSDK() {
  if (!_sdk) _sdk = await import('@anthropic-ai/claude-code');
  return _sdk;
}

type PermissionResult = import('@anthropic-ai/claude-code').PermissionResult;

interface ActiveSession {
  api: FinmapAPI;
  mcpServer: Awaited<ReturnType<typeof buildFinmapMcpServer>> | null;
  claudeSessionId: string | null;
  abortController: AbortController | null;
  pendingConfirmResolve: ((result: PermissionResult) => void) | null;
  /** When true — auto-approve all mutations without asking user */
  autoApprove: boolean;
  /** Last input received in canUseTool, used on confirm */
  pendingInput: Record<string, unknown> | null;
}

// Read-only tools — SDK auto-approves these via --allowedTools flag (canUseTool skipped).
// Mutations are intentionally NOT listed here, so canUseTool fires and we can prompt the user.
const ALLOWED_TOOLS = [
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
  'mcp__finmap__get_invoices',
  'mcp__finmap__get_invoice_details',
  'mcp__finmap__get_invoice_goods',
  'mcp__finmap__get_invoice_companies',
  'mcp__finmap__get_webhooks',
  'mcp__finmap__list_integrations',
  'mcp__finmap__toggle_integration',
];

/**
 * Manages Claude Agent SDK sessions with conversation history via resume.
 */
export class AgentManager {
  private sessions = new Map<string, ActiveSession>();
  private sessionStore: SessionStore;

  constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  private getOrCreate(session: ChatSession): ActiveSession {
    let active = this.sessions.get(session.id);
    if (!active) {
      active = {
        api: new FinmapAPI(session.apiKey),
        mcpServer: null,
        claudeSessionId: session.claudeSessionId || null,
        abortController: null,
        pendingConfirmResolve: null,
        autoApprove: false,
        pendingInput: null,
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

  async confirmMutation(sessionId: string): Promise<boolean> {
    const active = this.sessions.get(sessionId);
    if (active?.pendingConfirmResolve) {
      // Use original input — passing {} would execute tool with empty data!
      active.pendingConfirmResolve({ behavior: 'allow', updatedInput: active.pendingInput ?? {} });
      active.pendingConfirmResolve = null;
      active.pendingInput = null;
      return true;
    }
    return false;
  }

  async rejectMutation(sessionId: string): Promise<boolean> {
    const active = this.sessions.get(sessionId);
    if (active?.pendingConfirmResolve) {
      active.pendingConfirmResolve({ behavior: 'deny', message: 'User rejected this action.' });
      active.pendingConfirmResolve = null;
      active.pendingInput = null;
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

    try {
      const sdk = await getSDK();
      let fullResponse = '';

      const canUseTool: import('@anthropic-ai/claude-code').CanUseTool = async (toolName, input, { signal }) => {
        // Non-mutations reach here only if they're outside allowedTools. Shouldn't happen
        // for MCP tools, but be permissive if it does.
        if (!MUTATION_TOOLS.has(toolName) || active.autoApprove || forceAutoApprove) {
          return { behavior: 'allow', updatedInput: input };
        }
        // Mutation needs user confirmation
        onToolPermission?.(toolName, input);
        active.pendingInput = input;
        return new Promise<PermissionResult>((resolve) => {
          active.pendingConfirmResolve = resolve;
          signal.addEventListener('abort', () => {
            resolve({ behavior: 'deny', message: 'Cancelled' });
            active.pendingInput = null;
          });
        });
      };

      const claudePath = getClaudePath() || undefined;

      // Append per-company notes to the system prompt so Claude picks up
      // user-specific context (e.g. account conventions, accounting rules).
      const systemPrompt = session.notes?.trim()
        ? `${SYSTEM_PROMPT}\n\n## Company context (from user)\n${session.notes.trim()}`
        : SYSTEM_PROMPT;

      const options: import('@anthropic-ai/claude-code').Options = {
        customSystemPrompt: systemPrompt,
        maxTurns: 20,
        abortController,
        canUseTool,
        cwd: process.cwd(),
        pathToClaudeCodeExecutable: claudePath,
        mcpServers: { finmap: active.mcpServer },
        allowedTools: ALLOWED_TOOLS,
        permissionMode: 'default',
      };

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
                  // Display activity for every tool Claude decides to call
                  // (read-only auto-run via allowedTools; mutations pass through canUseTool).
                  const toolInput = ('input' in block ? (block as any).input : {}) as Record<string, unknown>;
                  onToolCall((block as any).name, toolInput);
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
