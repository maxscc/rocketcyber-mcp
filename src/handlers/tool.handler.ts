import { RocketCyberService } from '../services/rocketcyber.service.js';
import { Logger } from '../utils/logger.js';
import { TOOL_DEFINITIONS, McpTool } from './tool.definitions.js';
import { DEFAULT_SORTS, APPS_UNSUPPORTED_PARAMS, withDefaultSort, stripParams, shapeOffice } from './suffolk.js';

export { McpTool };

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

// Incident free-text fields can run to several KB each; a 20-incident page is
// ~64K characters and breaks client rendering. Compact (default) responses
// truncate them; `verbose: true` returns the full text.
const INCIDENT_FREE_TEXT_FIELDS = ['description', 'remediation'];
const COMPACT_MAX_CHARS = 300;
const TRUNCATION_SUFFIX = '… [truncated — pass verbose: true for full text]';

function compactIncident(incident: Record<string, any>): Record<string, any> {
  const compact = { ...incident };
  for (const field of INCIDENT_FREE_TEXT_FIELDS) {
    const value = compact[field];
    if (typeof value !== 'string' || value.length <= COMPACT_MAX_CHARS) continue;
    const cut = value.slice(0, COMPACT_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    compact[field] = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + TRUNCATION_SUFFIX;
  }
  return compact;
}

// Per-incident compaction can't bound TOTAL size when the record count is
// unbounded (pageSize can be 100+). Compact responses additionally cap the
// serialized response text — exactly as callTool emits it — by keeping only a
// leading prefix of the incident list. Pagination metadata stays truthful
// about the server page; the message says how many incidents are shown.
export const MAX_COMPACT_RESPONSE_CHARS = 40_000;

/** Serialized size of the response exactly as callTool emits it. */
function serializedSize(message: string, result: unknown): number {
  return JSON.stringify({ message, data: result }).length;
}

function truncationMessage(shown: number, fetched: number, result: Record<string, any>): string {
  return `Retrieved incidents (showing ${shown} of ${fetched} fetched on page ` +
    `${result.currentPage || 1} of ${result.totalPages || 1}; ` +
    `response size cap — lower pageSize and use page to paginate)`;
}

/**
 * If the serialized response would exceed MAX_COMPACT_RESPONSE_CHARS, keep
 * the largest leading prefix of `result.data` that fits (always at least one
 * incident). Linear accumulation: each incident is serialized once.
 */
function applyResponseBudget(
  result: Record<string, any>,
  message: string
): { result: Record<string, any>; message: string } {
  const incidents = result.data as Record<string, any>[];
  if (incidents.length === 0 || serializedSize(message, result) <= MAX_COMPACT_RESPONSE_CHARS) {
    return { result, message };
  }

  const fetched = incidents.length;
  // Size with k incidents = size with an empty list + their serialized
  // lengths + (k - 1) commas.
  const emptyListSize = (msg: string) => serializedSize(msg, { ...result, data: [] });
  let kept = 1;
  let itemsSize = JSON.stringify(incidents[0]).length;
  for (let k = 2; k <= fetched; k++) {
    itemsSize += JSON.stringify(incidents[k - 1]).length + 1;
    if (emptyListSize(truncationMessage(k, fetched, result)) + itemsSize > MAX_COMPACT_RESPONSE_CHARS) break;
    kept = k;
  }

  return {
    result: { ...result, data: incidents.slice(0, kept) },
    message: truncationMessage(kept, fetched, result),
  };
}

export class RocketCyberToolHandler {
  private service: RocketCyberService;
  private logger: Logger;

  constructor(service: RocketCyberService, logger: Logger) {
    this.service = service;
    this.logger = logger;
  }

  async listTools(): Promise<McpTool[]> {
    this.logger.debug(`Listed ${TOOL_DEFINITIONS.length} available tools`);
    return TOOL_DEFINITIONS;
  }

  private getDispatchTable(): Map<string, (args: any) => Promise<{ result: any; message: string }>> {
    const s = this.service;
    type H = (args: any) => Promise<{ result: any; message: string }>;
    return new Map<string, H>([
      ['rocketcyber_test_connection', async () => {
        const ok = await s.testConnection();
        if (!ok) throw new Error('Connection failed: check ROCKETCYBER_API_KEY');
        return { result: { success: true }, message: 'Successfully connected to RocketCyber API' };
      }],
      ['rocketcyber_get_account', async (a) => {
        const r = await s.getAccount(a.accountId ? { accountId: a.accountId } : undefined);
        return { result: r, message: 'Account info retrieved successfully' };
      }],
      ['rocketcyber_list_agents', async (a) => {
        const r = await s.listAgents(a);
        return { result: r, message: `Retrieved agents (${r.data?.length || 0} results, page ${r.currentPage || 1} of ${r.totalPages || 1})` };
      }],
      ['rocketcyber_list_incidents', async (a) => {
        const { verbose, ...params } = a;
        const sorted = await withDefaultSort(params, DEFAULT_SORTS.incidents, p => s.listIncidents(p));
        let r = sorted.result;
        const message = `Retrieved incidents (${r.data?.length || 0} results, page ${r.currentPage || 1} of ${r.totalPages || 1})${sorted.sortNote}`;
        if (!verbose && Array.isArray(r?.data)) {
          r = { ...r, data: r.data.map(compactIncident) };
          return applyResponseBudget(r, message);
        }
        return { result: r, message };
      }],
      ['rocketcyber_list_events', async (a) => {
        // The underlying API 400s on this specific endpoint if appId is
        // missing ("appId is required") - checked here explicitly rather
        // than relying solely on inputSchema.required, since not every MCP
        // client validates a tool call's arguments against its schema
        // before sending it. Failing fast with a clear message beats a
        // caught HTTP 400 whose body (and the real reason) node-rocketcyber
        // doesn't surface to callers - see its own error handling.
        if (a?.appId === undefined || a?.appId === null) {
          throw new Error(
            'rocketcyber_list_events requires appId - call rocketcyber_list_apps to see this account\'s ' +
            'app IDs, or rocketcyber_get_event_summary (no appId needed) to see per-app event counts first.'
          );
        }
        const { result: r, sortNote } = await withDefaultSort(a, DEFAULT_SORTS.events, p => s.listEvents(p));
        return { result: r, message: `Retrieved events (${r.data?.length || 0} results, page ${r.currentPage || 1} of ${r.totalPages || 1})${sortNote}` };
      }],
      ['rocketcyber_get_event_summary', async (a) => {
        const r = await s.getEventSummary(a);
        return { result: r, message: 'Event summary retrieved successfully' };
      }],
      ['rocketcyber_list_firewalls', async (a) => {
        const r = await s.listFirewalls(a);
        return { result: r, message: `Retrieved firewalls (${r.data?.length || 0} results, page ${r.currentPage || 1} of ${r.totalPages || 1})` };
      }],
      ['rocketcyber_list_apps', async (a) => {
        const r = await s.listApps(stripParams(a, APPS_UNSUPPORTED_PARAMS));
        return { result: r, message: `Retrieved apps (${r.data?.length || 0} results, page ${r.currentPage || 1} of ${r.totalPages || 1})` };
      }],
      ['rocketcyber_get_defender', async (a) => {
        const r = await s.getDefender(a.accountId ? { accountId: a.accountId } : undefined);
        return { result: r, message: 'Defender status retrieved successfully' };
      }],
      ['rocketcyber_get_office', async (a) => {
        const r = await s.getOffice(a.accountId ? { accountId: a.accountId } : undefined);
        if (a.raw === true) return { result: r, message: 'Office 365 status (raw, uncapped)' };
        return shapeOffice(r, a);
      }],
    ]);
  }

  async callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
    this.logger.debug(`Calling tool: ${name}`, args);

    try {
      const handler = this.getDispatchTable().get(name);
      if (!handler) throw new Error(`Unknown tool: ${name}`);

      const { result, message } = await handler(args);
      const responseText = JSON.stringify({ message, data: result });

      this.logger.debug(`Successfully executed tool: ${name}`);
      return { content: [{ type: 'text', text: responseText }] };
    } catch (error) {
      this.logger.error(`Tool execution failed for ${name}:`, error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error', tool: name }) }],
        isError: true
      };
    }
  }
}
