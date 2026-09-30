import * as http from 'http';
import * as crypto from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Serves Folio's in-process MCP tools (Finmap etc.) to the Claude Code CLI
 * over Streamable HTTP on 127.0.0.1.
 *
 * Why not the SDK's in-process `type: 'sdk'` server alone: Claude Code does
 * not hand in-process servers to subagents, so a Finmap-analyst subagent
 * would have no Finmap tools (it then invents numbers). An HTTP server is a
 * regular configured MCP server the CLI shares with subagents.
 *
 * Stateless by design: every POST gets a fresh McpServer from the run's
 * factory. One McpServer instance can only be bound to one transport, and
 * the main thread plus several parallel subagents call tools concurrently —
 * sharing one would route results to the wrong caller.
 *
 * Each run registers its own route with an unguessable bearer token, so a
 * run only reaches tools built for its own session/API key, and nothing else
 * on the machine can call them.
 */

/** Anything with the McpServer connect/close surface. */
export interface ConnectableMcpServer {
  connect(transport: any): Promise<void>;
  close(): Promise<void>;
}
export type McpServerFactory = () => Promise<ConnectableMcpServer>;

export interface McpHttpRoute {
  config: { type: 'http'; url: string; headers: Record<string, string> };
  dispose: () => void;
}

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export class McpHttpHost {
  private server: http.Server | null = null;
  private port = 0;
  private routes = new Map<string, McpServerFactory>();
  private starting: Promise<void> | null = null;

  private start(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const srv = http.createServer((req, res) => { void this.handle(req, res); });
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.server = srv;
        resolve();
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Expose a factory for the duration of one run. Call dispose() after. */
  async register(factory: McpServerFactory): Promise<McpHttpRoute> {
    await this.start();
    const token = crypto.randomBytes(24).toString('hex');
    this.routes.set(token, factory);
    return {
      config: {
        type: 'http',
        url: `http://127.0.0.1:${this.port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
      dispose: () => { this.routes.delete(token); },
    };
  }

  stop() {
    this.routes.clear();
    this.server?.close();
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const fail = (status: number, message: string) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
    };

    // Only this host's single endpoint; stateless servers take POST only.
    if (!req.url || !req.url.startsWith('/mcp')) return fail(404, 'Not found');
    const token = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const factory = token ? this.routes.get(token) : undefined;
    if (!factory) return fail(401, 'Unauthorized');
    if (req.method !== 'POST') return fail(405, 'Method not allowed');

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return fail(400, err?.message ?? 'Bad request');
    }

    let mcp: ConnectableMcpServer | null = null;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close().catch(() => {});
      void mcp?.close().catch(() => {});
    });
    try {
      mcp = await factory();
      await mcp.connect(transport);
      await transport.handleRequest(req as any, res, body);
    } catch (err: any) {
      console.error('[McpHttpHost] request failed:', err);
      fail(500, err?.message ?? 'Internal error');
    }
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** Shared host for the main process. */
export const mcpHttpHost = new McpHttpHost();
