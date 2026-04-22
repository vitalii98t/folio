import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ChatSession, ChatMessage, Integration, ScheduledTask, SearchResult } from '../shared/types';

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
  } = { sessions: [], integrations: [], tasks: [], messages: {} };
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
      // Ensure messages field exists (migration from older data)
      if (!parsed.messages) parsed.messages = {};
      if (!parsed.integrations) parsed.integrations = [];
      if (!parsed.sessions) parsed.sessions = [];
      if (!parsed.tasks) parsed.tasks = [];
      return parsed;
    } catch {
      return { sessions: [], integrations: [], tasks: [], messages: {} };
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
}
