/**
 * Suffolk additions to the RocketCyber (Kaseya MDR) tool handler:
 *  - newest-first default sort for list_incidents / list_events, with fallback
 *    if the API rejects a sort field
 *  - list_apps never forwards page/pageSize (the /apps endpoint 400s on them)
 *  - get_office summary mode, client-side filters and a response size cap
 *    (a provider-level /office call returns thousands of mailboxes, ~300K chars)
 */

/** Sort values tried in order when the caller doesn't pass `sort`. */
export const DEFAULT_SORTS: Record<'incidents' | 'events', string[]> = {
  incidents: ['createdAt:desc'],
  events: ['createdAt:desc', 'detectedAt:desc'],
};

/** Parameters the /apps endpoint rejects with 400 Bad Request. */
export const APPS_UNSUPPORTED_PARAMS = ['page', 'pageSize'];

export const OFFICE_MAX_RESPONSE_CHARS = 40_000;
export const OFFICE_DEFAULT_LIMIT = 50;

function isBadRequest(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; message?: string } | undefined;
  if (!e) return false;
  if (e.status === 400 || e.statusCode === 400) return true;
  return /bad request/i.test(e.message ?? '');
}

/**
 * Call `fetch` newest-first. If the caller passed `sort`, use it as-is. Otherwise
 * try each default sort; if the API rejects them all with 400, fall back to the
 * API's own order and say so in `sortNote` (empty when sorting worked, so
 * upstream's message format is unchanged).
 */
export async function withDefaultSort<T>(
  params: Record<string, any>,
  sorts: string[],
  fetch: (p: Record<string, any>) => Promise<T>,
): Promise<{ result: T; sortNote: string }> {
  if (params.sort) return { result: await fetch(params), sortNote: '' };
  for (const sort of sorts) {
    try {
      return { result: await fetch({ ...params, sort }), sortNote: '' };
    } catch (err) {
      if (!isBadRequest(err)) throw err;
    }
  }
  return { result: await fetch(params), sortNote: ' [API default order: the API rejected newest-first sorting]' };
}

export function stripParams(a: Record<string, any>, keys: string[]): Record<string, any> {
  const out = { ...a };
  for (const k of keys) delete out[k];
  return out;
}

// ------------------------------------------------------------------ office

type Rec = Record<string, any>;

const isPlainObject = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Find the mailbox/user records in whatever shape /office returns:
 *  - an array, or { data: [...] }, or the object's largest array property
 *  - if those records each hold their own array of objects (e.g. per-customer
 *    groups of users), flatten one level and copy the parent's scalar fields
 *    (accountId, accountName, ...) onto each child as parent_<key> unless the
 *    child already has that key.
 */
export function extractOfficeRecords(raw: unknown): { records: Rec[]; path: string } {
  let path = '(root)';
  let list: unknown[] | undefined;
  if (Array.isArray(raw)) list = raw;
  else if (isPlainObject(raw)) {
    let best: string | undefined;
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v) && (!best || v.length > (raw[best] as unknown[]).length)) best = k;
    }
    if (best) { list = raw[best] as unknown[]; path = best; }
  }
  if (!list) return { records: isPlainObject(raw) ? [raw] : [], path };

  const objs = list.filter(isPlainObject);
  // Common nested array-of-objects key present on most items?
  const counts = new Map<string, number>();
  for (const o of objs) for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.some(isPlainObject)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const nested = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (nested && nested[1] >= Math.max(1, objs.length / 2)) {
    const [key] = nested;
    const flat: Rec[] = [];
    for (const parent of objs) {
      const scalars = Object.fromEntries(Object.entries(parent).filter(([, v]) => v === null || typeof v !== 'object'));
      for (const child of (parent[key] ?? []).filter(isPlainObject)) {
        const merged: Rec = { ...child };
        for (const [k, v] of Object.entries(scalars)) if (!(k in merged)) merged[k] = v;
        flat.push(merged);
      }
    }
    return { records: flat, path: `${path}[].${key}` };
  }
  return { records: objs, path };
}

const ACCOUNT_ID_KEYS = ['accountId', 'customerId', 'account_id', 'customer_id'];
const ACCOUNT_NAME_KEYS = ['accountName', 'customerName', 'account_name', 'customer_name', 'companyName'];

function firstKey(r: Rec, keys: string[]): any {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return undefined;
}

