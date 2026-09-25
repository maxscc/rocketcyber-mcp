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

const isIdKey = (k: string) => /^\d+$/.test(k);

/** Numeric-looking IDs become numbers so filters and grouping agree. */
export function normId(v: unknown): unknown {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
  return v;
}

/** Largest array of objects directly inside `o` (not nested deeper). */
function largestObjArray(o: Rec): [string, Rec[]] | undefined {
  let best: [string, Rec[]] | undefined;
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.some(isPlainObject) && (!best || v.length > best[1].length)) best = [k, v.filter(isPlainObject)];
  }
  return best;
}

function scalarsOf(o: Rec): Rec {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || typeof v !== 'object'));
}

/** Flatten a list whose items each carry their own array of users; copy parent scalars down. */
function flattenGroups(items: Rec[], path: string): { records: Rec[]; path: string } {
  const counts = new Map<string, number>();
  for (const o of items) for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.some(isPlainObject)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const nested = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!nested || nested[1] < Math.max(1, items.length / 2)) return { records: items, path };
  const [key] = nested;
  const flat: Rec[] = [];
  for (const parent of items) {
    const sc = scalarsOf(parent);
    for (const child of (parent[key] ?? []).filter(isPlainObject)) {
      const merged: Rec = { ...child };
      for (const [k, v] of Object.entries(sc)) if (!(k in merged)) merged[k] = v;
      flat.push(merged);
    }
  }
  return { records: flat, path: `${path}[].${key}` };
}

/**
 * Normalize RocketCyber's `monitoredAccounts`. Handles:
 *  - an array of users, or of per-account groups holding a users array
 *  - an object keyed by account ID whose values are a users array, an object
 *    holding a users array, or a single per-account record
 *  - an object keyed by something else (e.g. UPN) whose values are users
 * Account names come from the sibling `accountIdToNameMap` when present.
 */
function fromMonitored(ma: unknown, nameMap: Rec, path: string): { records: Rec[]; path: string } {
  const withName = (r: Rec, id?: unknown): Rec => {
    const out: Rec = { ...r };
    if (id !== undefined && out.accountId === undefined) out.accountId = normId(id);
    const aid = out.accountId ?? out.customerId;
    if (out.accountName === undefined && aid !== undefined && nameMap[String(aid)] !== undefined) out.accountName = nameMap[String(aid)];
    return out;
  };
  if (Array.isArray(ma)) {
    const f = flattenGroups(ma.filter(isPlainObject), path);
    return { records: f.records.map(r => withName(r)), path: f.path };
  }
  if (!isPlainObject(ma)) return { records: [], path };
  const entries = Object.entries(ma);
  const idKeyed = entries.length > 0 && entries.every(([k]) => isIdKey(k));
  const out: Rec[] = [];
  let sub = '';
  for (const [k, v] of entries) {
    const id = idKeyed ? k : undefined;
    if (Array.isArray(v)) {
      for (const u of v.filter(isPlainObject)) out.push(withName(u, id));
      sub = '{id}[]';
    } else if (isPlainObject(v)) {
      const arr = largestObjArray(v);
      if (arr) {
        const sc = scalarsOf(v);
        for (const u of arr[1]) out.push(withName({ ...sc, ...u }, id));
        sub = `{id}.${arr[0]}[]`;
      } else {
        out.push(withName(idKeyed ? v : { key: k, ...v }, id));
        sub = idKeyed ? '{id}' : '{key}';
      }
    }
  }
  return { records: out, path: `${path}.${sub}` };
}

/** Find `monitoredAccounts` at the root, under `data`, or in the first element of either. */
function locateMonitored(raw: unknown): { ma: unknown; nameMap: Rec; path: string } | undefined {
  const candidates: [unknown, string][] = [[raw, '']];
  if (isPlainObject(raw) && raw.data !== undefined) candidates.push([raw.data, 'data']);
  for (const [c, p] of [...candidates]) if (Array.isArray(c) && isPlainObject(c[0])) candidates.push([c[0], `${p}[0]`]);
  for (const [c, p] of candidates) {
    if (isPlainObject(c) && c.monitoredAccounts !== undefined) {
      const nameMap = isPlainObject(c.accountIdToNameMap) ? c.accountIdToNameMap : {};
      return { ma: c.monitoredAccounts, nameMap, path: p ? `${p}.monitoredAccounts` : 'monitoredAccounts' };
    }
  }
  return undefined;
}

/** Small structural description of a value (types, keys, array lengths) for diagnosis. */
export function describeShape(v: unknown, depth = 3): unknown {
  if (Array.isArray(v)) return depth > 0 && v.length ? [`array(${v.length})`, describeShape(v[0], depth - 1)] : `array(${v.length})`;
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (depth <= 0) return `object(${keys.length} keys)`;
    if (keys.length > 8 && keys.every(isIdKey)) return { [`{${keys.length} numeric keys, e.g. ${keys[0]}}`]: describeShape(v[keys[0]], depth - 1) };
    const out: Rec = {};
    for (const k of keys.slice(0, 25)) out[k] = describeShape(v[k], depth - 1);
    if (keys.length > 25) out['…'] = `${keys.length - 25} more keys`;
    return out;
  }
  return v === null ? 'null' : typeof v;
}

/**
 * Find the mailbox/user records in the /office response. Prefers
 * `monitoredAccounts` (RocketCyber's per-user list); otherwise the largest
 * array of objects at the root / under `data`, flattening per-account groups.
 */
export function extractOfficeRecords(raw: unknown): { records: Rec[]; path: string } {
  const mon = locateMonitored(raw);
  if (mon) {
    const r = fromMonitored(mon.ma, mon.nameMap, mon.path);
    if (r.records.length) return r;
  }
  let path = '(root)';
  let list: Rec[] | undefined;
  if (Array.isArray(raw)) list = raw.filter(isPlainObject);
  else if (isPlainObject(raw)) {
    const best = largestObjArray(raw);
    if (best) { list = best[1]; path = best[0]; }
  }
  if (!list) return { records: [], path: 'none' };
  return flattenGroups(list, path);
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
  if (!all.length) {
    return {
      result: { summary: true, totalRecords: 0, recordsPath: path, responseShape: describeShape(raw) },
      message: 'Office 365: no per-user records found in the API response; responseShape shows its structure.',
    };
  }
  let recs = all;
  if (a.accountId !== undefined) {
    const hasAcct = recs.some(r => firstKey(r, ACCOUNT_ID_KEYS) !== undefined);
    if (hasAcct) recs = recs.filter(r => normId(firstKey(r, ACCOUNT_ID_KEYS)) === Number(a.accountId));
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

  const filters = { accountId: a.accountId === undefined ? undefined : Number(a.accountId), mfa: a.mfa, search: a.search };
  const summary = a.summary ?? (a.search === undefined);

  if (summary) {
    const byAccount = new Map<string, { accountId: any; accountName: any; mailboxes: number; mfaEnabled: number; mfaDisabled: number; mfaUnknown: number }>();
    let en = 0, dis = 0, unk = 0;
    for (const r of recs) {
      const id = normId(firstKey(r, ACCOUNT_ID_KEYS));
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
      ...(all.length <= 1 ? { responseShape: describeShape(raw) } : {}),
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
