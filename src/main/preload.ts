import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';
import type { ChatSession, Integration, ScheduledTask, SearchResult, TaskStatusEvent, McpServerConfig, FileImportBinding } from '../shared/types';

const api = {
  // Claude Code
  checkClaudeStatus: () => ipcRenderer.invoke(IPC.CHECK_CLAUDE_STATUS),
  openClaudeLogin: () => ipcRenderer.invoke(IPC.OPEN_CLAUDE_LOGIN),
  installClaudeCode: () => ipcRenderer.invoke(IPC.INSTALL_CLAUDE_CODE),
  claudeLogout: () =>
    ipcRenderer.invoke(IPC.CLAUDE_LOGOUT) as Promise<{ ok: true } | { ok: false; error: string }>,

  // Sessions
  getSessions: () => ipcRenderer.invoke(IPC.GET_SESSIONS) as Promise<ChatSession[]>,
  createSession: (session: Omit<ChatSession, 'id' | 'createdAt'>) =>
    ipcRenderer.invoke(IPC.CREATE_SESSION, session) as Promise<ChatSession>,
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.DELETE_SESSION, id),
  updateSession: (id: string, updates: Partial<ChatSession>) =>
    ipcRenderer.invoke(IPC.UPDATE_SESSION, id, updates),

  // Messages persistence
  getMessages: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_MESSAGES, sessionId),
  addMessage: (sessionId: string, message: any) =>
    ipcRenderer.invoke(IPC.ADD_MESSAGE, sessionId, message),
  clearMessages: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CLEAR_MESSAGES, sessionId),
  searchMessages: (query: string) =>
    ipcRenderer.invoke(IPC.SEARCH_MESSAGES, query) as Promise<SearchResult[]>,
  newChat: (sessionId: string) =>
    ipcRenderer.invoke(IPC.NEW_CHAT, sessionId),
  setAutoApprove: (sessionId: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.SET_AUTO_APPROVE, sessionId, enabled),
  getAutoApprove: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_AUTO_APPROVE, sessionId) as Promise<boolean>,
  getClaudeSessionId: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_CLAUDE_SESSION_ID, sessionId) as Promise<string | null>,

  // Chat
  sendMessage: (sessionId: string, message: string) =>
    ipcRenderer.send(IPC.SEND_MESSAGE, sessionId, message),
  sendMessageWithFiles: (sessionId: string, message: string, filePaths: string[]) =>
    ipcRenderer.send(IPC.SEND_MESSAGE_WITH_FILES, sessionId, message, filePaths),
  cancelMessage: (sessionId: string) =>
    ipcRenderer.send(IPC.CANCEL_MESSAGE, sessionId),
  confirmMutation: (sessionId: string) =>
    ipcRenderer.invoke(IPC.CONFIRM_MUTATION, sessionId),
  rejectMutation: (sessionId: string) =>
    ipcRenderer.invoke(IPC.REJECT_MUTATION, sessionId),
  selectFiles: () =>
    ipcRenderer.invoke(IPC.SELECT_FILES) as Promise<{ name: string; path: string; type: string; size: number; dataUrl?: string }[]>,

  // Stream listeners
  onStreamChunk: (cb: (sessionId: string, text: string) => void) => {
    const handler = (_e: any, sessionId: string, text: string) => cb(sessionId, text);
    ipcRenderer.on(IPC.STREAM_CHUNK, handler);
    return () => ipcRenderer.removeListener(IPC.STREAM_CHUNK, handler);
  },
  onStreamToolCall: (cb: (sessionId: string, toolName: string, input: Record<string, unknown>) => void) => {
    const handler = (_e: any, sid: string, name: string, input: Record<string, unknown>) => cb(sid, name, input);
    ipcRenderer.on(IPC.STREAM_TOOL_CALL, handler);
    return () => ipcRenderer.removeListener(IPC.STREAM_TOOL_CALL, handler);
  },
  onStreamToolPermission: (cb: (sessionId: string, toolName: string, input: Record<string, unknown>) => void) => {
    const handler = (_e: any, sid: string, name: string, input: Record<string, unknown>) => cb(sid, name, input);
    ipcRenderer.on(IPC.STREAM_TOOL_PERMISSION, handler);
    return () => ipcRenderer.removeListener(IPC.STREAM_TOOL_PERMISSION, handler);
  },
  onStreamDone: (cb: (sessionId: string, fullText: string) => void) => {
    const handler = (_e: any, sessionId: string, text: string) => cb(sessionId, text);
    ipcRenderer.on(IPC.STREAM_DONE, handler);
    return () => ipcRenderer.removeListener(IPC.STREAM_DONE, handler);
  },
  onStreamError: (cb: (sessionId: string, error: string) => void) => {
    const handler = (_e: any, sessionId: string, error: string) => cb(sessionId, error);
    ipcRenderer.on(IPC.STREAM_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.STREAM_ERROR, handler);
  },
  onStreamAuthError: (cb: (sessionId: string, message: string) => void) => {
    const handler = (_e: any, sessionId: string, message: string) => cb(sessionId, message);
    ipcRenderer.on(IPC.STREAM_AUTH_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.STREAM_AUTH_ERROR, handler);
  },
  onTaskStatus: (cb: (event: TaskStatusEvent) => void) => {
    const handler = (_e: any, event: TaskStatusEvent) => cb(event);
    ipcRenderer.on(IPC.TASK_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.TASK_STATUS, handler);
  },

  // Integrations
  getIntegrations: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_INTEGRATIONS, sessionId) as Promise<Integration[]>,
  createIntegration: (integration: Omit<Integration, 'id'>) =>
    ipcRenderer.invoke(IPC.CREATE_INTEGRATION, integration) as Promise<Integration>,
  updateIntegration: (id: string, updates: Partial<Integration>) =>
    ipcRenderer.invoke(IPC.UPDATE_INTEGRATION, id, updates) as Promise<Integration | null>,
  deleteIntegration: (id: string) => ipcRenderer.invoke(IPC.DELETE_INTEGRATION, id),
  toggleIntegration: (id: string) => ipcRenderer.invoke(IPC.TOGGLE_INTEGRATION, id),

  // Scheduled tasks
  getTasks: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_TASKS, sessionId) as Promise<ScheduledTask[]>,
  createTask: (task: Omit<ScheduledTask, 'id'>) =>
    ipcRenderer.invoke(IPC.CREATE_TASK, task) as Promise<ScheduledTask>,
  updateTask: (id: string, updates: Partial<ScheduledTask>) =>
    ipcRenderer.invoke(IPC.UPDATE_TASK, id, updates) as Promise<ScheduledTask | null>,
  deleteTask: (id: string) => ipcRenderer.invoke(IPC.DELETE_TASK, id),
  toggleTask: (id: string) => ipcRenderer.invoke(IPC.TOGGLE_TASK, id),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC.CANCEL_TASK, id),

  // User-configured MCP servers
  getMcpServers: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_MCP_SERVERS, sessionId) as Promise<McpServerConfig[]>,
  createMcpServer: (cfg: Omit<McpServerConfig, 'id'>) =>
    ipcRenderer.invoke(IPC.CREATE_MCP_SERVER, cfg) as Promise<McpServerConfig>,
  updateMcpServer: (id: string, updates: Partial<McpServerConfig>) =>
    ipcRenderer.invoke(IPC.UPDATE_MCP_SERVER, id, updates) as Promise<McpServerConfig | null>,
  deleteMcpServer: (id: string) => ipcRenderer.invoke(IPC.DELETE_MCP_SERVER, id),
  toggleMcpServer: (id: string) =>
    ipcRenderer.invoke(IPC.TOGGLE_MCP_SERVER, id) as Promise<McpServerConfig | null>,

  // File import bindings (folder → Finmap account)
  getFileBindings: (sessionId: string) =>
    ipcRenderer.invoke(IPC.GET_FILE_BINDINGS, sessionId) as Promise<FileImportBinding[]>,
  createFileBinding: (cfg: Omit<FileImportBinding, 'id'>) =>
    ipcRenderer.invoke(IPC.CREATE_FILE_BINDING, cfg) as Promise<FileImportBinding>,
  updateFileBinding: (id: string, updates: Partial<FileImportBinding>) =>
    ipcRenderer.invoke(IPC.UPDATE_FILE_BINDING, id, updates) as Promise<FileImportBinding | null>,
  deleteFileBinding: (id: string) => ipcRenderer.invoke(IPC.DELETE_FILE_BINDING, id),
  toggleFileBinding: (id: string) =>
    ipcRenderer.invoke(IPC.TOGGLE_FILE_BINDING, id) as Promise<FileImportBinding | null>,
  triggerFileBinding: (id: string) => ipcRenderer.invoke(IPC.TRIGGER_FILE_BINDING, id),

  // Manual trigger for scheduled task
  triggerTask: (id: string) => ipcRenderer.invoke(IPC.TRIGGER_TASK, id),

  // Google Drive direct (for folder-import wizard)
  gdriveValidate: (apiKey: string, folderUrl: string) =>
    ipcRenderer.invoke(IPC.GDRIVE_VALIDATE, { apiKey, folderUrl }) as Promise<
      | { ok: true; folderId: string; folder: { id: string; name: string; mimeType: string; webViewLink?: string }; sampleFiles: any[] }
      | { ok: false; error: string }
    >,
  gdriveListFiles: (apiKey: string, folderId: string) =>
    ipcRenderer.invoke(IPC.GDRIVE_LIST_FILES, { apiKey, folderId }) as Promise<
      { ok: true; files: any[] } | { ok: false; error: string }
    >,

  // For FolderImportWizard's account-picker step
  getFinmapAccounts: (finmapApiKey: string) =>
    ipcRenderer.invoke(IPC.GET_FINMAP_ACCOUNTS, finmapApiKey) as Promise<
      { id: string; label: string; balance?: number; currencyId?: string }[]
    >,
};

contextBridge.exposeInMainWorld('finmapAgent', api);

export type FinmapAgentAPI = typeof api;
