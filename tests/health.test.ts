import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HealthError, HealthService } from '../src/health.js';
import { importHealthFile } from '../scripts/import-health.js';
import { spawnSync } from 'node:child_process';

const xml = readFileSync(new URL('../fixtures/health/apple-export.xml', import.meta.url), 'utf8');
const auto = () => JSON.parse(readFileSync(new URL('../fixtures/health/health-auto-export.json', import.meta.url), 'utf8'));
function setup(timezone = 'Asia/Shanghai') {
  const db = new DatabaseSync(':memory:');
  return { db, service: new HealthService(db, timezone) };
}
function generic(overrides: Record<string, unknown> = {}) {
  return { external_id: 'synthetic-1', metric: 'steps', start_at: '2026-10-20T08:00:00+08:00', end_at: '2026-10-20T09:00:00+08:00',
    value: 100, unit: 'count', source_name: 'Synthetic Watch', revision: 1, ...overrides };
}
function fails(action: () => unknown, code?: string) {
  assert.throws(action, (error: unknown) => error instanceof HealthError && error.status >= 400 && (!code || error.code === code));
}
function record(source: string, start: string, end: string, value: number, device = '') {
  return `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${source}" device="${device}" unit="count" startDate="2026-10-20 ${start}:00 +0800" endDate="2026-10-20 ${end}:00 +0800" value="${value}"/>`;
}

test('constructor migrations are repeatable, namespaced and nest inside caller transactions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE meals (id TEXT); PRAGMA user_version=71; BEGIN');
    const first = new HealthService(db, 'Asia/Shanghai'); first.createSource({ name: 'test', kind: 'generic' });
    assert.equal(first.listSources().items.length, 1);
    db.exec('ROLLBACK');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'health_%'").get()!.n, 0);
    const second = new HealthService(db, 'Asia/Shanghai'); new HealthService(db, 'Asia/Shanghai');
    assert.equal(second.listSources().items.length, 0);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 71);
    assert.equal(db.prepare('SELECT count(*) AS n FROM health_migrations').get()!.n, 2);
    fails(() => new HealthService(db, 'not/a/timezone'), 'INVALID_TIMEZONE');
  } finally { db.close(); }
});

test('source tokens are separated, hashed, not exported, and revoked persistently', () => {
  const { db, service: h } = setup();
  try {
    const a = h.createSource({ name: 'Phone A', kind: 'generic' }), b = h.createSource({ name: 'Phone B', kind: 'health_auto_export' });
    assert.match(a.token, /^[0-9a-f]{64}$/); assert.notEqual(a.token, b.token);
    assert.equal(h.authenticateSource(a.source.id, a.token), true);
    assert.equal(h.authenticateSource(b.source.id, a.token), false);
    assert.equal(h.authenticateSource(a.source.id, ''), false);
    assert.equal(h.authenticateSource('bad-id', a.token), false);
    assert.equal(h.authenticateSource(a.source.id, 'f'.repeat(64)), false);
    const stored = db.prepare('SELECT token_hash FROM health_sources WHERE id=?').get(a.source.id)!;
    assert.notEqual(stored.token_hash, a.token);
    assert.ok(!JSON.stringify(h.exportData()).includes(String(stored.token_hash)));
    assert.ok(!JSON.stringify(h.exportData()).includes(a.token));
    fails(() => h.ingestAutoExport(a.source.id, auto()), 'SOURCE_KIND_MISMATCH');
    fails(() => h.importXml(b.source.id, xml), 'SOURCE_KIND_MISMATCH');
    h.setSourceEnabled(a.source.id, false); assert.equal(h.authenticateSource(a.source.id, a.token), false);
    fails(() => h.ingestGeneric(a.source.id, { samples: [] }), 'SOURCE_DISABLED');
    h.setSourceEnabled(a.source.id, true); assert.equal(h.authenticateSource(a.source.id, a.token), true);
    h.revokeSource(a.source.id); assert.equal(new HealthService(db, 'Asia/Shanghai').authenticateSource(a.source.id, a.token), false);
    fails(() => h.setSourceEnabled(a.source.id, true), 'SOURCE_REVOKED');
    fails(() => h.createSource({ name: '', kind: 'generic' }));
    fails(() => h.createSource({ name: 'bad', kind: 'unsupported' as 'generic' }));
  } finally { db.close(); }
});

