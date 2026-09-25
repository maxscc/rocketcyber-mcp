import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { TOOL_DEFINITIONS } from '../handlers/tool.definitions.js';
import { bearerMatches } from '../utils/bearer.js';
import { RocketCyberMcpServer } from '../mcp/server.js';
import { Logger } from '../utils/logger.js';

describe('Suffolk: read-only', () => {
  it('every tool is a read (test/get/list) - fails if upstream adds a write tool', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toHaveLength(10);
    for (const n of names) expect(n).toMatch(/^rocketcyber_(test|get|list)_/);
  });
});

describe('Suffolk: bearer token', () => {
  it('accepts only the exact token', () => {
    expect(bearerMatches('Bearer abc123', 'abc123')).toBe(true);
    expect(bearerMatches('bearer  abc123 ', 'abc123')).toBe(true);
    expect(bearerMatches('Bearer abc12', 'abc123')).toBe(false);
    expect(bearerMatches('abc123', 'abc123')).toBe(false);
    expect(bearerMatches(undefined, 'abc123')).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });

  describe('HTTP /mcp', () => {
    let server: RocketCyberMcpServer;
    let base = '';
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

    beforeAll(async () => {
      process.env.MCP_BEARER_TOKEN = 'test-token';
      const logger = new Logger('error', 'simple');
      server = new RocketCyberMcpServer(
        { name: 'rocketcyber-mcp', version: 'test', rocketcyber: { apiKey: 'x', region: 'us' } },
        logger,
        {
          rocketcyber: { apiKey: 'x', region: 'us' },
          server: { name: 'rocketcyber-mcp', version: 'test' },
          transport: { type: 'http', port: 28772, host: '127.0.0.1' },
          logging: { level: 'error', format: 'simple' },
          auth: { mode: 'env' },
        },
      );
      await server.start();
      const addr = (server as unknown as { httpServer: { address(): AddressInfo } }).httpServer.address();
      base = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await server.stop();
      delete process.env.MCP_BEARER_TOKEN;
    });

    it('rejects /mcp without the token', async () => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
      expect(r.status).toBe(401);
    });

    it('rejects /mcp with the wrong token', async () => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer nope' }, body });
      expect(r.status).toBe(401);
    });

    it('serves /mcp with the token', async () => {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...headers, Authorization: 'Bearer test-token' }, body });
      expect(r.status).toBe(200);
      const j = await r.json() as { result: { tools: unknown[] } };
      expect(j.result.tools).toHaveLength(10);
    });

    it('leaves /health open', async () => {
      const r = await fetch(`${base}/health`);
      expect(r.status).toBe(200);
    });
  });
});
