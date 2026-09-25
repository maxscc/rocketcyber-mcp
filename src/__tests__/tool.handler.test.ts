/**
 * Tests for rocketcyber_list_incidents compact/verbose response mode.
 *
 * A 20-incident page with full `description`/`remediation` free-text is ~64K
 * characters and breaks client rendering. Default responses truncate those
 * fields; `verbose: true` restores today's byte-for-byte behavior.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { RocketCyberToolHandler } from "../handlers/tool.handler.js";
import { RocketCyberService } from "../services/rocketcyber.service.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("error");

const TRUNCATION_SUFFIX = "… [truncated — pass verbose: true for full text]";

// Deterministic word-based free text, comfortably longer than 300 characters.
const LONG_DESCRIPTION = "alpha bravo charlie delta echo foxtrot golf hotel ".repeat(12).trim();
const LONG_REMEDIATION = "india juliett kilo lima mike november oscar papa ".repeat(12).trim();

function incidentsResponse() {
  return {
    data: [
      {
        id: 101,
        title: "Suspicious login detected",
        description: LONG_DESCRIPTION,
        remediation: LONG_REMEDIATION,
        status: "open",
        severity: "high",
        accountId: 42,
        eventCount: 7,
        affectedDevices: ["WS-01", "WS-02"],
        createdAt: "2026-07-01T00:00:00Z",
      },
      {
        id: 102,
        title: "Malware quarantined",
        description: "Short summary.",
        remediation: "No action needed.",
        status: "resolved",
        severity: "low",
        accountId: 42,
      },
    ],
    totalCount: 40,
    currentPage: 3,
    totalPages: 2,
  };
}

function makeHandler(response: unknown) {
  const listIncidents = vi.fn().mockResolvedValue(response);
  const service = { listIncidents } as unknown as RocketCyberService;
  return { handler: new RocketCyberToolHandler(service, logger), listIncidents };
}

async function callListIncidents(
  handler: RocketCyberToolHandler,
  args: Record<string, any>
): Promise<{ message: string; data: any }> {
  const result = await handler.callTool("rocketcyber_list_incidents", args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

/** Strip the truncation suffix and return the kept text. */
function keptText(value: string): string {
  expect(value.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  return value.slice(0, -TRUNCATION_SUFFIX.length);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rocketcyber_list_incidents compact mode (default)", () => {
  it("truncates long description and remediation at a word boundary with the marker", async () => {
    const { handler } = makeHandler(incidentsResponse());
    const body = await callListIncidents(handler, {});
    const incident = body.data.data[0];

    for (const [field, original] of [
      ["description", LONG_DESCRIPTION],
      ["remediation", LONG_REMEDIATION],
    ] as const) {
      const kept = keptText(incident[field]);
      expect(kept.length).toBeLessThanOrEqual(300);
      // Cut lands on a word boundary: kept text is a prefix of the original
      // and the very next character in the original is a space.
      expect(original.startsWith(kept)).toBe(true);
      expect(original[kept.length]).toBe(" ");
    }
  });

  it("keeps every other incident field untouched", async () => {
    const { handler } = makeHandler(incidentsResponse());
    const body = await callListIncidents(handler, {});
    const { description, remediation, ...rest } = body.data.data[0];
    const { description: _d, remediation: _r, ...expected } = incidentsResponse().data[0];
    expect(rest).toEqual(expected);
  });

  it("passes short free-text values through untouched", async () => {
    const { handler } = makeHandler(incidentsResponse());
    const body = await callListIncidents(handler, {});
    expect(body.data.data[1]).toEqual(incidentsResponse().data[1]);
  });

  it("preserves response-level metadata and the message string", async () => {
    const { handler } = makeHandler(incidentsResponse());
    const body = await callListIncidents(handler, {});
    expect(body.data.totalCount).toBe(40);
    expect(body.data.currentPage).toBe(3);
    expect(body.data.totalPages).toBe(2);
    expect(body.message).toBe("Retrieved incidents (2 results, page 3 of 2)");
  });
});

describe("rocketcyber_list_incidents verbose mode", () => {
  it("verbose: true returns today's response byte-for-byte", async () => {
    const response = incidentsResponse();
    const { handler } = makeHandler(response);
    const result = await handler.callTool("rocketcyber_list_incidents", { verbose: true });
    expect(result.content[0].text).toBe(
      JSON.stringify({
        message: "Retrieved incidents (2 results, page 3 of 2)",
        data: response,
      })
    );
  });
});