test('real Apple structural DTD, quantity units, wake-day sleep union and workout duration', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    const receipt = h.importXml(source.id, xml);
    assert.equal(receipt.inserted, 9); assert.equal(receipt.skipped, 3); assert.equal(receipt.rejected, 0);
    const summary = h.dailySummary('2026-10-20').metrics;
    assert.equal(summary.steps.value, 1300); assert.equal(summary.steps.discarded_overlap_samples, 1);
    assert.deepEqual(summary.steps.contributing_source_names, ['Synthetic Apple Watch', 'Synthetic iPhone']);
    assert.equal(summary.active_energy.value, 80); assert.ok(Math.abs(summary.basal_energy.value! - 1000) < 1e-10);
    assert.ok(Math.abs(summary.weight.value! - 70) < 1e-8);
    assert.equal(summary.sleep.value, 8); assert.equal(h.dailySummary('2026-10-19').metrics.sleep.value, null);
    assert.equal(summary.workout.value, 30); assert.equal(summary.steps.coverage_complete, false);
    assert.equal(h.exportData().samples.find(s => s.metric === 'weight')!.original_unit, 'lb');
    assert.equal(h.listSources().items[0].coverage_end, '2026-10-20T04:00:00.000Z');
  } finally { db.close(); }
});

test('same imported source prioritizes Watch, retains nonoverlap, supports persisted custom priority', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    h.importXml(source.id, `<HealthData>${record('Watch', '08:00', '09:00', 100)}${record('iPhone', '08:30', '09:30', 200)}${record('iPhone', '10:00', '11:00', 50)}${record('iPhone', '09:00', '09:00', 5)}</HealthData>`);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 155);
    h.setSourcePriority(source.id, ['iPhone', 'Watch']);
    assert.equal(new HealthService(db, 'Asia/Shanghai').dailySummary('2026-10-20').metrics.steps.value, 255);
    fails(() => h.setSourcePriority(source.id, ['Watch', 'Watch']));
  } finally { db.close(); }
});

test('XML repeats, renamed export date, and import chunks deduplicate stable fingerprints', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    const first = h.importXml(source.id, xml), repeat = h.importXml(source.id, xml);
    assert.equal(first.run_id, repeat.run_id); assert.equal(repeat.replayed, true);
    const differentEnvelope = h.importXml(source.id, xml.replace('16:00:00', '17:00:00'));
    assert.equal(differentEnvelope.inserted, 0); assert.equal(differentEnvelope.unchanged, 9);
    assert.equal(h.exportData().samples.length, 9);
    const chunk = `<HealthData>${record('Synthetic Apple Watch', '08:00', '09:00', 1000, 'Watch')}</HealthData>`;
    assert.equal(h.importXml(source.id, chunk).unchanged, 1);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 1300);
  } finally { db.close(); }
});

