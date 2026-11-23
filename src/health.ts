import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { z } from 'zod';

export class HealthError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'HealthError';
  }
}

const kinds = ['apple_xml', 'health_auto_export', 'generic'] as const;
const metrics = ['steps', 'active_energy', 'basal_energy', 'weight', 'sleep', 'workout'] as const;
export type HealthMetric = typeof metrics[number];
type SourceKind = typeof kinds[number];
const text = z.string().trim().min(1).max(256);
const idSchema = z.uuid();
const quantity = z.number().finite().min(0).max(1e12);
const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const jsonLimit = 2 * 1024 * 1024;
const xmlLimit = 20 * 1024 * 1024;
const recordLimit = 100_000;
const units: Record<HealthMetric, string> = {
  steps: 'count', active_energy: 'kcal', basal_energy: 'kcal', weight: 'kg', sleep: 'hr', workout: 'min',
};
const xmlMetrics: Record<string, HealthMetric> = {
  HKQuantityTypeIdentifierStepCount: 'steps',
  HKQuantityTypeIdentifierActiveEnergyBurned: 'active_energy',
  HKQuantityTypeIdentifierBasalEnergyBurned: 'basal_energy',
  HKQuantityTypeIdentifierBodyMass: 'weight',
  HKCategoryTypeIdentifierSleepAnalysis: 'sleep',
};
const autoMetrics: Record<string, HealthMetric> = {
  step_count: 'steps', active_energy: 'active_energy', basal_energy_burned: 'basal_energy',
  'weight_&_body_mass': 'weight', sleep_analysis: 'sleep',
};
const sleepStates = new Set(['HKCategoryValueSleepAnalysisAsleep', 'HKCategoryValueSleepAnalysisAsleepUnspecified',
  'HKCategoryValueSleepAnalysisAsleepCore', 'HKCategoryValueSleepAnalysisAsleepDeep', 'HKCategoryValueSleepAnalysisAsleepREM']);
const otherSleepStates = new Set(['HKCategoryValueSleepAnalysisInBed', 'HKCategoryValueSleepAnalysisAwake']);

function invalid(code = 'INVALID_HEALTH_PAYLOAD', message = '健康数据格式、时间或数值不符合接入契约。'): never {
  throw new HealthError(400, code, message);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalid();
  return result.data;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function boundedJson(payload: unknown): void {
  // HTTP inputs are JSON; also make direct callers reject cycles, BigInts and excess nesting safely.
  const seen = new WeakSet<object>();
  let nodes = 0;
  function walk(value: unknown, depth: number): void {
    if (++nodes > 300_000 || depth > 12) invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)) invalid();
    seen.add(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    for (const item of Object.values(value)) walk(item, depth + 1);
    seen.delete(value);
  }
  walk(payload, 0);
  if (Buffer.byteLength(JSON.stringify(payload)) > jsonLimit) throw new HealthError(413, 'PAYLOAD_TOO_LARGE', '健康 JSON 超过 2 MiB。');
}
function day(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) invalid();
  const date = new Date(`${input}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input || input < '0001-01-01') invalid();
  return input;
}
function timestamp(input: unknown): string {
  if (typeof input !== 'string' || input.length > 40) invalid();
  // Accept RFC3339 and Apple's/HAE's documented yyyy-MM-dd HH:mm:ss Z. Never infer a timezone.
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})? ?(Z|[+-]\d{2}:?\d{2})$/.exec(input);
  if (!match) invalid();
  day(match[1]);
  if (+match[2] > 23 || +match[3] > 59 || +match[4] > 59) invalid();
  let offset = match[6];
  if (offset !== 'Z') {
    offset = offset.replace(':', '');
    if (+offset.slice(1, 3) > 14 || +offset.slice(3) > 59 || (+offset.slice(1, 3) === 14 && +offset.slice(3) !== 0)) invalid();
    offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] ?? ''}${offset}`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) invalid();
  return date.toISOString();
}
function normalize(metric: HealthMetric, value: unknown, unit: unknown): number {
  const amount = parse(quantity, value);
  if (typeof unit !== 'string') invalid();
  const conversions: Record<HealthMetric, Record<string, number>> = {
    steps: { count: 1 }, active_energy: { kcal: 1, kJ: 1 / 4.184 }, basal_energy: { kcal: 1, kJ: 1 / 4.184 },
    weight: { kg: 1, g: 0.001, lb: 0.45359237 }, sleep: { hr: 1, h: 1, min: 1 / 60, s: 1 / 3600 },
    workout: { min: 1, hr: 60, h: 60, s: 1 / 60 },
  };
  if (!Object.hasOwn(conversions[metric], unit)) invalid();
  const result = amount * conversions[metric][unit];
  if (!Number.isFinite(result) || result > 1e12 || (metric === 'weight' && result <= 0)) invalid();
  return result;
}
function xmlNumber(input: unknown): number {
  if (typeof input !== 'string' || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(input)) invalid();
  return parse(quantity, Number(input));
}