describe("rocketcyber_list_incidents tool definition", () => {
  it("declares the verbose parameter and documents the default-compact behavior", async () => {
    const { TOOL_DEFINITIONS } = await import("../handlers/tool.definitions.js");
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "rocketcyber_list_incidents")!;
    expect(tool.inputSchema.properties.verbose).toMatchObject({ type: "boolean" });
    expect(tool.inputSchema.properties.verbose.description).toMatch(/full|untruncated/i);
    expect(tool.description).toMatch(/truncat/i);
  });
});

// Compact mode caps the TOTAL serialized response (exactly as callTool emits
// it) by keeping only a leading prefix of the incident list. Per-record
// truncation alone can't bound total size when the record count is unbounded.
const RESPONSE_BUDGET = 40_000;

/**
 * A server page of `count` incidents that is well over the response budget
 * even after per-incident compaction (~1.2KB each compacted). Ids are all
 * 3-digit so every serialized incident has an identical length.
 */
function bigIncidentsResponse(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => ({
      id: 100 + i,
      title: "Suspicious activity detected on monitored endpoint host",
      description: LONG_DESCRIPTION,
      remediation: LONG_REMEDIATION,
      status: "open",
      severity: "high",
      accountId: 42,
      eventCount: 7,
      affectedDevices: ["WS-01", "WS-02"],
      createdAt: "2026-07-01T00:00:00Z",
      details: "x".repeat(400),
    })),
    totalCount: 7900,
    dataCount: count,
    currentPage: 1,
    totalPages: 79,
  };
}

describe("rocketcyber_list_incidents response byte budget (compact mode)", () => {
  it("leaves under-budget responses untouched with today's message format", async () => {
    const { handler } = makeHandler(incidentsResponse());
    const body = await callListIncidents(handler, {});
    expect(body.data.data).toHaveLength(2);
    expect(body.message).toBe("Retrieved incidents (2 results, page 3 of 2)");
  });

  it("caps the serialized response by keeping only a leading prefix of incidents", async () => {
    const { handler } = makeHandler(bigIncidentsResponse(100));
    const result = await handler.callTool("rocketcyber_list_incidents", { pageSize: 100 });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text.length).toBeLessThanOrEqual(RESPONSE_BUDGET);

    const body = JSON.parse(text);
    const shown = body.data.data.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    // Kept incidents are the FIRST `shown` of the server page, in order.
    expect(body.data.data.map((i: any) => i.id)).toEqual(
      Array.from({ length: shown }, (_, i) => 100 + i)
    );
    expect(body.message).toBe(
      `Retrieved incidents (showing ${shown} of 100 fetched on page 1 of 79; ` +
        `response size cap — lower pageSize and use page to paginate)`
    );
  });

  it("fills the budget tightly: keeping one more incident would overflow", async () => {
    const { handler } = makeHandler(bigIncidentsResponse(100));
    const result = await handler.callTool("rocketcyber_list_incidents", { pageSize: 100 });
    const text = result.content[0].text;
    const body = JSON.parse(text);
    // Every incident serializes to the same length, so one more incident
    // would add exactly (item + comma) characters.
    const itemSize = JSON.stringify(body.data.data[0]).length;
    expect(text.length + itemSize + 1).toBeGreaterThan(RESPONSE_BUDGET);
  });

  it("leaves server-page pagination metadata untouched when truncating", async () => {
    const { handler } = makeHandler(bigIncidentsResponse(100));
    const body = await callListIncidents(handler, { pageSize: 100 });
    expect(body.data.totalCount).toBe(7900);
    expect(body.data.dataCount).toBe(100);
    expect(body.data.currentPage).toBe(1);
    expect(body.data.totalPages).toBe(79);
  });

  it("keeps at least one incident even when a single incident exceeds the budget", async () => {
    const huge = (id: number) => ({ id, title: "Huge", details: "y".repeat(45_000) });
    const response = {
      data: [huge(1), huge(2), huge(3)],
      totalCount: 3,
      currentPage: 1,
      totalPages: 1,
    };
    const { handler } = makeHandler(response);
    const body = await callListIncidents(handler, {});
    expect(body.data.data).toHaveLength(1);
    expect(body.data.data[0].id).toBe(1);
    expect(body.message).toBe(
      "Retrieved incidents (showing 1 of 3 fetched on page 1 of 1; " +
        "response size cap — lower pageSize and use page to paginate)"
    );
  });

  it("verbose mode is unaffected byte-for-byte even when over budget", async () => {
    const response = bigIncidentsResponse(100);
    const { handler } = makeHandler(response);
    const result = await handler.callTool("rocketcyber_list_incidents", { verbose: true, pageSize: 100 });
    expect(result.content[0].text).toBe(
      JSON.stringify({
        message: "Retrieved incidents (100 results, page 1 of 79)",
        data: response,
      })
    );
  });

  it("documents the size cap in the tool description", async () => {
    const { TOOL_DEFINITIONS } = await import("../handlers/tool.definitions.js");
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "rocketcyber_list_incidents")!;
    expect(tool.description).toMatch(/size cap|capped/i);
    expect(tool.description).toMatch(/page/i);
  });
});

