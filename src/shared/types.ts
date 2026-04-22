// ============================================================
// Shared types between main and renderer processes
// ============================================================

/** A single chat session tied to one Finmap company / API key */
export interface ChatSession {
  id: string;
  name: string;
  apiKey: string;
  accountId?: string;
  createdAt: number;
  /** Claude Code SDK session ID for resume */
  claudeSessionId?: string;
  /** User-defined notes appended to the system prompt for this company */
  notes?: string;
}

/** Scheduled autonomous task — runs the given prompt against Claude on an interval */
export interface ScheduledTask {
  id: string;
  sessionId: string;
  name: string;
  prompt: string;
  intervalMin: number;
  enabled: boolean;
  lastRun?: number;
  /** Short textual result from the last execution (truncated) */
  lastResult?: string;
  lastStatus?: 'done' | 'error';
}

/** Event emitted from main when a scheduled task changes state */
export interface TaskStatusEvent {
  taskId: string;
  sessionId: string;
  taskName: string;
  status: 'start' | 'progress' | 'done' | 'error';
  /** For 'progress' — name of the tool that just started (e.g. mcp__finmap__get_operations) */
  currentTool?: string;
  /** For 'done'/'error' — textual result or error message */
  result?: string;
}

/** Custom integration config */
export interface Integration {
  id: string;
  sessionId: string;
  serviceName: string;
  serviceApiKey: string;
  serviceDocsUrl?: string;
  serviceDocs?: string;
  finmapAccountId: string;
  finmapAccountName?: string;
  enabled: boolean;
  /** Sync interval in minutes (default 30) */
  syncIntervalMin: number;
  lastSync?: number;
  /** Short instruction for Claude how to sync this service */
  syncPrompt?: string;
}

/** Attached file info */
export interface AttachedFile {
  name: string;
  type: string;        // MIME type
  path: string;        // local file path
  size: number;
  /** base64 data URL for image previews in UI */
  dataUrl?: string;
}

/** Message in the chat */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Attached files (images, documents) */
  attachments?: AttachedFile[];
  /** Tool calls that were executed during this message */
  toolCalls?: ToolCallInfo[];
  /** Whether a confirmation is pending for a mutation */
  pendingConfirmation?: MutationConfirmation;
}

export interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
}

/** Result of a message search across all sessions */
export interface SearchResult {
  sessionId: string;
  sessionName: string;
  messageId: string;
  role: 'user' | 'assistant';
  timestamp: number;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface MutationConfirmation {
  toolName: string;
  description: string;
  input: Record<string, unknown>;
}

/** Status of Claude Code on the user's machine */
export type ClaudeCodeStatus = 'not_installed' | 'not_authenticated' | 'ready';

/** IPC channel names */
export const IPC = {
  // Claude Code status
  CHECK_CLAUDE_STATUS: 'check-claude-status',
  OPEN_CLAUDE_LOGIN: 'open-claude-login',

  // Sessions
  GET_SESSIONS: 'get-sessions',
  CREATE_SESSION: 'create-session',
  DELETE_SESSION: 'delete-session',
  UPDATE_SESSION: 'update-session',

  // Chat
  SEND_MESSAGE: 'send-message',
  SEND_MESSAGE_WITH_FILES: 'send-message-with-files',
  CANCEL_MESSAGE: 'cancel-message',
  CONFIRM_MUTATION: 'confirm-mutation',
  REJECT_MUTATION: 'reject-mutation',
  SELECT_FILES: 'select-files',

  // Messages persistence
  GET_MESSAGES: 'get-messages',
  ADD_MESSAGE: 'add-message',
  CLEAR_MESSAGES: 'clear-messages',
  SEARCH_MESSAGES: 'search-messages',
  NEW_CHAT: 'new-chat',
  SET_AUTO_APPROVE: 'set-auto-approve',
  GET_AUTO_APPROVE: 'get-auto-approve',
  GET_CLAUDE_SESSION_ID: 'get-claude-session-id',

  // Stream events from main → renderer
  STREAM_CHUNK: 'stream-chunk',
  STREAM_TOOL_CALL: 'stream-tool-call',
  STREAM_TOOL_PERMISSION: 'stream-tool-permission',
  STREAM_DONE: 'stream-done',
  STREAM_ERROR: 'stream-error',
  TASK_STATUS: 'task-status',

  // Integrations
  GET_INTEGRATIONS: 'get-integrations',
  CREATE_INTEGRATION: 'create-integration',
  DELETE_INTEGRATION: 'delete-integration',
  TOGGLE_INTEGRATION: 'toggle-integration',

  // Scheduled tasks
  GET_TASKS: 'get-tasks',
  CREATE_TASK: 'create-task',
  UPDATE_TASK: 'update-task',
  DELETE_TASK: 'delete-task',
  TOGGLE_TASK: 'toggle-task',
  CANCEL_TASK: 'cancel-task',
} as const;