// Saxes parses the XML and delivers the internal subset as inert text. Accept only Apple's
// structural declarations; never register entities, apply defaults, or resolve a resource.
function validateHealthDoctype(declaration: string): void {
  if (declaration.length > 65_536) invalid('UNSAFE_XML');
  let rest = declaration.trim();
  if (rest === 'HealthData') return;
  if (!/^HealthData\s*\[/.test(rest)) invalid('UNSAFE_XML');
  rest = rest.slice(rest.indexOf('[') + 1).trimStart();
  while (!rest.startsWith(']')) {
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0 || rest.slice(4, end).includes('--')) invalid('UNSAFE_XML');
      rest = rest.slice(end + 3).trimStart();
      continue;
    }
    // No quoted literals, parameter references, external IDs, ENTITY, NOTATION or conditional sections.
    const element = /^<!ELEMENT\s+[A-Za-z_][\w.-]*\s+(?:EMPTY|\([A-Za-z0-9_,|()?*+\s.-]+\)[?*+]?)\s*>/.exec(rest);
    const attributes = /^<!ATTLIST\s+[A-Za-z_][\w.-]*(?:\s+[A-Za-z_][\w.-]*\s+CDATA\s+#(?:REQUIRED|IMPLIED))+\s*>/.exec(rest);
    const allowed = element ?? attributes;
    if (!allowed) invalid('UNSAFE_XML', 'XML 声明包含不支持的实体、外部引用或结构。');
    rest = rest.slice(allowed[0].length).trimStart();
  }
  if (rest.trim() !== ']') invalid('UNSAFE_XML');
}

/** Shared secure SAX boundary for bounded HTTP imports and the local streaming CLI. */
export function createHealthXmlParser(handlers: {
  open?: (tag: SaxesTagPlain, depth: number) => void;
  close?: (tag: SaxesTagPlain, depth: number) => void;
} = {}) {
  const stack: string[] = [];
  const children: Record<string, string[]> = {
    HealthData: ['ExportDate', 'Me', 'Record', 'Workout', 'Correlation', 'ActivitySummary', 'ClinicalRecord', 'Audiogram'],
    Audiogram: ['MetadataEntry', 'SensitivityPoint'], Record: ['MetadataEntry', 'HeartRateVariabilityMetadataList'],
    HeartRateVariabilityMetadataList: ['InstantaneousBeatsPerMinute'],
    Workout: ['MetadataEntry', 'WorkoutStatistics', 'WorkoutEvent', 'WorkoutRoute', 'WorkoutActivity'],
    WorkoutActivity: ['MetadataEntry', 'WorkoutStatistics', 'WorkoutEvent'],
    WorkoutRoute: ['MetadataEntry', 'FileReference'], Correlation: ['MetadataEntry', 'Record'],
  };
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', validateHealthDoctype);
  parser.on('processinginstruction', () => invalid('UNSAFE_XML'));
  parser.on('cdata', () => invalid('INVALID_XML'));
  parser.on('error', () => invalid('INVALID_XML', 'XML 结构无效。'));
  parser.on('text', value => { if (value.trim()) invalid('INVALID_XML'); });
  parser.on('opentag', tag => {
    const parent = stack.at(-1);
    if (stack.length > 8) invalid('INVALID_XML');
    if (!parent ? tag.name !== 'HealthData' : !(children[parent] ?? []).includes(tag.name)) invalid('UNSUPPORTED_XML_STRUCTURE', 'XML 含不支持的结构。');
    if (Object.keys(tag.attributes).some(key => key === 'xmlns' || key.startsWith('xmlns:'))) invalid('UNSUPPORTED_XML_STRUCTURE');
    stack.push(tag.name); handlers.open?.(tag, stack.length);
  });
  parser.on('closetag', tag => { handlers.close?.(tag, stack.length); stack.pop(); });
  return parser;
}

function latestGroup(a: StoredSample[], b: StoredSample[]): number {
  const end = (rows: StoredSample[]) => rows.reduce((v, row) => row.end_at > v ? row.end_at : v, '');
  const seq = (rows: StoredSample[]) => rows.reduce((v, row) => Math.max(v, row.changed_seq), 0);
  return end(b).localeCompare(end(a)) || seq(b) - seq(a);
}
function groupSamples(rows: StoredSample[], key: (row: StoredSample) => string): [string, StoredSample[]][] {
  const groups = new Map<string, StoredSample[]>();
  for (const row of rows) { const k = key(row); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(row); }
  return [...groups.entries()];
}
function mergedIntervals(rows: StoredSample[]): [number, number][] {
  const result: [number, number][] = [];
  for (const row of [...rows].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    const a = Date.parse(row.start_at), b = Date.parse(row.end_at), last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else result.push([a, b]);
  }
  return result;
}
function overlaps(row: StoredSample, intervals: [number, number][]): boolean {
  const a = Date.parse(row.start_at), b = Date.parse(row.end_at);
  let low = 0, high = intervals.length;
  while (low < high) { const mid = (low + high) >>> 1; if (intervals[mid][1] < a) low = mid + 1; else high = mid; }
  for (let i = low; i < intervals.length && intervals[i][0] <= b; i++) {
    const [start, end] = intervals[i];
    if (a === b ? (start <= a && (a < end || start === end && a === start))
      : (start === end ? a <= start && start < b : start < b && end > a)) return true;
  }
  return false;
}