describe("rocketcyber_list_incidents verbose stripping", () => {
  it("strips verbose from the service call arguments", async () => {
    const { handler, listIncidents } = makeHandler(incidentsResponse());
    await callListIncidents(handler, { verbose: true, status: "open", page: 2 });
    expect(listIncidents).toHaveBeenCalledWith({ status: "open", page: 2, sort: "createdAt:desc" });
  });

  it("never leaks verbose into the RocketCyber HTTP query params", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        requestedUrls.push(String(url));
        return new Response(JSON.stringify(incidentsResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const service = new RocketCyberService(
      { name: "test", version: "0", rocketcyber: { apiKey: "test-key", region: "us" } },
      logger
    );
    const handler = new RocketCyberToolHandler(service, logger);
    await callListIncidents(handler, { verbose: true, status: "open" });

    expect(requestedUrls).toHaveLength(1);
    const url = new URL(requestedUrls[0]);
    expect(url.searchParams.has("verbose")).toBe(false);
    expect(url.searchParams.get("status")).toBe("open");
  });
});

function eventsResponse() {
  return {
    data: [{ id: 1, appId: 34, title: "Malicious file blocked" }],
    totalCount: 1,
    currentPage: 1,
    totalPages: 1,
  };
}

function makeEventsHandler(response: unknown) {
  const listEvents = vi.fn().mockResolvedValue(response);
  const service = { listEvents } as unknown as RocketCyberService;
  return { handler: new RocketCyberToolHandler(service, logger), listEvents };
}

describe("rocketcyber_list_events appId requirement", () => {
  it("rejects a call with no appId before reaching the service", async () => {
    const { handler, listEvents } = makeEventsHandler(eventsResponse());
    const result = await handler.callTool("rocketcyber_list_events", {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/appId/);
    expect(body.error).toMatch(/rocketcyber_list_apps/);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("rejects appId: null the same way as a missing appId", async () => {
    const { handler, listEvents } = makeEventsHandler(eventsResponse());
    const result = await handler.callTool("rocketcyber_list_events", { appId: null });
    expect(result.isError).toBe(true);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("calls through to the service when appId is provided", async () => {
    const { handler, listEvents } = makeEventsHandler(eventsResponse());
    const result = await handler.callTool("rocketcyber_list_events", { appId: 34, page: 2 });
    expect(result.isError).toBeUndefined();
    expect(listEvents).toHaveBeenCalledWith({ appId: 34, page: 2, sort: "createdAt:desc" });
    const body = JSON.parse(result.content[0].text);
    expect(body.message).toBe("Retrieved events (1 results, page 1 of 1)");
  });

  it("treats appId: 0 as a valid, provided value", async () => {
    const { handler, listEvents } = makeEventsHandler(eventsResponse());
    const result = await handler.callTool("rocketcyber_list_events", { appId: 0 });
    expect(result.isError).toBeUndefined();
    expect(listEvents).toHaveBeenCalledWith({ appId: 0, sort: "createdAt:desc" });
  });
});

describe("rocketcyber_list_events tool definition", () => {
  it("declares appId as required and documents why", async () => {
    const { TOOL_DEFINITIONS } = await import("../handlers/tool.definitions.js");
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "rocketcyber_list_events")!;
    expect(tool.inputSchema.required).toEqual(["appId"]);
    expect(tool.inputSchema.properties.appId).toMatchObject({ type: "number" });
    expect(tool.description).toMatch(/appId/);
  });
});