test('XML rejects entity definitions, external DTDs, unsafe references and unsupported structure without partial writes', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    const malicious = readFileSync(new URL('../fixtures/health/unsafe-entity.xml', import.meta.url), 'utf8');
    for (const payload of [malicious, '<!DOCTYPE HealthData SYSTEM "https://example.invalid/dtd"><HealthData/>',
      '<!DOCTYPE HealthData PUBLIC "id" "https://example.invalid/dtd"><HealthData/>',
      '<!DOCTYPE HealthData [<!ENTITY x "sensitive-value">]><HealthData/>',
      '<!DOCTYPE HealthData [<!ENTITY % p SYSTEM "file:///secret">%p;]><HealthData/>',
      '<!DOCTYPE HealthData [<!ATTLIST Record sourceName CDATA "default">]><HealthData/>',
      '<!DOCTYPE Other [<!ELEMENT Other EMPTY>]><HealthData/>',
      '<!DOCTYPE HealthData [<?xml-stylesheet href="https://example.invalid"?>]><HealthData/>',
      '<HealthData><Record sourceName="&unknown;"/></HealthData>',
      '<Other/>', '<HealthData><Unknown/></HealthData>', '<HealthData><Record><Record/></Record></HealthData>',
      '<HealthData><![CDATA[sensitive-value]]></HealthData>', '<HealthData xmlns="urn:unexpected"/>',
      '<HealthData><?xml-stylesheet href="https://example.invalid"?></HealthData>',
      `<HealthData>${record('Watch', '08:00', '09:00', 100)}<Record></HealthData>`]) {
      assert.throws(() => h.importXml(source.id, payload), (err: unknown) => err instanceof HealthError && !err.message.includes('sensitive-value') && !err.message.includes('file:///'));
    }
    assert.equal(h.exportData().samples.length, 0); assert.equal(h.exportData().runs.length, 0);
    assert.equal(h.listSources().items[0].last_received_at, null);
    assert.equal(h.importXml(source.id, '<!DOCTYPE HealthData><HealthData/>').supported, 0);
  } finally { db.close(); }
});

test('XML supported record validation is all-or-nothing and does not leak record contents', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    for (const [from, to] of [['value="1000"', 'value="-1"'], ['08:00:00 +0800', '08:00:00'], ['2026-10-20 08:00', '2026-02-30 08:00'], ['unit="count"', 'unit="private-secret"']]) {
      fails(() => h.importXml(source.id, xml.replace(from, to)));
      assert.equal(h.exportData().samples.length, 0);
    }
    assert.equal(h.listSources().items[0].coverage_end, null);
  } finally { db.close(); }
});

test('official Health Auto Export wrapper and names, aggregate replacement and replay after an update', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'HAE', kind: 'health_auto_export' });
    const payload = auto(), first = h.ingestAutoExport(source.id, payload);
    assert.equal(first.inserted, 5); assert.equal(first.skipped, 1); assert.equal(first.unsupported_metrics, 1);
    assert.equal(h.dailySummary('2026-10-20').metrics.sleep.value, 7.25);
    const changed = auto(); changed.data.metrics[0].data[0].qty = 5000;
    const replacement = h.ingestAutoExport(source.id, changed);
    assert.equal(replacement.updated, 1); assert.equal(h.exportData().samples.length, 5);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 5000);
    assert.equal(h.ingestAutoExport(source.id, payload).replayed, true);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 5000);
    const hourly = { data: { metrics: [{ name: 'step_count', units: 'count', data: [
      { qty: 20, date: '2026-10-20 15:00:00 +0800', source: 'Synthetic Watch' },
    ] }] } };
    h.ingestAutoExport(source.id, hourly); assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 5020);
    assert.ok(Math.abs(h.dailySummary('2026-10-20').metrics.basal_energy.value! - 1000) < 1e-10);
    fails(() => h.ingestAutoExport(source.id, { metrics: [] }));
  } finally { db.close(); }
});

test('HAE strict numeric/timestamp validation and conflicting buckets roll back transaction', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'HAE', kind: 'health_auto_export' });
    for (const change of [
      (p: any) => p.data.metrics[0].data[0].qty = -1,
      (p: any) => p.data.metrics[0].data[0].qty = '20',
      (p: any) => p.data.metrics[0].data[0].date = '2026-02-30 12:00:00 +0800',
      (p: any) => p.data.metrics[0].data[0].date = '2026-10-20 12:00:00',
      (p: any) => p.data.metrics[0].data[0].date = '2026-10-20 24:00:00 +0800',
      (p: any) => p.data.metrics[0].data[0].date = '2026-10-20 12:00:00 +1500',
      (p: any) => p.data.metrics[1].units = 'joules',
      (p: any) => p.data.metrics[4].data[0].totalSleep = 30,
      (p: any) => p.data.metrics[4].data[0].sleepEnd = '2026-10-19 20:00:00 +0800',
    ]) { const payload = auto(); change(payload); fails(() => h.ingestAutoExport(source.id, payload)); }
    const conflict = auto(); conflict.data.metrics[0].data.push({ ...conflict.data.metrics[0].data[0], qty: 999 });
    fails(() => h.ingestAutoExport(source.id, conflict), 'BATCH_SAMPLE_CONFLICT');
    assert.equal(h.exportData().samples.length, 0); assert.equal(h.exportData().runs.length, 0);
    assert.equal(h.listSources().items[0].last_received_at, null);
    assert.equal(h.exportData().data_revision, 1);
  } finally { db.close(); }
});