/** Boolean-ish MFA state from any field whose name mentions mfa / multifactor / 2fa. */
export function mfaState(r: Rec): boolean | undefined {
  for (const [k, v] of Object.entries(r)) {
    if (!/mfa|multi.?factor|2fa|twofactor/i.test(k)) continue;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v > 0;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (/^(true|yes|enabled|enforced|registered|on|1)$/.test(s)) return true;
      if (/^(false|no|disabled|none|notregistered|not registered|off|0|)$/.test(s)) return false;
    }
    if (Array.isArray(v)) return v.length > 0;
  }
  return undefined;
}

export interface OfficeArgs {
  accountId?: number;
  mfa?: 'enabled' | 'disabled' | 'unknown';
  search?: string;
  summary?: boolean;
  limit?: number;
  offset?: number;
}

export function shapeOffice(raw: unknown, a: OfficeArgs): { result: Rec; message: string } {
  const { records: all, path } = extractOfficeRecords(raw);
  let recs = all;
  if (a.accountId !== undefined) {
    const hasAcct = recs.some(r => firstKey(r, ACCOUNT_ID_KEYS) !== undefined);
    if (hasAcct) recs = recs.filter(r => Number(firstKey(r, ACCOUNT_ID_KEYS)) === Number(a.accountId));
  }
  if (a.mfa) {
    recs = recs.filter(r => {
      const m = mfaState(r);
      return a.mfa === 'unknown' ? m === undefined : m === (a.mfa === 'enabled');
    });
  }
  if (a.search) {
    const q = a.search.toLowerCase();
    recs = recs.filter(r => Object.values(r).some(v => typeof v === 'string' && v.toLowerCase().includes(q)));
  }

  const filters = { accountId: a.accountId, mfa: a.mfa, search: a.search };
  const summary = a.summary ?? (a.search === undefined);

  if (summary) {
    const byAccount = new Map<string, { accountId: any; accountName: any; mailboxes: number; mfaEnabled: number; mfaDisabled: number; mfaUnknown: number }>();
    let en = 0, dis = 0, unk = 0;
    for (const r of recs) {
      const id = firstKey(r, ACCOUNT_ID_KEYS);
      const name = firstKey(r, ACCOUNT_NAME_KEYS);
      const key = String(id ?? name ?? '(none)');
      const row = byAccount.get(key) ?? { accountId: id, accountName: name, mailboxes: 0, mfaEnabled: 0, mfaDisabled: 0, mfaUnknown: 0 };
      row.mailboxes++;
      const m = mfaState(r);
      if (m === true) { row.mfaEnabled++; en++; } else if (m === false) { row.mfaDisabled++; dis++; } else { row.mfaUnknown++; unk++; }
      byAccount.set(key, row);
    }
    const accounts = [...byAccount.values()].sort((x, y) => y.mailboxes - x.mailboxes);
    const fieldNames = [...new Set(all.slice(0, 50).flatMap(r => Object.keys(r)))];
    const result = {
      summary: true,
      filters,
      totalRecords: all.length,
      matchingRecords: recs.length,
      mfa: { enabled: en, disabled: dis, unknown: unk },
      byAccount: accounts,
      recordFields: fieldNames,
      recordsPath: path,
    };
    return {
      result,
      message: `Office 365 summary: ${recs.length} of ${all.length} mailboxes match, across ${accounts.length} accounts. ` +
        'Pass summary: false (with accountId, mfa or search to narrow it down) to list the mailboxes themselves.',
    };
  }

  const offset = Math.max(0, a.offset ?? 0);
  const limit = Math.max(1, Math.min(a.limit ?? OFFICE_DEFAULT_LIMIT, 1000));
  let page = recs.slice(offset, offset + limit);
  const build = (items: Rec[], capped: boolean) => {
    const next = offset + items.length < recs.length ? offset + items.length : null;
    return {
      result: { summary: false, filters, totalRecords: all.length, matchingRecords: recs.length, offset, returned: items.length, nextOffset: next, records: items },
      message: `Office 365 mailboxes ${recs.length ? offset + 1 : 0}-${offset + items.length} of ${recs.length} matching` +
        (capped ? ' (response size cap: use nextOffset to continue, or a smaller limit)' : next !== null ? ' (use nextOffset to continue)' : ''),
    };
  };
  let out = build(page, false);
  while (page.length > 1 && JSON.stringify({ message: out.message, data: out.result }).length > OFFICE_MAX_RESPONSE_CHARS) {
    page = page.slice(0, Math.max(1, Math.floor(page.length * 0.8)));
    out = build(page, true);
  }
  return out;
}
