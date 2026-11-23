import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { HealthService } from '../src/health.js';
import { readFileSync } from 'node:fs';

function legacyKey(metric:string, source:string, device:string, external:string) {
  return `xml-id:${createHash('sha256').update(JSON.stringify([metric,source,device,external])).digest('hex')}`;
}
function resetRuns(db: DatabaseSync, sourceId: string) { db.prepare('DELETE FROM health_runs WHERE source_id=?').run(sourceId); }

test('legacy XML sample keys remain compatible without duplication on re-import', () => {
  const db = new DatabaseSync(':memory:');
  const health = new HealthService(db, 'Asia/Shanghai');
  const source = health.createSource({ name: 'legacy', kind: 'apple_xml' }).source;
  const xml = readFileSync('fixtures/health/apple-export.xml', 'utf8');
  const receipt = health.importXml(source.id, xml);
  const rows = db.prepare("SELECT id,metric,source_name,device,external_id FROM health_samples WHERE source_id=? AND external_id IS NOT NULL ORDER BY id").all(source.id) as any[];
  assert.ok(rows.length > 0);
  for (const row of rows) db.prepare('UPDATE health_samples SET sample_key=? WHERE id=?').run(legacyKey(row.metric,row.source_name,row.device,row.external_id), row.id);
  db.prepare('DELETE FROM health_migrations WHERE version=3').run();
  new HealthService(db, 'Asia/Shanghai');
  const before = Number((db.prepare('SELECT count(*) AS n FROM health_samples WHERE source_id=?').get(source.id) as any).n);
  resetRuns(db, source.id);
  const replay = new HealthService(db, 'Asia/Shanghai').importXml(source.id, xml);
  const after = Number((db.prepare('SELECT count(*) AS n FROM health_samples WHERE source_id=?').get(source.id) as any).n);
  assert.equal(before, receipt.inserted);
  assert.equal(after, before);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.updated + replay.unchanged >= receipt.inserted, true);
  db.close();
});

test('ambiguous legacy external IDs are preserved and matched by value, not string shape', () => {
  const db = new DatabaseSync(':memory:');
  const health = new HealthService(db, 'Asia/Shanghai');
  const source = health.createSource({ name: 'legacy ambiguous', kind: 'apple_xml' }).source;
  const xml = `<HealthData><ExportDate value="2026-10-20 12:00:00 +0800"/><Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" device="iPhone" unit="count" value="10" startDate="2026-10-20 10:00:00 +0800" endDate="2026-10-20 10:00:00 +0800" uuid="stable-id"/><Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" device="iPhone" unit="count" value="20" startDate="2026-10-20 11:00:00 +0800" endDate="2026-10-20 11:00:00 +0800"><MetadataEntry key="HKMetadataKeySyncIdentifier" value="550e8400-e29b-41d4-a716-446655440000"/></Record></HealthData>`;
  const first = health.importXml(source.id, xml);
  const rows = db.prepare("SELECT id,metric,source_name,device,external_id FROM health_samples WHERE source_id=? ORDER BY start_at").all(source.id) as any[];
  assert.equal(rows.length,2);
  for (const row of rows) db.prepare('UPDATE health_samples SET sample_key=? WHERE id=?').run(legacyKey(row.metric,row.source_name,row.device,row.external_id), row.id);
  resetRuns(db, source.id);
  const replay = new HealthService(db, 'Asia/Shanghai').importXml(source.id, xml);
  const count = Number((db.prepare('SELECT count(*) AS n FROM health_samples WHERE source_id=?').get(source.id) as any).n);
  assert.equal(count,2);
  assert.equal(replay.inserted,0);
  assert.equal(replay.unchanged,2);
  assert.equal(first.inserted,2);
  db.close();
});
