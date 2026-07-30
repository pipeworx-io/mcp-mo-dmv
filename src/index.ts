interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Missouri DMV MCP — the Department of Revenue's driver and motor-vehicle license offices,
 * with hours, the contract agent who runs each office, and the upcoming dates each office is
 * closed. Keyless.
 *
 * One pack per state agency: Missouri does not run its own counters. The Department of Revenue
 * contracts all 176 "license offices" out to private agents, so the useful columns here —
 * `agent`, `officemanager`, `additionaldaysclosed` — have no analogue in California's field-office
 * directory or New York's office file, and a shared schema would drop them.
 *
 * Source (verified live 2026-07-30):
 *   data.mo.gov Socrata 835g-7keg — "Missouri Department of Revenue Driver and Motor Vehicle
 *   License Offices". Refreshed daily, which makes it the freshest office feed any US state
 *   publishes: the closure dates in `additionaldaysclosed` are current enough to plan a visit
 *   around.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-mo-dmv/1.0 (+https://pipeworx.io)';
const DOMAIN = 'data.mo.gov';
const OFFICES = '835g-7keg';

const tools: McpToolExport['tools'] = [
  {
    name: 'mo_dmv_license_offices',
    description:
      'Find a Missouri license office — the Department of Revenue counters Missourians use as the DMV, for driver licenses, ID cards, license plates, titles and registration renewal. Returns street address, phone, the days and hours each office is open, coordinates, the contract agent and office manager who run it, and the upcoming dates it will be closed. Missouri refreshes this file daily, so it answers "is the Columbia license office closed next week", "DMV office in Springfield MO", "license office hours in ZIP 63101", and "who runs the license bureau in Potosi". Covers all 176 offices statewide.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Columbia", "Springfield", "Kansas City".' },
        name: { type: 'string', description: 'Office-name substring, e.g. "Columbia South", "Potosi".' },
        zip: { type: 'string', description: 'Five-digit Missouri ZIP code, or a prefix, e.g. "63101" or "631".' },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 50, max 200).' },
      },
    },
  },
];

interface MoRow {
  number?: string;
  type?: string;
  name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  county?: string;
  located_in?: string;
  phone?: string;
  fax?: string;
  size?: string;
  email?: string;
  agent?: string;
  officemanager?: string;
  contractmanager?: string;
  daysopen?: string;
  daysclosed?: string;
  holidaysclosed?: string;
  additionaldaysclosed?: string;
  remarks?: string;
  latlng?: { latitude?: string; longitude?: string };
  facebook_url?: string;
  twitter_url?: string;
  textingphonenumber?: string;
  managercontactnumber?: string;
  managercontactnumber2?: string;
  othercontactinfo?: string;
  additional_license_office_info?: string;
}

/** `type` is "1MV" on every row today — every office does both licensing and motor vehicle. */
function officeType(code: string | undefined): string {
  return code ? `License office (${code})` : 'License office';
}

/** Split the comma-separated closure list, keeping the "Closed Partial Day AM" qualifiers. */
function closureList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function licenseOffices(args: Record<string, unknown>): Promise<unknown> {
  // Concurrent, not sequential: Socrata throttles unauthenticated bursts and soqlUpdatedAt
  // never retries, so a follow-up call can lose `as_of` — and on a file whose selling point
  // is a daily refresh, the refresh date is not an optional field.
  const [rows, asOf] = await Promise.all([
    soqlRows<MoRow>(DOMAIN, OFFICES, { limit: 1000 }, { userAgent: UA }),
    soqlUpdatedAt(DOMAIN, OFFICES, { userAgent: UA }),
  ]);
  if (!rows.length) {
    return govNotFound(
      'upstream_empty',
      'data.mo.gov returned no license offices; retry once — the dataset itself is refreshed daily and is not normally empty.',
    );
  }

  const city = govString(args, 'city');
  const name = govString(args, 'name');
  const zip = govString(args, 'zip');
  let list = rows;
  if (city) list = list.filter((r) => govContains(r.city, city));
  if (name) list = list.filter((r) => govContains(r.name, name));
  if (zip) list = list.filter((r) => (r.zipcode ?? '').startsWith(zip));

  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      `No Missouri license office matched those filters. Missouri names offices after the town, so try city="Columbia" or name="Springfield", or call with no arguments for all ${rows.length} offices.`,
      { filters_applied: { city, name, zip }, total_offices: rows.length },
    );
  }

  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'MO',
    agency: 'Missouri Department of Revenue',
    source: 'data.mo.gov — Missouri Department of Revenue Driver and Motor Vehicle License Offices (835g-7keg)',
    as_of: asOf,
    office_count: list.length,
    truncated: list.length > limit,
    offices: list.slice(0, limit).map((r) => ({
      state: 'MO',
      name: r.name ?? '',
      office_type: officeType(r.type),
      address: [r.address1, r.address2].filter(Boolean).join(', ') || null,
      city: r.city ?? null,
      // The `county` column exists upstream but is empty on every row; do not invent one.
      county: r.county ?? null,
      zip: r.zipcode ?? null,
      phone: r.phone ?? null,
      hours: r.daysopen ?? null,
      latitude: govNumber(r.latlng?.latitude),
      longitude: govNumber(r.latlng?.longitude),
      services: ['driver license', 'ID card', 'license plates', 'title', 'registration renewal'],
      url: r.facebook_url ?? null,
      office_number: r.number ?? null,
      // Missouri outsources every office to a private contract agent, so who runs it is
      // real context: hours, closures and phone numbers follow the agent, not the state.
      agent: r.agent ?? null,
      office_manager: r.officemanager ?? null,
      contract_manager: r.contractmanager ?? null,
      email: r.email ?? null,
      fax: r.fax ?? null,
      days_closed: r.daysclosed ?? null,
      holidays_closed: r.holidaysclosed ?? null,
      additional_days_closed: closureList(r.additionaldaysclosed),
      manager_contact_number: r.managercontactnumber ?? null,
      other_contact_info: r.othercontactinfo ?? null,
      texting_phone_number: r.textingphonenumber ?? null,
      located_in: r.located_in ?? null,
      remarks: r.remarks ?? null,
    })),
    note: 'additional_days_closed lists upcoming one-off closures ahead of the published holiday list, and an entry can be a partial day ("6/22/2026 Closed Partial Day PM"). Missouri leaves the `county` column empty on every row, so filter by city instead.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'mo_dmv_license_offices': return await licenseOffices(args);
      default:
        return govNotFound('unknown_tool', `mo-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `mo-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.mo.gov timed out. Retry once — the whole file is only 176 rows, so a stall is transient rather than a size problem.'
        : 'data.mo.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new Socrata id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