interface Sample {
  key: string;
  external_id: string | null;
  metric: HealthMetric;
  record_kind: 'sample' | 'aggregate';
  start_at: string;
  end_at: string;
  source_name: string;
  device: string;
  value: number;
  unit: string;
  original_value: number;
  original_unit: string;
  details: Record<string, unknown>;
  revision: number | null;
}
interface StoredSample {
  id: string; source_id: string; sample_key: string; external_id: string | null; metric: HealthMetric;
  record_kind: 'sample' | 'aggregate'; start_at: string; end_at: string; source_name: string; device: string;
  value: number; unit: string; original_value: number; original_unit: string; details_json: string;
  content_hash: string; revision: number; deleted: number; ignored: number; received_at: string; changed_seq: number;
}
interface SourceRow {
  id: string; name: string; kind: SourceKind; enabled: number; token_hash: string | null;
  created_at: string; last_received_at: string | null; last_batch_status: string | null; priority_names_json: string;
}
export interface HealthReceipt {
  status: 'persisted'; run_id: string; source_id: string; received_at: string; replayed: boolean;
  inserted: number; updated: number; unchanged: number; deleted: number; skipped: number; rejected: number;
  supported: number; unsupported_metrics: number; coverage_start: string | null; coverage_end: string | null;
  coverage_complete: false; data_revision: number;
}
interface Batch {
  samples: Sample[]; deletions: { external_id: string; revision: number }[];
  skipped: number; unsupported_metrics: number;
}
interface MetricSummary {
  value: number | null; unit: string; source_id: string | null; source_name: string | null;
  source_kind: SourceKind | null; original_source_name: string | null; record_kind: string | null;
  sample_count: number; available_sources: number; ignored_source_count: number;
  coverage_start: string | null; coverage_end: string | null; coverage_complete: false;
  aggregation: string; last_received_at: string | null; contributing_source_names: string[]; discarded_overlap_samples: number;
}

const genericSampleSchema = z.object({
  external_id: text.optional(), metric: z.enum(metrics), record_kind: z.enum(['sample', 'aggregate']).default('sample'),
  start_at: text, end_at: text.optional(), value: quantity, unit: text,
  source_name: text.default('unspecified'), device: z.string().max(2048).default(''), revision: revisionSchema.default(1),
}).strict();
const genericSchema = z.object({
  request_id: text.optional(), samples: z.array(genericSampleSchema).max(recordLimit).default([]),
  deleted: z.array(z.object({ external_id: text, revision: revisionSchema }).strict()).max(recordLimit).default([]),
}).strict();
const autoEnvelopeSchema = z.object({ data: z.object({
  metrics: z.array(z.object({ name: text, units: text, data: z.array(z.unknown()).max(recordLimit) }).passthrough()).max(512),
}).passthrough() }).passthrough();
const autoPointSchema = z.object({ date: text, qty: quantity, source: text.optional() }).passthrough();
const autoSleepSchema = z.object({
  date: text, totalSleep: quantity, sleepStart: text, sleepEnd: text, source: text.optional(),
  asleep: quantity.optional(), core: quantity.optional(), deep: quantity.optional(), rem: quantity.optional(),
  inBed: quantity.optional(), inBedStart: text.optional(), inBedEnd: text.optional(),
}).passthrough();