test('unknown/empty batches and unsupported sleep segments do not claim complete coverage or zero measurements', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'HAE', kind: 'health_auto_export' });
    const unknown = h.ingestAutoExport(source.id, { data: { metrics: [
      { name: 'heart_rate', units: 'bpm', data: [{ Avg: 70 }] },
      { name: 'sleep_analysis', units: 'hr', data: [{ startDate: '2026-10-20 01:00:00 +0800', endDate: '2026-10-20 02:00:00 +0800', qty: 1, value: 'Core' }] },
    ] } });
    assert.equal(unknown.skipped, 2); assert.equal(unknown.coverage_end, null); assert.equal(unknown.coverage_complete, false);
    const empty = h.ingestAutoExport(source.id, { data: { metrics: [] } });
    assert.equal(empty.supported, 0); assert.equal(empty.coverage_start, null);
    assert.equal(h.listSources().items[0].last_batch_status, 'no_supported_samples');
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    h.ingestAutoExport(source.id, auto()); const coverage = h.listSources().items[0].coverage_end;
    h.ingestAutoExport(source.id, { data: { metrics: [], workouts: [] } });
    assert.equal(h.listSources().items[0].coverage_end, coverage); assert.equal(h.exportData().samples.length, 5);
  } finally { db.close(); }
});

test('generic revisions, tombstones before arrival, stale delivery and local ignore survive updates', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'generic', kind: 'generic' });
    h.ingestGeneric(source.id, { request_id: 'a', samples: [generic()] });
    const sampleId = h.exportData().samples[0].id;
    h.setSampleIgnored(source.id, sampleId, true);
    h.ingestGeneric(source.id, { samples: [generic({ value: 200, revision: 2 })] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    assert.equal(h.exportData().samples[0].ignored, true);
    h.setSampleIgnored(source.id, sampleId, false); assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 200);
    const beforeConflict = h.exportData();
    fails(() => h.ingestGeneric(source.id, { samples: [generic({ external_id: 'new', value: 10 }), generic({ value: 300, revision: 2 })] }), 'SAMPLE_REVISION_CONFLICT');
    assert.deepEqual(h.exportData(), beforeConflict);
    fails(() => h.ingestGeneric(source.id, { request_id: 'a', samples: [generic({ value: 400 })] }), 'IDEMPOTENCY_CONFLICT');
    h.ingestGeneric(source.id, { deleted: [{ external_id: 'synthetic-1', revision: 3 }, { external_id: 'future', revision: 3 }] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    h.ingestGeneric(source.id, { samples: [generic({ revision: 2 }), generic({ external_id: 'future', revision: 2 })] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    h.ingestGeneric(source.id, { samples: [generic({ value: 400, revision: 4 })] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 400);
    h.ingestGeneric(source.id, { deleted: [{ external_id: 'synthetic-1', revision: 2 }] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 400);
  } finally { db.close(); }
});

test('generic stable fingerprint and same-source external IDs do not collide across connectors', () => {
  const { db, service: h } = setup();
  try {
    const a = h.createSource({ name: 'A', kind: 'generic' }).source, b = h.createSource({ name: 'B', kind: 'generic' }).source;
    const sample = generic(); delete (sample as any).external_id;
    h.ingestGeneric(a.id, { samples: [sample] });
    assert.equal(h.ingestGeneric(a.id, { request_id: 'retry-envelope', samples: [sample] }).unchanged, 1);
    h.ingestGeneric(b.id, { samples: [sample] }); assert.equal(h.exportData().samples.length, 2);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 100);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.source_id, b.id);
    const bad = generic({ value: -1 }); fails(() => h.ingestGeneric(a.id, { samples: [bad] }));
    fails(() => h.ingestGeneric(a.id, { samples: [generic({ start_at: '2026-10-20' })] }));
    fails(() => h.ingestGeneric(a.id, { samples: [generic({ end_at: '2026-10-20T07:00:00+08:00' })] }));
    fails(() => h.ingestGeneric(a.id, { samples: [generic({ unit: 'kg' })] }));
  } finally { db.close(); }
});

test('cross-connection summary selects latest enabled coverage per metric without XML + bridge addition', () => {
  const { db, service: h } = setup();
  try {
    const x = h.createSource({ name: 'XML', kind: 'apple_xml' }).source, a = h.createSource({ name: 'HAE', kind: 'health_auto_export' }).source;
    h.importXml(x.id, xml); h.ingestAutoExport(a.id, auto());
    const summary = h.dailySummary('2026-10-20').metrics;
    assert.equal(summary.steps.value, 4321); assert.equal(summary.steps.source_id, a.id); assert.equal(summary.steps.available_sources, 2);
    assert.equal(summary.workout.value, 30); assert.equal(summary.workout.source_id, x.id);
    // Re-receiving an older XML file does not make its coverage newer.
    h.importXml(x.id, xml.replace('16:00:00', '18:00:00'));
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.source_id, a.id);
    h.setSourceEnabled(a.id, false); assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 1300);
    h.setSourceEnabled(x.id, false); assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
  } finally { db.close(); }
});

