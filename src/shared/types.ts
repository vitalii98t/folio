// ============================================================
// Shared types between main and renderer processes
// ============================================================

/** A single chat session tied to one Finmap company / API key */
export interface ChatSession {
  id: string;
  name: string;
  /** Finmap API key. Optional — sessions without it run in "MCP-only" mode
   *  where Finmap tools are disabled but third-party MCP servers (Jira,
   *  GSheets, Notion etc.) work normally. User can add a key later via
   *  SessionSettingsModal to enable Finmap. */
  apiKey?: string;
  accountId?: string;
  createdAt: number;
  /** Claude Code SDK session ID for resume */
  claudeSessionId?: string;
  /** User-defined notes appended to the system prompt for this company */
  notes?: string;
  /** Google Drive API key — used by gdrive-direct folder-import bindings to
   *  access folders the user has shared with "anyone with the link". Stored
   *  per-session because different companies may use different Google accounts. */
  googleDriveApiKey?: string;
  /** Claude model for this session — one of the `value`s the installed Claude
   *  Code reports via LIST_CLAUDE_MODELS (an alias like "sonnet"/"opus[1m]",
   *  or a full id). Passed straight to the SDK; undefined = whatever the
   *  user's Claude Code defaults to. */
  model?: string;
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
  /** Consecutive failed runs — drives exponential backoff in SyncScheduler.
   *  Reset to 0 on the first successful run. */
  consecutiveFailures?: number;
}

/** Event emitted from main when a scheduled task changes state */
export interface TaskStatusEvent {
  taskId: string;
  sessionId: string;
  taskName: string;
  /** What kind of background run this is — scheduled task or file-import
   *  binding. They share this event channel; UI uses kind for labels and to
   *  route the cancel action. Absent = 'task' (older events). */
  kind?: 'task' | 'binding';
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
  lastStatus?: 'done' | 'error';
  /** Consecutive failed syncs — drives exponential backoff in SyncScheduler. */
  consecutiveFailures?: number;
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

/** User-configured MCP server (Slack, Notion, Postgres, anything that speaks MCP).
 *  Folio spawns it as a child process via the Claude Agent SDK on each message.
 *  Folio's own Finmap MCP server is built-in and not represented here. */
export interface McpServerConfig {
  id: string;
  sessionId: string;
  /** Tool namespace — becomes the prefix in `mcp__<name>__<tool>`. Lower-case,
   *  no spaces. Used in canUseTool routing too. */
  name: string;
  /** Executable to run (e.g., "npx", "uvx", absolute path to a binary). */
  command: string;
  /** Args passed to the executable (e.g., ["-y", "@modelcontextprotocol/server-slack"]). */
  args: string[];
  /** Env vars the server needs (API tokens etc.). Stored in plaintext locally —
   *  this is the same trust model as Finmap apiKey on session. */
  env?: Record<string, string>;
  enabled: boolean;
  /** If true — all tools from this server auto-approve without per-call UI prompt.
   *  User takes responsibility. If false — every tool call routes through the
   *  same confirmation flow as Finmap mutations. */
  autoApproveAll: boolean;
}

/** Auto-import binding: watch a folder in an external service (Google Drive
 *  for now) and import every new file into a specific Finmap account using a
 *  free-text context prompt as the import policy.
 *
 *  Lifecycle:
 *    setup     → record IDs of all existing files into processedFileIds as
 *                baseline; nothing is imported at this point
 *    runtime   → every syncIntervalMin, list folder → diff against
 *                processedFileIds → import each new file with contextPrompt →
 *                mark processed
 *    manual    → user can also trigger a run on demand from the UI */
export interface FileImportBinding {
  id: string;
  sessionId: string;

  // Source (only "gdrive" today, but namespaced so we can add others)
  sourceServerName: string;
  sourceFolderId: string;
  sourceFolderName: string;

  // Destination
  finmapAccountId: string;
  finmapAccountName: string;

  /** Free-text policy Claude interprets per file — what category, counterparty,
   *  operation type, parsing hints (e.g. "for .pdf treat as bank statement"). */
  contextPrompt: string;

  syncIntervalMin: number;
  enabled: boolean;