/** Owns only health_* tables. No network, filesystem or global SQLite migration state. */
export class HealthService {
  private readonly formatter: Intl.DateTimeFormat;
  constructor(private readonly db: DatabaseSync, public readonly timezone: string) {
    if (typeof timezone !== 'string' || timezone.length > 128) invalid('INVALID_TIMEZONE');
    try { this.formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch { invalid('INVALID_TIMEZONE', '时区无效。'); }
    this.atomic(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS health_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS health_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO health_meta (id, revision) VALUES (1,0);
        CREATE TABLE IF NOT EXISTS health_sources (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          token_hash TEXT, created_at TEXT NOT NULL, last_received_at TEXT, last_batch_status TEXT
        );
        CREATE TABLE IF NOT EXISTS health_samples (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES health_sources(id), sample_key TEXT NOT NULL,
          external_id TEXT, metric TEXT NOT NULL, record_kind TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
          source_name TEXT NOT NULL, device TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL,
          original_value REAL NOT NULL, original_unit TEXT NOT NULL, details_json TEXT NOT NULL, content_hash TEXT NOT NULL,
          revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0,
          received_at TEXT NOT NULL, changed_seq INTEGER NOT NULL, UNIQUE(source_id, sample_key)
        );
        CREATE INDEX IF NOT EXISTS health_samples_day ON health_samples(start_at, end_at);
        CREATE INDEX IF NOT EXISTS health_samples_source ON health_samples(source_id, metric);
        CREATE TABLE IF NOT EXISTS health_tombstones (
          source_id TEXT NOT NULL REFERENCES health_sources(id), external_id TEXT NOT NULL, revision INTEGER NOT NULL,
          received_at TEXT NOT NULL, PRIMARY KEY(source_id, external_id)
        );
        CREATE TABLE IF NOT EXISTS health_runs (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES health_sources(id), payload_hash TEXT NOT NULL,
          request_id TEXT, receipt_json TEXT NOT NULL, UNIQUE(source_id, payload_hash), UNIQUE(source_id, request_id)
        );
        INSERT OR IGNORE INTO health_migrations (version, applied_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      `);
      const sourceColumns = db.prepare('PRAGMA table_info(health_sources)').all();
      if (!sourceColumns.some(column => column.name === 'priority_names_json')) {
        db.exec("ALTER TABLE health_sources ADD COLUMN priority_names_json TEXT NOT NULL DEFAULT '[]'");
      }
      // Version 3 records the compatibility boundary. Legacy xml-id keys are intentionally
      // retained: old exports did not persist whether external_id came from uuid or sync ID.
      // Persist() resolves legacy rows by external_id and updates them under their old key.
      db.prepare("INSERT OR IGNORE INTO health_migrations (version,applied_at) VALUES (3,?)").run(new Date().toISOString());
    });
  }

  private atomic<T>(fn: () => T): T {
    const savepoint = `health_${randomBytes(8).toString('hex')}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = fn(); this.db.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) {
      this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      if (error instanceof HealthError) throw error;
      throw new HealthError(500, 'HEALTH_STORAGE_ERROR', '健康数据事务未完成。');
    }
  }
  private version(): number { return Number(this.db.prepare('SELECT revision FROM health_meta WHERE id=1').get()!.revision); }
  private bump(): number { this.db.prepare('UPDATE health_meta SET revision=revision+1 WHERE id=1').run(); return this.version(); }
  private localDay(value: string): string {
    const parts = this.formatter.formatToParts(new Date(value));
    const part = (key: string) => parts.find(p => p.type === key)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  private source(id: string, kind?: SourceKind): SourceRow {
    parse(idSchema, id);
    const row = this.db.prepare('SELECT * FROM health_sources WHERE id=?').get(id) as unknown as SourceRow | undefined;
    if (!row) throw new HealthError(404, 'SOURCE_NOT_FOUND', '健康数据源不存在。');
    if (kind && !row.enabled) throw new HealthError(403, 'SOURCE_DISABLED', '健康数据源已停用。');
    if (kind && row.kind !== kind) throw new HealthError(400, 'SOURCE_KIND_MISMATCH', '接收格式与健康数据源类型不匹配。');
    return row;
  }
  private sourceView(row: SourceRow) {
    const coverage = this.db.prepare(`SELECT MIN(start_at) AS coverage_start, MAX(end_at) AS coverage_end,
      COUNT(*) AS sample_count FROM health_samples WHERE source_id=? AND deleted=0 AND ignored=0`).get(row.id)!;
    const observed = this.db.prepare('SELECT DISTINCT metric FROM health_samples WHERE source_id=? AND deleted=0 AND ignored=0 ORDER BY metric').all(row.id).map(r => r.metric);
    return {
      id: row.id, name: row.name, kind: row.kind, enabled: Boolean(row.enabled), revoked: row.token_hash === null,
      created_at: row.created_at, last_received_at: row.last_received_at, last_batch_status: row.last_batch_status,
      coverage_start: coverage.coverage_start as string | null, coverage_end: coverage.coverage_end as string | null,
      coverage_complete: false as const, sample_count: Number(coverage.sample_count),
      metrics: row.kind === 'health_auto_export' ? metrics.filter(m => m !== 'workout') : [...metrics],
      observed_metrics: observed, modes: [row.kind === 'apple_xml' ? 'file_import' : 'push'],
      supports_deletions: row.kind === 'generic', supports_history: true, supports_incremental: row.kind === 'generic',
      coverage_status: coverage.coverage_end === null ? 'no_data' : 'observed_only',
      source_priority: JSON.parse(row.priority_names_json) as string[],
    };
  }
  createSource(input: { name: string; kind: SourceKind }) {
    const value = parse(z.object({ name: text, kind: z.enum(kinds) }).strict(), input);
    const id = randomUUID(); const token = randomBytes(32).toString('hex');
    this.atomic(() => {
      this.db.prepare('INSERT INTO health_sources (id,name,kind,token_hash,created_at) VALUES (?,?,?,?,?)')
        .run(id, value.name, value.kind, hash(`${id}:${token}`), new Date().toISOString());
      this.bump();
    });
    return { source: this.sourceView(this.source(id)), token };
  }
  listSources() { return { items: (this.db.prepare('SELECT * FROM health_sources ORDER BY created_at,id').all() as unknown as SourceRow[]).map(row => this.sourceView(row)) }; }
  authenticateSource(id: string, token: string): boolean {
    if (!idSchema.safeParse(id).success || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const row = this.db.prepare('SELECT token_hash,enabled FROM health_sources WHERE id=?').get(id);
    const expected = typeof row?.token_hash === 'string' ? row.token_hash : '0'.repeat(64);
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash(`${id}:${token}`), 'hex')) && row?.enabled === 1;
  }
  setSourceEnabled(id: string, enabled: boolean) {
    const row = this.source(id); parse(z.boolean(), enabled);
    if (enabled && row.token_hash === null) throw new HealthError(409, 'SOURCE_REVOKED', '已撤销的来源需要重新配对。');
    this.atomic(() => { if (Boolean(row.enabled) !== enabled) { this.db.prepare('UPDATE health_sources SET enabled=? WHERE id=?').run(Number(enabled), id); this.bump(); } });
    return this.sourceView(this.source(id));
  }
  setSourcePriority(id: string, sourceNames: string[]) {
    this.source(id);
    const names = parse(z.array(text).max(64), sourceNames);
    if (new Set(names).size !== names.length) invalid();
    this.atomic(() => {
      this.db.prepare('UPDATE health_sources SET priority_names_json=? WHERE id=?').run(JSON.stringify(names), id); this.bump();
    });
    return this.sourceView(this.source(id));
  }
  revokeSource(id: string) {
    this.source(id);
    this.atomic(() => { this.db.prepare('UPDATE health_sources SET enabled=0,token_hash=NULL WHERE id=?').run(id); this.bump(); });
    return this.sourceView(this.source(id));
  }
  setSampleIgnored(id: string, sampleId: string, ignored: boolean) {
    this.source(id); parse(idSchema, sampleId); parse(z.boolean(), ignored);
    this.atomic(() => {
      const row = this.db.prepare('SELECT ignored FROM health_samples WHERE source_id=? AND id=?').get(id, sampleId);
      if (!row) throw new HealthError(404, 'SAMPLE_NOT_FOUND', '健康样本不存在。');
      if (Boolean(row.ignored) !== ignored) {
        this.db.prepare('UPDATE health_samples SET ignored=? WHERE source_id=? AND id=?').run(Number(ignored), id, sampleId); this.bump();
      }
    });
    return { id: sampleId, ignored, data_revision: this.version() };
  }

  ingestGeneric(id: string, payload: unknown): HealthReceipt {
    this.source(id, 'generic'); boundedJson(payload);
    const input = parse(genericSchema, payload);
    const samples = input.samples.map(item => {
      const start = timestamp(item.start_at), end = timestamp(item.end_at ?? item.start_at);
      if (end < start) invalid();
      const value = normalize(item.metric, item.value, item.unit);
      if (item.metric === 'sleep' && item.record_kind === 'sample' && Math.abs(value - (Date.parse(end) - Date.parse(start)) / 3600000) > 1 / 3600) invalid();
      const sample: Sample = {
        key: '', external_id: item.external_id ?? null, metric: item.metric, record_kind: item.record_kind,
        start_at: start, end_at: end, source_name: item.source_name, device: item.device,
        value, unit: units[item.metric], original_value: item.value, original_unit: item.unit, details: {}, revision: item.revision,
      };
      sample.key = item.external_id ? `external:${item.external_id}` : `fingerprint:${hash(canonical({ ...sample, revision: null }))}`;
      return sample;
    });
    return this.persist(id, hash(canonical(payload)), { samples, deletions: input.deleted, skipped: 0, unsupported_metrics: 0 }, input.request_id);
  }

  ingestAutoExport(id: string, payload: unknown): HealthReceipt {
    this.source(id, 'health_auto_export'); boundedJson(payload);
    const input = parse(autoEnvelopeSchema, payload);
    const batch: Batch = { samples: [], deletions: [], skipped: 0, unsupported_metrics: 0 };
    for (const metricData of input.data.metrics) {
      const metric = Object.hasOwn(autoMetrics, metricData.name) ? autoMetrics[metricData.name] : undefined;
      if (!metric) { batch.skipped += metricData.data.length; batch.unsupported_metrics++; continue; }
      for (const raw of metricData.data) {
        let start: string, end: string, value: number, sourceName: string, bucket: string, original: number;
        let details: Record<string, unknown> = {};
        if (metric === 'sleep') {
          // Segment exports are deliberately unsupported: only the documented totalSleep day aggregate is ingested.
          if (raw && typeof raw === 'object' && 'startDate' in raw && !('totalSleep' in raw)) { batch.skipped++; continue; }
          const item = parse(autoSleepSchema, raw);
          bucket = day(item.date); start = timestamp(item.sleepStart); end = timestamp(item.sleepEnd);
          if (end < start || metricData.units !== 'hr') invalid();
          value = normalize(metric, item.totalSleep, metricData.units); original = item.totalSleep;
          if (value > (Date.parse(end) - Date.parse(start)) / 3600000 + 1 / 60) invalid();
          if (item.inBedStart !== undefined) timestamp(item.inBedStart);
          if (item.inBedEnd !== undefined) timestamp(item.inBedEnd);
          sourceName = item.source ?? 'unspecified';
          details = { vendor_date: bucket, aggregation: 'totalSleep' };
        } else {
          const item = parse(autoPointSchema, raw);
          start = end = timestamp(item.date); bucket = start;
          value = normalize(metric, item.qty, metricData.units); original = item.qty;
          sourceName = item.source ?? 'unspecified';
          details = { bucket_timestamp: start, duration_unknown: true };
        }
        batch.samples.push({
          key: `bucket:${hash(canonical([metric, bucket, sourceName]))}`, external_id: null,
          metric, record_kind: 'aggregate', start_at: start, end_at: end, source_name: sourceName, device: '',
          value, unit: units[metric], original_value: original, original_unit: metricData.units, details, revision: null,
        });
      }
    }
    return this.persist(id, hash(canonical(payload)), batch);
  }

  importXml(id: string, xml: string): HealthReceipt {
    this.source(id, 'apple_xml');
    if (typeof xml !== 'string' || xml.length === 0) invalid('INVALID_XML');
    if (Buffer.byteLength(xml) > xmlLimit) throw new HealthError(413, 'PAYLOAD_TOO_LARGE', '健康 XML 超过 20 MiB。');
    const batch: Batch = { samples: [], deletions: [], skipped: 0, unsupported_metrics: 0 };
    type Frame = { name: string; attributes: Record<string, string>; syncId?: string };
    const stack: Frame[] = [];
    let count = 0;
    const parser = createHealthXmlParser({
      open: tag => {
        if (++count > 500_000) invalid('TOO_MANY_RECORDS');
        const parent = stack.at(-1), attributes = tag.attributes;
        if (tag.name === 'MetadataEntry' && parent?.name === 'Record' && attributes.key === 'HKMetadataKeySyncIdentifier') parent.syncId = parse(text, attributes.value);
        stack.push({ name: tag.name, attributes });
      },
      close: () => {
        const frame = stack.pop()!;
        if (stack.at(-1)?.name !== 'HealthData') return;
        if (frame.name === 'Record' || frame.name === 'Workout') {
          const sample = this.xmlSample(frame.name, frame.attributes, frame.syncId);
          if (sample) batch.samples.push(sample); else batch.skipped++;
        } else if (['Correlation', 'ActivitySummary', 'ClinicalRecord', 'Audiogram'].includes(frame.name)) batch.skipped++;
        if (batch.samples.length + batch.skipped > recordLimit) invalid('TOO_MANY_RECORDS');
      },
    });
    try { parser.write(xml).close(); }
    catch (error) { if (error instanceof HealthError) throw error; invalid('INVALID_XML', 'XML 结构无效。'); }
    return this.persist(id, hash(xml), batch);
  }

  private xmlSample(name: string, attrs: Record<string, string>, syncId?: string): Sample | null {
    const metric = name === 'Workout' ? 'workout' : Object.hasOwn(xmlMetrics, attrs.type) ? xmlMetrics[attrs.type] : undefined;
    if (!metric) return null;
    const start = timestamp(attrs.startDate), end = timestamp(attrs.endDate);
    if (end < start) invalid();
    const sourceName = parse(text, attrs.sourceName ?? 'unspecified');
    const device = parse(z.string().max(2048), attrs.device ?? '');
    const details: Record<string, unknown> = { apple_type: attrs.type ?? attrs.workoutActivityType };
    let original: number, originalUnit: string;
    if (metric === 'sleep') {
      if (otherSleepStates.has(attrs.value)) return null;
      if (!sleepStates.has(attrs.value)) invalid();
      original = (Date.parse(end) - Date.parse(start)) / 3600000; originalUnit = 'hr';
      details.sleep_state = attrs.value;
    } else if (metric === 'workout') {
      details.activity_type = parse(text, attrs.workoutActivityType);
      original = xmlNumber(attrs.duration); originalUnit = attrs.durationUnit;
      if (normalize(metric, original, originalUnit) > (Date.parse(end) - Date.parse(start)) / 60000 + 1 / 60) invalid();
    } else { original = xmlNumber(attrs.value); originalUnit = attrs.unit; }
    const value = normalize(metric, original, originalUnit);
    const externalId = attrs.uuid ? parse(text, attrs.uuid) : syncId ?? null;
    const sample: Sample = {
      key: '', external_id: externalId, metric, record_kind: 'sample', start_at: start, end_at: end,
      source_name: sourceName, device, value, unit: units[metric], original_value: original,
      original_unit: originalUnit, details, revision: null,
    };
    sample.key = attrs.uuid ? `xml-uuid:${externalId}` : syncId ? `xml-sync:${hash(canonical([metric, sourceName, syncId]))}` : `fingerprint:${hash(canonical(sample))}`;
    return sample;
  }

  private persist(id: string, payloadHash: string, batch: Batch, requestId?: string): HealthReceipt {
    return this.atomic(() => {
      const priorRequest = requestId ? this.db.prepare('SELECT payload_hash,receipt_json FROM health_runs WHERE source_id=? AND request_id=?').get(id, requestId) : undefined;
      if (priorRequest && priorRequest.payload_hash !== payloadHash) throw new HealthError(409, 'IDEMPOTENCY_CONFLICT', '同一请求 ID 的内容发生变化。');
      const prior = priorRequest ?? this.db.prepare('SELECT receipt_json FROM health_runs WHERE source_id=? AND payload_hash=?').get(id, payloadHash);
      if (prior) return { ...JSON.parse(prior.receipt_json as string), replayed: true };
      const receivedAt = new Date().toISOString();
      const receipt: HealthReceipt = { status: 'persisted', run_id: randomUUID(), source_id: id, received_at: receivedAt,
        replayed: false, inserted: 0, updated: 0, unchanged: 0, deleted: 0, skipped: batch.skipped, rejected: 0,
        supported: batch.samples.length, unsupported_metrics: batch.unsupported_metrics, coverage_start: null, coverage_end: null,
        coverage_complete: false, data_revision: this.version() };
      const touched = new Map<string, string>();
      for (const sample of batch.samples) {
        const { revision: suppliedRevision, key, ...body } = sample;
        const contentHash = hash(canonical(body));
        const signature = `${contentHash}:${suppliedRevision}`;
        const old = (this.db.prepare('SELECT * FROM health_samples WHERE source_id=? AND sample_key=?').get(id, key)
          ?? (sample.external_id ? this.db.prepare("SELECT * FROM health_samples WHERE source_id=? AND external_id=? AND sample_key LIKE 'xml-id:%' ORDER BY changed_seq DESC LIMIT 1").get(id, sample.external_id) : undefined)) as unknown as StoredSample | undefined;
        // Preserve a legacy key when provenance is ambiguous. This prevents duplicates and
        // avoids guessing whether an old external_id came from uuid or sync metadata.
        const storageKey = old?.sample_key ?? key;
        if (touched.has(storageKey) && touched.get(storageKey) !== signature) throw new HealthError(409, 'BATCH_SAMPLE_CONFLICT', '批次包含相互冲突的样本或聚合桶。');
        touched.set(storageKey, signature);
        const tombstone = suppliedRevision !== null && sample.external_id ? this.db.prepare('SELECT revision FROM health_tombstones WHERE source_id=? AND external_id=?').get(id, sample.external_id) : undefined;
        if (tombstone && Number(tombstone.revision) >= suppliedRevision!) { receipt.unchanged++; continue; }
        if (old && suppliedRevision !== null && suppliedRevision < old.revision) { receipt.unchanged++; continue; }
        if (old && suppliedRevision !== null && suppliedRevision === old.revision && old.content_hash !== contentHash) throw new HealthError(409, 'SAMPLE_REVISION_CONFLICT', '相同样本版本包含不同内容。');
        if (old && !old.deleted && old.content_hash === contentHash && (suppliedRevision === null || suppliedRevision === old.revision)) { receipt.unchanged++; continue; }
        const version = suppliedRevision ?? (old ? old.revision + 1 : 1);
        const seq = this.bump();
        this.db.prepare(`INSERT INTO health_samples
          (id,source_id,sample_key,external_id,metric,record_kind,start_at,end_at,source_name,device,value,unit,original_value,original_unit,details_json,content_hash,revision,received_at,changed_seq)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,sample_key) DO UPDATE SET
          external_id=excluded.external_id, metric=excluded.metric, record_kind=excluded.record_kind, start_at=excluded.start_at,
          end_at=excluded.end_at, source_name=excluded.source_name, device=excluded.device, value=excluded.value, unit=excluded.unit,
          original_value=excluded.original_value, original_unit=excluded.original_unit, details_json=excluded.details_json,
          content_hash=excluded.content_hash, revision=excluded.revision, received_at=excluded.received_at, changed_seq=excluded.changed_seq, deleted=0`)
          .run(old?.id ?? randomUUID(), id, storageKey, sample.external_id, sample.metric, sample.record_kind, sample.start_at, sample.end_at,
            sample.source_name, sample.device, sample.value, sample.unit, sample.original_value, sample.original_unit,
            canonical(sample.details), contentHash, version, receivedAt, seq);
        if (old) receipt.updated++; else receipt.inserted++;
      }
      for (const deletion of batch.deletions) {
        const old = this.db.prepare('SELECT revision,deleted FROM health_samples WHERE source_id=? AND sample_key=?').get(id, `external:${deletion.external_id}`);
        const tombstone = this.db.prepare('SELECT revision FROM health_tombstones WHERE source_id=? AND external_id=?').get(id, deletion.external_id);
        if ((old && Number(old.revision) > deletion.revision) || (tombstone && Number(tombstone.revision) >= deletion.revision)) { receipt.unchanged++; continue; }
        this.db.prepare(`INSERT INTO health_tombstones (source_id,external_id,revision,received_at) VALUES (?,?,?,?)
          ON CONFLICT(source_id,external_id) DO UPDATE SET revision=excluded.revision,received_at=excluded.received_at`).run(id, deletion.external_id, deletion.revision, receivedAt);
        const seq = this.bump();
        this.db.prepare('UPDATE health_samples SET deleted=1,revision=?,received_at=?,changed_seq=? WHERE source_id=? AND sample_key=?')
          .run(deletion.revision, receivedAt, seq, id, `external:${deletion.external_id}`);
        receipt.deleted++;
      }
      this.db.prepare('UPDATE health_sources SET last_received_at=?,last_batch_status=? WHERE id=?')
        .run(receivedAt, receipt.supported ? 'received' : 'no_supported_samples', id);
      const coverage = this.sourceView(this.source(id));
      receipt.coverage_start = coverage.coverage_start; receipt.coverage_end = coverage.coverage_end; receipt.data_revision = this.version();
      this.db.prepare('INSERT INTO health_runs (id,source_id,payload_hash,request_id,receipt_json) VALUES (?,?,?,?,?)')
        .run(receipt.run_id, id, payloadHash, requestId ?? null, JSON.stringify(receipt));
      return receipt;
    });
  }

  dailySummary(date: string) {
    day(date);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    const lower = new Date(midnight - 86400000).toISOString(), upper = new Date(midnight + 2 * 86400000).toISOString();
    // Split wake-day sleep from activity so existing source/metric and date indexes apply.
    const rows = this.db.prepare(`SELECT h.* FROM health_sources s CROSS JOIN health_samples h ON h.source_id=s.id
      WHERE s.enabled=1 AND h.deleted=0 AND h.ignored=0
      AND h.metric='sleep' AND h.end_at>=? AND h.end_at<?
      UNION ALL
      SELECT h.* FROM health_samples h JOIN health_sources s ON s.id=h.source_id
      WHERE s.enabled=1 AND h.deleted=0 AND h.ignored=0
      AND h.metric<>'sleep' AND h.start_at>=? AND h.start_at<?`)
      .all(lower, upper, lower, upper) as unknown as StoredSample[];
    const relevant = rows.filter(row => this.localDay(row.metric === 'sleep' ? row.end_at : row.start_at) === date);
    const result = {} as Record<HealthMetric, MetricSummary>;
    for (const metric of metrics) {
      const candidates = relevant.filter(row => row.metric === metric);
      const connections = groupSamples(candidates, row => row.source_id).sort(([ka, a], [kb, b]) => latestGroup(a, b) || ka.localeCompare(kb));
      const connectionRows = connections[0]?.[1] ?? [];
      const selectedSource = connectionRows.length ? this.source(connectionRows[0].source_id) : null;
      const names: string[] = selectedSource ? JSON.parse(selectedSource.priority_names_json) : [];
      const priority = (rows: StoredSample[]) => {
        const index = names.indexOf(rows[0].source_name);
        if (index >= 0) return 100 + names.length - index;
        const label = `${rows[0].source_name} ${rows[0].device}`.toLowerCase();
        return label.includes('watch') ? 3 : label.includes('iphone') ? 2 : 1;
      };
      const representations = groupSamples(connectionRows, row => row.record_kind).sort(([ka, a], [kb, b]) => latestGroup(a, b) || ka.localeCompare(kb));
      const streams = groupSamples(representations[0]?.[1] ?? [], row => canonical([row.source_name, row.device]))
        .sort(([ka, a], [kb, b]) => priority(b) - priority(a) || latestGroup(a, b) || ka.localeCompare(kb));
      let chosen = streams[0]?.[1] ?? [];
      let discarded = 0;
      if (chosen[0]?.record_kind === 'sample' && metric !== 'weight') {
        for (const [, stream] of streams.slice(1)) {
          const coverage = mergedIntervals(chosen);
          const additions = stream.filter(row => !overlaps(row, coverage));
          discarded += stream.length - additions.length;
          chosen = chosen.concat(additions);
        }
      } else if (metric === 'weight') {
        // Weight is a point measurement: latest timestamp wins, source priority resolves a tie.
        chosen = streams.flatMap(([, rows]) => rows).sort((a, b) => b.end_at.localeCompare(a.end_at) || priority([b]) - priority([a]) || b.changed_seq - a.changed_seq).slice(0, 1);
      } else discarded = streams.slice(1).reduce((n, [, rows]) => n + rows.length, 0);
      const empty: MetricSummary = { value: null, unit: units[metric], source_id: null, source_name: null, source_kind: null,
        original_source_name: null, record_kind: null, sample_count: 0, available_sources: connections.length, ignored_source_count: Math.max(0, connections.length - 1),
        coverage_start: null, coverage_end: null, coverage_complete: false, aggregation: 'missing', last_received_at: null, contributing_source_names: [], discarded_overlap_samples: discarded };
      if (!chosen.length) { result[metric] = empty; continue; }
      const source = this.source(chosen[0].source_id);
      let value: number, aggregation: string;
      if (metric === 'weight') {
        value = [...chosen].sort((a, b) => b.end_at.localeCompare(a.end_at) || b.changed_seq - a.changed_seq || a.sample_key.localeCompare(b.sample_key))[0].value;
        aggregation = 'latest_measurement';
      } else if (metric === 'sleep' && chosen[0].record_kind === 'sample') {
        const intervals = chosen.map(row => [Date.parse(row.start_at), Date.parse(row.end_at)]).sort((a, b) => a[0] - b[0]);
        let total = 0, start = intervals[0][0], end = intervals[0][1];
        for (const [a, b] of intervals.slice(1)) { if (a <= end) end = Math.max(end, b); else { total += end - start; start = a; end = b; } }
        value = (total + end - start) / 3600000; aggregation = 'union_of_sleep_intervals_wake_day';
      } else {
        value = chosen.reduce((sum, row) => sum + row.value, 0); aggregation = chosen[0].record_kind === 'aggregate' ? 'sum_selected_buckets' : 'sum_selected_samples';
      }
      result[metric] = { ...empty, value, source_id: source.id, source_name: source.name, source_kind: source.kind,
        original_source_name: chosen[0].source_name, record_kind: chosen[0].record_kind, sample_count: chosen.length,
        coverage_start: chosen.reduce((v, row) => row.start_at < v ? row.start_at : v, chosen[0].start_at),
        coverage_end: chosen.reduce((v, row) => row.end_at > v ? row.end_at : v, chosen[0].end_at),
        last_received_at: source.last_received_at, aggregation, contributing_source_names: [...new Set(chosen.map(row => row.source_name))] };
    }
    return { date, timezone: this.timezone, data_revision: this.version(), selection_policy: 'latest_connection_coverage_then_change_sequence; source_priority_then_watch_then_iphone; nonoverlapping_whole_samples', metrics: result };
  }

  exportData() {
    return { schema_version: 1, timezone: this.timezone, data_revision: this.version(), sources: this.listSources().items,
      samples: (this.db.prepare('SELECT * FROM health_samples ORDER BY source_id,start_at,sample_key').all() as unknown as StoredSample[])
        .map(({ content_hash: _hash, details_json, ...row }) => ({ ...row, ignored: Boolean(row.ignored), deleted: Boolean(row.deleted), details: JSON.parse(details_json) })),
      tombstones: this.db.prepare('SELECT source_id,external_id,revision,received_at FROM health_tombstones ORDER BY source_id,external_id').all(),
      runs: this.db.prepare('SELECT receipt_json FROM health_runs ORDER BY rowid').all().map(row => JSON.parse(row.receipt_json as string) as HealthReceipt) };
  }
}
