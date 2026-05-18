import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ChatSession, ChatMessage, Integration, ScheduledTask, SearchResult, McpServerConfig, FileImportBinding } from '../shared/types';

/**
 * Simple JSON file-based store for sessions and integrations.
 * Data lives in the Electron userData directory.
 * Uses lazy init to avoid calling app.getPath() before app is ready.
 */
export class SessionStore {
  private filePath: string | null = null;
  private data: {
    sessions: ChatSession[];
    integrations: Integration[];
    tasks: ScheduledTask[];
    messages: Record<string, ChatMessage[]>; // sessionId → messages
    mcpServers: McpServerConfig[];
    fileBindings: FileImportBinding[];
  } = { sessions: [], integrations: [], tasks: [], messages: {}, mcpServers: [], fileBindings: [] };
  private initialized = false;

  private ensureInit() {
    if (this.initialized) return;
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'finmap-agent-data.json');
    this.data = this.load();
    this.initialized = true;
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.filePath!, 'utf-8');
      const parsed = JSON.parse(raw);
      // Ensure all top-level fields exist (migration from older data)
      if (!parsed.messages) parsed.messages = {};
      if (!parsed.integrations) parsed.integrations = [];
      if (!parsed.sessions) parsed.sessions = [];
      if (!parsed.tasks) parsed.tasks = [];
      if (!parsed.mcpServers) parsed.mcpServers = [];
      if (!parsed.fileBindings) parsed.fileBindings = [];
      return parsed;
    } catch {
      return { sessions: [], integrations: [], tasks: [], messages: {}, mcpServers: [], fileBindings: [] };
    }
  }

  private save() {
    fs.writeFileSync(this.filePath!, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  // ── Sessions ────────────────────────────────────────────────

  getAll(): ChatSession[] {
    this.ensureInit();
    return this.data.sessions;
  }

  get(id: string): ChatSession | undefined {
    this.ensureInit();
    return this.data.sessions.find(s => s.id === id);
  }

  create(input: Omit<ChatSession, 'id' | 'createdAt'>): ChatSession {
    this.ensureInit();
    const session: ChatSession = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.data.sessions.push(session);
    this.save();
    return session;
  }

  update(id: string, updates: Partial<ChatSession>): ChatSession | null {
    this.ensureInit();
    const idx = this.data.sessions.findIndex(s => s.id === id);
    if (idx === -1) return null;
    this.data.sessions[idx] = { ...this.data.sessions[idx], ...updates, id };
    this.save();
    return this.data.sessions[idx];
  }

  delete(id: string): boolean {
    this.ensureInit();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(s => s.id !== id);
    this.data.integrations = this.data.integrations.filter(i => i.sessionId !== id);
    this.data.tasks = this.data.tasks.filter(t => t.sessionId !== id);
    delete this.data.messages[id];
    this.save();
    return this.data.sessions.length < before;
  }

  // ── Messages ─────────────────────────────────────────────────

  getMessages(sessionId: string): ChatMessage[] {
    this.ensureInit();
    return this.data.messages[sessionId] ?? [];
  }

  addMessage(sessionId: string, message: ChatMessage) {
    this.ensureInit();
    if (!this.data.messages[sessionId]) {
      this.data.messages[sessionId] = [];
    }
    this.data.messages[sessionId].push(message);
    this.save();
  }

  clearMessages(sessionId: string) {
    this.ensureInit();
    this.data.messages[sessionId] = [];
    this.save();
  }

  /** Case-insensitive substring search across all messages in all sessions. */
  searchMessages(query: string, limit = 50): SearchResult[] {
    this.ensureInit();
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const sessionNameById = new Map(this.data.sessions.map(s => [s.id, s.name]));
    const results: SearchResult[] = [];
    const snippetPad = 50;

    for (const [sessionId, messages] of Object.entries(this.data.messages)) {
      const sessionName = sessionNameById.get(sessionId);
      if (!sessionName) continue; // orphaned messages from deleted session
      for (const msg of messages) {
        const lower = msg.content.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) continue;

        const start = Math.max(0, idx - snippetPad);
        const end = Math.min(msg.content.length, idx + q.length + snippetPad);
        const prefix = start > 0 ? '…' : '';
        const suffix = end < msg.content.length ? '…' : '';
        const snippet = prefix + msg.content.slice(start, end) + suffix;
        const matchStart = prefix.length + (idx - start);
        const matchEnd = matchStart + q.length;

        results.push({
          sessionId,
          sessionName,
          messageId: msg.id,
          role: msg.role,
          timestamp: msg.timestamp,
          snippet,
          matchStart,
          matchEnd,
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }

    results.sort((a, b) => b.timestamp - a.timestamp);
    return results;
  }

  // ── Integrations ────────────────────────────────────────────

  getIntegrations(sessionId: string): Integration[] {
    this.ensureInit();
    return this.data.integrations.filter(i => i.sessionId === sessionId);
  }

  createIntegration(input: Omit<Integration, 'id'>): Integration {
    this.ensureInit();
    const integration: Integration = {
      ...input,
      id: crypto.randomUUID(),
    };
    this.data.integrations.push(integration);
    this.save();
    return integration;
  }

  updateIntegration(id: string, updates: Partial<Integration>): Integration | null {
    this.ensureInit();
    const integration = this.data.integrations.find(i => i.id === id);
    if (!integration) return null;
    Object.assign(integration, updates);
    this.save();
    return integration;
  }

  deleteIntegration(id: string): boolean {
    this.ensureInit();
    const before = this.data.integrations.length;
    this.data.integrations = this.data.integrations.filter(i => i.id !== id);
    this.save();
    return this.data.integrations.length < before;
  }

  toggleIntegration(id: string): Integration | null {
    this.ensureInit();
    const integration = this.data.integrations.find(i => i.id === id);
    if (!integration) return null;
    integration.enabled = !integration.enabled;
    this.save();
    return integration;
  }

  // ── Scheduled tasks ─────────────────────────────────────────

  getTasks(sessionId: string): ScheduledTask[] {
    this.ensureInit();
    return this.data.tasks.filter(t => t.sessionId === sessionId);
  }

  getAllTasks(): ScheduledTask[] {
    this.ensureInit();
    return this.data.tasks;
  }

  createTask(input: Omit<ScheduledTask, 'id'>): ScheduledTask {
    this.ensureInit();
    const task: ScheduledTask = { ...input, id: crypto.randomUUID() };
    this.data.tasks.push(task);
    this.save();
    return task;
  }

  updateTask(id: string, updates: Partial<ScheduledTask>): ScheduledTask | null {
    this.ensureInit();
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) return null;
    Object.assign(task, updates);
    this.save();
    return task;
  }

  deleteTask(id: string): boolean {
    this.ensureInit();
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter(t => t.id !== id);
    this.save();
    return this.data.tasks.length < before;
  }

  toggleTask(id: string): ScheduledTask | null {
    this.ensureInit();
    const task = this.data.tasks.find(t => t.id === id);
    if (!task) return null;
    task.enabled = !task.enabled;
    this.save();
    return task;
  }

  /** Wipe `claudeSessionId` from every session — used when the user logs out
   *  of Claude Code. Those session ids belong to the now-revoked account and
   *  resuming them on next message would fail with auth errors. Local Folio
   *  history (messages, integrations, tasks, bindings) stays intact. */
  resetAllClaudeSessions(): void {
    this.ensureInit();
    let touched = false;
    for (const session of this.data.sessions) {
      if (session.claudeSessionId !== undefined) {
        session.claudeSessionId = undefined;
        touched = true;
      }
    }
    if (touched) this.save();
  }

  // ── MCP servers (user-configured) ──────────────────────────

  getMcpServers(sessionId: string): McpServerConfig[] {
    this.ensureInit();
    return this.data.mcpServers.filter(s => s.sessionId === sessionId);
  }

  createMcpServer(cfg: Omit<McpServerConfig, 'id'>): McpServerConfig {
    this.ensureInit();
    const server: McpServerConfig = { ...cfg, id: crypto.randomUUID() };
    this.data.mcpServers.push(server);
    this.save();
    return server;
  }

  updateMcpServer(id: string, updates: Partial<McpServerConfig>): McpServerConfig | null {
    this.ensureInit();
    const server = this.data.mcpServers.find(s => s.id === id);
    if (!server) return null;
    // Don't allow changing the id/sessionId — those are identity.
    const { id: _, sessionId: __, ...safe } = updates;
    Object.assign(server, safe);
    this.save();
    return server;
  }

  deleteMcpServer(id: string): boolean {
    this.ensureInit();
    const before = this.data.mcpServers.length;
    this.data.mcpServers = this.data.mcpServers.filter(s => s.id !== id);
    this.save();
    return this.data.mcpServers.length < before;
  }

  toggleMcpServer(id: string): McpServerConfig | null {
    this.ensureInit();
    const server = this.data.mcpServers.find(s => s.id === id);
    if (!server) return null;
    server.enabled = !server.enabled;
    this.save();
    return server;
  }

  // ── File import bindings (folder → Finmap account) ─────────

  getFileBindings(sessionId: string): FileImportBinding[] {
    this.ensureInit();
    return this.data.fileBindings.filter(b => b.sessionId === sessionId);
  }

  getAllFileBindings(): FileImportBinding[] {
    this.ensureInit();
    return this.data.fileBindings;
  }

  createFileBinding(b: Omit<FileImportBinding, 'id'>): FileImportBinding {
    this.ensureInit();
    const binding: FileImportBinding = { ...b, id: crypto.randomUUID() };
    this.data.fileBindings.push(binding);
    this.save();
    return binding;
  }

  updateFileBinding(id: string, updates: Partial<FileImportBinding>): FileImportBinding | null {
    this.ensureInit();
    const binding = this.data.fileBindings.find(b => b.id === id);
    if (!binding) return null;
    // Identity fields can't be changed
    const { id: _, sessionId: __, ...safe } = updates;
    Object.assign(binding, safe);
    this.save();
    return binding;
  }

  deleteFileBinding(id: string): boolean {
    this.ensureInit();
    const before = this.data.fileBindings.length;
    this.data.fileBindings = this.data.fileBindings.filter(b => b.id !== id);
    this.save();
    return this.data.fileBindings.length < before;
  }

  toggleFileBinding(id: string): FileImportBinding | null {
    this.ensureInit();
    const binding = this.data.fileBindings.find(b => b.id === id);
    if (!binding) return null;
    binding.enabled = !binding.enabled;
    this.save();
    return binding;
  }

  /** Append fileIds to a binding's processed list (dedupes). Used by the MCP
   *  tool `mark_files_processed` after Claude finishes importing them. */
  markFilesProcessed(id: string, fileIds: string[]): FileImportBinding | null {
    this.ensureInit();
    const binding = this.data.fileBindings.find(b => b.id === id);
    if (!binding) return null;
    const set = new Set(binding.processedFileIds);
    for (const fid of fileIds) set.add(fid);
    binding.processedFileIds = Array.from(set);
    this.save();
    return binding;
  }
}
