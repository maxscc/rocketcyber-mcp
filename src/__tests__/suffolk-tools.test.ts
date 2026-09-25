import { describe, it, expect, vi } from 'vitest';
import { RocketCyberToolHandler } from '../handlers/tool.handler.js';
import { RocketCyberService } from '../services/rocketcyber.service.js';
import { Logger } from '../utils/logger.js';
import { extractOfficeRecords, mfaState, OFFICE_MAX_RESPONSE_CHARS } from '../handlers/suffolk.js';

const logger = new Logger('error');
class BadRequest extends Error { statusCode = 400; constructor() { super('Bad request'); } }

function handlerWith(overrides: Partial<Record<keyof RocketCyberService, any>>) {
  const svc = Object.assign(Object.create(RocketCyberService.prototype), overrides) as RocketCyberService;
  return new RocketCyberToolHandler(svc, logger);
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const page = (data: unknown[] = []) => ({ data, totalCount: data.length, currentPage: 1, totalPages: 1 });

describe('Suffolk: newest-first sorting', () => {
  it('defaults incidents to createdAt:desc', async () => {
    const listIncidents = vi.fn().mockResolvedValue(page());
    await handlerWith({ listIncidents }).callTool('rocketcyber_list_incidents', { status: 'open' });
    expect(listIncidents).toHaveBeenCalledWith({ status: 'open', sort: 'createdAt:desc' });
  });

  it('keeps a caller-supplied sort', async () => {
    const listIncidents = vi.fn().mockResolvedValue(page());
    await handlerWith({ listIncidents }).callTool('rocketcyber_list_incidents', { sort: 'title:asc' });
    expect(listIncidents).toHaveBeenCalledWith({ sort: 'title:asc' });
  });

  it('events fall back through detectedAt:desc, then API order, on 400', async () => {
    const listEvents = vi.fn()
      .mockRejectedValueOnce(new BadRequest())
      .mockRejectedValueOnce(new BadRequest())
      .mockResolvedValueOnce(page([{ id: 1 }]));
    const r = await handlerWith({ listEvents }).callTool('rocketcyber_list_events', { appId: 5 });
    expect(listEvents.mock.calls.map(c => c[0])).toEqual([
      { appId: 5, sort: 'createdAt:desc' }, { appId: 5, sort: 'detectedAt:desc' }, { appId: 5 },
    ]);
    expect(body(r).message).toMatch(/API default order/);
  });

  it('does not retry on non-400 errors', async () => {
    const err = Object.assign(new Error('Access forbidden'), { statusCode: 403 });
    const listEvents = vi.fn().mockRejectedValue(err);
    const r = await handlerWith({ listEvents }).callTool('rocketcyber_list_events', { appId: 5 });
    expect(r.isError).toBe(true);
    expect(listEvents).toHaveBeenCalledTimes(1);
  });
});

describe('Suffolk: list_apps', () => {
  it('never forwards page/pageSize', async () => {
    const listApps = vi.fn().mockResolvedValue(page());
    await handlerWith({ listApps }).callTool('rocketcyber_list_apps', { page: 2, pageSize: 10, name: 'x' });
    expect(listApps).toHaveBeenCalledWith({ name: 'x' });
  });
});

const mailboxes = Array.from({ length: 2553 }, (_, i) => ({
  accountId: 100 + (i % 7),
  accountName: `Customer ${i % 7}`,
  userPrincipalName: `user${i}@customer${i % 7}.com`,
  displayName: `User Number ${i} ${'x'.repeat(60)}`,
  mfaEnabled: i % 3 !== 0,
}));

describe('Suffolk: get_office', () => {
  it('defaults to a small per-account summary', async () => {
    const getOffice = vi.fn().mockResolvedValue({ data: mailboxes });
    const r = await handlerWith({ getOffice }).callTool('rocketcyber_get_office', {});
    const d = body(r).data;
    expect(r.content[0].text.length).toBeLessThan(5000);
    expect(d.totalRecords).toBe(2553);
    expect(d.byAccount).toHaveLength(7);
    expect(d.mfa.enabled + d.mfa.disabled).toBe(2553);
  });

  it('lists filtered mailboxes, paged and capped', async () => {
    const getOffice = vi.fn().mockResolvedValue(mailboxes);
    const r = await handlerWith({ getOffice }).callTool('rocketcyber_get_office', { summary: false, mfa: 'disabled', limit: 1000 });
    const d = body(r).data;
    expect(r.content[0].text.length).toBeLessThanOrEqual(OFFICE_MAX_RESPONSE_CHARS);
    expect(d.matchingRecords).toBe(851);
    expect(d.records.every((m: any) => m.mfaEnabled === false)).toBe(true);
    expect(d.nextOffset).toBe(d.returned);
    expect(body(r).message).toMatch(/size cap/);
  });

  it('filters by accountId client-side and search lists by default', async () => {
    const getOffice = vi.fn().mockResolvedValue({ data: mailboxes });
    const r = await handlerWith({ getOffice }).callTool('rocketcyber_get_office', { accountId: 101, search: 'user8@' });
    const d = body(r).data;
    expect(getOffice).toHaveBeenCalledWith({ accountId: 101 });
    expect(d.summary).toBe(false);
    expect(d.records.map((m: any) => m.userPrincipalName)).toEqual(['user8@customer1.com']);
  });

  it('flattens per-customer groups of users', () => {
    const { records, path } = extractOfficeRecords({
      data: [
        { accountId: 1, accountName: 'A', users: [{ upn: 'a1' }, { upn: 'a2' }] },
        { accountId: 2, accountName: 'B', users: [{ upn: 'b1' }] },
      ],
    });
    expect(path).toBe('data[].users');
    expect(records).toEqual([
      { upn: 'a1', accountId: 1, accountName: 'A' }, { upn: 'a2', accountId: 1, accountName: 'A' },
      { upn: 'b1', accountId: 2, accountName: 'B' },
    ]);
  });

  it('reads MFA from assorted field shapes', () => {
    expect(mfaState({ mfaEnabled: true })).toBe(true);
    expect(mfaState({ MFAStatus: 'Disabled' })).toBe(false);
    expect(mfaState({ strongAuthenticationMethods: [], mfaMethods: ['app'] })).toBe(true);
    expect(mfaState({ upn: 'x' })).toBeUndefined();
  });

  it('raw: true returns the API response untouched', async () => {
    const raw = { data: mailboxes.slice(0, 3) };
    const getOffice = vi.fn().mockResolvedValue(raw);
    const r = await handlerWith({ getOffice }).callTool('rocketcyber_get_office', { raw: true });
    expect(body(r).data).toEqual(raw);
  });

  describe('real /office shape (secureScoreProgress, monitoredAccounts, secureScoreToDo, accountIdToNameMap)', () => {
    const top = (monitoredAccounts: unknown) => ({
      secureScoreProgress: { current: 41, max: 80 },
      secureScoreToDo: { items: 3 },
      accountIdToNameMap: { '122551': 'Acme Corp', '122552': 'Beta LLC' },
      monitoredAccounts,
    });

    it('reads users from monitoredAccounts keyed by account ID (array values)', async () => {
      const raw = top({
        '122551': [{ userPrincipalName: 'a@acme.com', mfaEnabled: true }, { userPrincipalName: 'b@acme.com', mfaEnabled: false }],
        '122552': [{ userPrincipalName: 'c@beta.com', mfaEnabled: false }],
      });
      const getOffice = vi.fn().mockResolvedValue(raw);
      const h = handlerWith({ getOffice });
      const d = body(await h.callTool('rocketcyber_get_office', {})).data;
      expect(d.totalRecords).toBe(3);
      expect(d.recordsPath).toBe('monitoredAccounts.{id}[]');
      expect(d.byAccount).toEqual([
        { accountId: 122551, accountName: 'Acme Corp', mailboxes: 2, mfaEnabled: 1, mfaDisabled: 1, mfaUnknown: 0 },
        { accountId: 122552, accountName: 'Beta LLC', mailboxes: 1, mfaEnabled: 0, mfaDisabled: 1, mfaUnknown: 0 },
      ]);
      const f = body(await h.callTool('rocketcyber_get_office', { accountId: 122551, summary: false, mfa: 'disabled' })).data;
      expect(f.filters.accountId).toBe(122551);
      expect(f.records).toEqual([{ userPrincipalName: 'b@acme.com', mfaEnabled: false, accountId: 122551, accountName: 'Acme Corp' }]);
    });

    it('reads users nested one level under each account ID', () => {
      const { records, path } = extractOfficeRecords(top({
        '122551': { total: 1, users: [{ upn: 'a@acme.com' }] },
      }));
      expect(path).toBe('monitoredAccounts.{id}.users[]');
      expect(records).toEqual([{ total: 1, upn: 'a@acme.com', accountId: 122551, accountName: 'Acme Corp' }]);
    });

    it('reads a plain array, filling names from accountIdToNameMap', () => {
      const { records } = extractOfficeRecords({ data: top([{ accountId: '122552', upn: 'c@beta.com' }]) });
      expect(records).toEqual([{ accountId: '122552', upn: 'c@beta.com', accountName: 'Beta LLC' }]);
    });

    it('never counts the whole response as one mailbox; reports the shape instead', async () => {
      const getOffice = vi.fn().mockResolvedValue(top(12));
      const r = body(await handlerWith({ getOffice }).callTool('rocketcyber_get_office', {}));
      expect(r.data.totalRecords).toBe(0);
      expect(r.data.responseShape).toHaveProperty('monitoredAccounts', 'number');
    });
  });
});