test('aggregate source names and sample/aggregate representations are not added together', () => {
  const { db, service: h } = setup();
  try {
    const a = h.createSource({ name: 'HAE', kind: 'health_auto_export' }).source;
    h.ingestAutoExport(a.id, { data: { metrics: [{ name: 'step_count', units: 'count', data: [
      { date: '2026-10-20 12:00:00 +0800', qty: 100, source: 'Watch' }, { date: '2026-10-20 12:00:00 +0800', qty: 200, source: 'iPhone' },
    ] }] } });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 100);
    h.setSourceEnabled(a.id, false);
    const b = h.createSource({ name: 'Generic', kind: 'generic' }).source;
    h.ingestGeneric(b.id, { samples: [generic(), generic({ external_id: 'aggregate', record_kind: 'aggregate', value: 250 })] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 250);
  } finally { db.close(); }
});

test('timezone and DST are explicit; weight uses latest measurement, and invalid dates reject', () => {
  const { db, service: h } = setup('America/New_York');
  try {
    const { source } = h.createSource({ name: 'generic', kind: 'generic' });
    h.ingestGeneric(source.id, { samples: [
      generic({ external_id: 'dst-1', start_at: '2026-11-01T01:30:00-04:00', end_at: '2026-11-01T01:45:00-04:00', value: 10 }),
      generic({ external_id: 'dst-2', start_at: '2026-11-01T01:30:00-05:00', end_at: '2026-11-01T01:45:00-05:00', value: 20 }),
      generic({ external_id: 'before', start_at: '2026-11-01T03:30:00Z', end_at: '2026-11-01T03:45:00Z', value: 30 }),
      generic({ external_id: 'weight-1', metric: 'weight', unit: 'kg', value: 72 }),
      generic({ external_id: 'weight-2', metric: 'weight', unit: 'kg', value: 71, start_at: '2026-10-20T20:00:00Z', end_at: '2026-10-20T20:00:00Z' }),
    ] });
    assert.equal(h.dailySummary('2026-11-01').metrics.steps.value, 30);
    assert.equal(h.dailySummary('2026-10-31').metrics.steps.value, 30);
    assert.equal(h.dailySummary('2026-10-20').metrics.weight.value, 71);
    fails(() => h.dailySummary('2026-02-30')); fails(() => h.dailySummary('2026-10-20\n'));
  } finally { db.close(); }
});