  // State
  processedFileIds: string[];
  lastSync?: number;
  /** Short textual result from the last run (truncated). */
  lastResult?: string;
  lastStatus?: 'done' | 'error';
  /** Consecutive failed runs — drives exponential backoff in SyncScheduler. */
  consecutiveFailures?: number;
}

/** One entry of the model picker, as reported by the installed Claude Code.
 *  We never hardcode this list — see main/claude-models.ts for why. */
export interface ClaudeModelInfo {
  /** What to store on the session and hand to the SDK (e.g. "sonnet", "opus[1m]"). */
  value: string;
  /** Human label from the CLI (e.g. "Opus (1M context)"). */
  displayName: string;
  /** One-line explainer from the CLI (e.g. "Sonnet 5 · Efficient for routine tasks"). */
  description: string;
  /** Full model id the value resolves to, when the CLI reports one. */
  resolvedModel?: string;
}

/** Status of Claude Code on the user's machine */
export type ClaudeCodeStatus = 'not_installed' | 'not_authenticated' | 'ready';

/** Auto-update progress event (main → renderer). Emitted by electron-updater
 *  wiring in main.ts. Only 'downloaded' triggers UI — a banner offering
 *  restart; the rest exist for future use/debugging. */
export interface UpdateStatusEvent {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  /** Version of the update (for 'available' / 'downloaded'). */
  version?: string;
  /** Download percentage (for 'downloading'). */
  percent?: number;
  /** Error message (for 'error'). */
  error?: string;
}

/** IPC channel names */
export const IPC = {
  // App meta
  GET_APP_VERSION: 'get-app-version',

  // Models the installed Claude Code offers on the user's plan
  LIST_CLAUDE_MODELS: 'list-claude-models',

  // Claude Code status
  CHECK_CLAUDE_STATUS: 'check-claude-status',
  OPEN_CLAUDE_LOGIN: 'open-claude-login',
  INSTALL_CLAUDE_CODE: 'install-claude-code',
  CLAUDE_LOGOUT: 'claude-logout',

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
  STREAM_AUTH_ERROR: 'stream-auth-error',
  TASK_STATUS: 'task-status',

  // Integrations
  GET_INTEGRATIONS: 'get-integrations',
  CREATE_INTEGRATION: 'create-integration',
  UPDATE_INTEGRATION: 'update-integration',
  DELETE_INTEGRATION: 'delete-integration',
  TOGGLE_INTEGRATION: 'toggle-integration',

  // Scheduled tasks
  GET_TASKS: 'get-tasks',
  CREATE_TASK: 'create-task',
  UPDATE_TASK: 'update-task',
  DELETE_TASK: 'delete-task',
  TOGGLE_TASK: 'toggle-task',
  CANCEL_TASK: 'cancel-task',

  // User-configured MCP servers
  GET_MCP_SERVERS: 'get-mcp-servers',
  CREATE_MCP_SERVER: 'create-mcp-server',
  UPDATE_MCP_SERVER: 'update-mcp-server',
  DELETE_MCP_SERVER: 'delete-mcp-server',
  TOGGLE_MCP_SERVER: 'toggle-mcp-server',

  // File import bindings (folder → Finmap account auto-sync)
  GET_FILE_BINDINGS: 'get-file-bindings',
  CREATE_FILE_BINDING: 'create-file-binding',
  UPDATE_FILE_BINDING: 'update-file-binding',
  DELETE_FILE_BINDING: 'delete-file-binding',
  TOGGLE_FILE_BINDING: 'toggle-file-binding',
  TRIGGER_FILE_BINDING: 'trigger-file-binding',

  // Manual trigger for scheduled tasks (in addition to the scheduler tick)
  TRIGGER_TASK: 'trigger-task',

  // Cancel a running file-import binding (mirror of CANCEL_TASK)
  CANCEL_FILE_BINDING: 'cancel-file-binding',

  // Auto-update (electron-updater)
  UPDATE_STATUS: 'update-status',       // main → renderer events
  INSTALL_UPDATE: 'install-update',     // renderer asks to quit & install

  // Google Drive direct access (for folder-import wizard UI)
  GDRIVE_VALIDATE: 'gdrive-validate',         // returns folder metadata + sample files
  GDRIVE_LIST_FILES: 'gdrive-list-files',     // listing for picker / baseline collection

  // Finmap account list for renderer use (wizard picks where to import)
  GET_FINMAP_ACCOUNTS: 'get-finmap-accounts',
} as const;