test('file-backed restart preserves receipts, hashes, corrections and coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boji-health-'));
  let db = new DatabaseSync(join(dir, 'health.sqlite'));
  try {
    let h = new HealthService(db, 'Asia/Shanghai'); const { source, token } = h.createSource({ name: 'HAE', kind: 'health_auto_export' });
    const first = h.ingestAutoExport(source.id, auto()); const sample = h.exportData().samples.find(s => s.metric === 'steps')!;
    h.setSampleIgnored(source.id, sample.id, true); h.setSourcePriority(source.id, ['Synthetic Watch']);
    db.close(); db = new DatabaseSync(join(dir, 'health.sqlite')); h = new HealthService(db, 'Asia/Shanghai');
    assert.equal(h.authenticateSource(source.id, token), true);
    assert.equal(h.ingestAutoExport(source.id, auto()).run_id, first.run_id);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    assert.deepEqual(h.listSources().items[0].source_priority, ['Synthetic Watch']);
    assert.equal(h.listSources().items[0].coverage_complete, false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('size bounds and direct caller invalid JSON inputs return safe domain errors', () => {
  const { db, service: h } = setup();
  try {
    const a = h.createSource({ name: 'Generic', kind: 'generic' }).source, x = h.createSource({ name: 'XML', kind: 'apple_xml' }).source;
    fails(() => h.importXml(x.id, ' '.repeat(20 * 1024 * 1024 + 1)), 'PAYLOAD_TOO_LARGE');
    fails(() => h.ingestGeneric(a.id, { padding: 'x'.repeat(2 * 1024 * 1024) }), 'PAYLOAD_TOO_LARGE');
    const cycle: any = {}; cycle.self = cycle;
    for (const payload of [undefined, { value: NaN }, { value: Infinity }, { value: 1n }, cycle, new Date()]) fails(() => h.ingestGeneric(a.id, payload));
    assert.equal(h.exportData().samples.length, 0);
  } finally { db.close(); }
});


test('XML UUID corrections update the original row when device metadata changes', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    const original = `<HealthData>${record('Watch', '08:00', '09:00', 100).replace('<Record ', '<Record uuid="stable-id" ')}</HealthData>`;
    h.importXml(source.id, original);
    assert.equal(h.importXml(source.id, original.replace('value="100"', 'value="120"').replace('device=""', 'device="Watch v2"')).updated, 1);
    assert.equal(h.exportData().samples.length, 1);
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 120);
  } finally { db.close(); }
});

test('streaming file import exceeds 20 MiB, preserves metadata, reports partial and resumes without duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boji-health-large-test-'));
  const database = join(dir, 'health.sqlite'), file = join(dir, 'export.xml');
  const beforeSpools = readdirSync(tmpdir()).filter(name => name.startsWith('boji-health-import-')).sort();
  const db = new DatabaseSync(database);
  try {
    const h = new HealthService(db, 'Asia/Shanghai'); const { source } = h.createSource({ name: 'large XML', kind: 'apple_xml' });
    const padding = 'x'.repeat(7800);
    const records = Array.from({ length: 3000 }, (_, i) =>
      `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch &amp; App" device="Watch" unit="count" startDate="2026-10-20 08:00:00 +0800" endDate="2026-10-20 09:00:00 +0800" value="1"><MetadataEntry key="HKMetadataKeySyncIdentifier" value="large-${i}"/><MetadataEntry key="syntheticPadding" value="${padding}"/></Record>`).join('');
    const content = `<?xml version="1.0"?><!DOCTYPE HealthData [<!-- Synthetic export --><!ELEMENT HealthData (Record*)><!ELEMENT Record (MetadataEntry*)><!ATTLIST Record unit CDATA #IMPLIED>]><HealthData locale="en_US">${records}</HealthData>`;
    assert.ok(Buffer.byteLength(content) > 20 * 1024 * 1024);
    writeFileSync(file, content, { mode: 0o600 });
    fails(() => h.importXml(source.id, content), 'PAYLOAD_TOO_LARGE');
    const options = { file, database, sourceId: source.id, timezone: 'Asia/Shanghai' };
    const interrupted = await importHealthFile({ ...options, onBatch: () => { throw new Error('simulated-stop'); } });
    assert.equal(interrupted.status, 'partial'); assert.equal(interrupted.committed_batches, 1);
    assert.ok(interrupted.validated_batches > 1); assert.equal(interrupted.coverage_complete, false);
    const resumed = await importHealthFile(options);
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.replayed_batches, 1);
    assert.equal(resumed.file_sha256, interrupted.file_sha256); assert.equal(resumed.bytes_read, Buffer.byteLength(content));
    assert.equal(h.exportData().samples.length, 3000);
    assert.equal(h.exportData().samples[0].source_name, 'Watch & App');
    assert.ok(h.exportData().samples.every(row => row.external_id?.startsWith('large-')));
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 3000);
    const repeated = await importHealthFile(options);
    assert.equal(repeated.replayed_batches, repeated.validated_batches); assert.equal(repeated.inserted, 0);
    assert.equal(h.exportData().samples.length, 3000);
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('boji-health-import-')).sort(), beforeSpools);
  }
});

test('streaming validation rejects late bad records, malformed XML and unsafe DTDs before any target write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boji-health-cli-invalid-'));
  const database = join(dir, 'health.sqlite'), file = join(dir, 'export.xml');
  const db = new DatabaseSync(database);
  try {
    const h = new HealthService(db, 'Asia/Shanghai'); const { source } = h.createSource({ name: 'XML', kind: 'apple_xml' });
    const before = h.exportData();
    const records = Array.from({ length: 2100 }, (_, i) => record('Watch', '08:00', '09:00', i)).join('');
    for (const content of [
      `<HealthData>${records}${record('Watch', '08:00', '09:00', -1)}</HealthData>`,
      `<HealthData>${records}<Record></HealthData>`,
      '<!DOCTYPE HealthData [<!ENTITY x SYSTEM "file:///private">]><HealthData/>',
    ]) {
      writeFileSync(file, content, { mode: 0o600 });
      await assert.rejects(importHealthFile({ file, database, sourceId: source.id, timezone: 'Asia/Shanghai' }), HealthError);
      assert.deepEqual(h.exportData(), before);
    }
    writeFileSync(file, xml, { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-health.ts', '--file', file, '--database', database, '--source', source.id, '--timezone', 'Asia/Shanghai'], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).status, 'completed');
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 1300);
    const invalidArgs = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/import-health.ts', '--file', file], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
    assert.equal(invalidArgs.status, 1); assert.equal(JSON.parse(invalidArgs.stderr).code, 'INVALID_IMPORT_ARGUMENTS');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('daily summary uses indexed paths and excludes disabled/deleted/ignored records', () => {
  const { db, service: h } = setup();
  try {
    const { source } = h.createSource({ name: 'summary regression', kind: 'generic' });
    h.ingestGeneric(source.id, { samples: [generic()] });
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, 100);
    assert.equal(h.dailySummary('2026-11-13').metrics.steps.value, null);
    db.prepare('UPDATE health_samples SET ignored=1').run();
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    db.prepare('UPDATE health_samples SET ignored=0, deleted=1').run();
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    db.prepare('UPDATE health_samples SET deleted=0').run();
    db.prepare('UPDATE health_sources SET enabled=0').run();
    assert.equal(h.dailySummary('2026-10-20').metrics.steps.value, null);
    const code = readFileSync(new URL('../src/health.ts', import.meta.url), 'utf8');
    const sql = code.slice(code.indexOf('dailySummary(date:')).match(/prepare\(`([\s\S]*?)`\)/)![1];
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all('2026-11-12', '2026-11-15', '2026-11-12', '2026-11-15');
    assert.ok(!plan.some(row => /SCAN h\b/.test(String(row.detail))), JSON.stringify(plan));
    assert.ok(plan.some(row => String(row.detail).includes('health_samples_day')));
    assert.ok(plan.some(row => String(row.detail).includes('health_samples_source')));
  } finally { db.close(); }
});
