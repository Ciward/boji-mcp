import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HealthError, HealthService, createHealthXmlParser, type HealthReceipt } from '../src/health.js';

const chunkBytes = 4 * 1024 * 1024;
const maxElementBytes = 16 * 1024 * 1024;
const chunkRecords = 2000;
export interface FileImportReceipt {
  status: 'completed' | 'partial'; source_id: string; file_sha256: string; bytes_read: number;
  validated_batches: number; committed_batches: number; replayed_batches: number;
  inserted: number; updated: number; skipped: number; unchanged: number;
  coverage_complete: false; resumable: true; code?: string;
}
export interface ImportHealthFileOptions {
  file: string; database: string; sourceId: string; timezone: string; signal?: AbortSignal;
  onBatch?: (progress: { batch: number; total: number; receipt: HealthReceipt }) => void;
}
const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  .replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;');
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function safeError(error: unknown): HealthError {
  return error instanceof HealthError ? error : new HealthError(500, 'HEALTH_FILE_IMPORT_ERROR', '本地健康文件导入未完成；检查文件和数据库权限后重试。');
}

/** Two phases: validate every spooled batch before opening the target DB for writes, then persist bounded batches. */
export async function importHealthFile(options: ImportHealthFileOptions): Promise<FileImportReceipt> {
  const { file, database, sourceId, timezone, signal } = options;
  if (typeof file !== 'string' || typeof database !== 'string' || typeof sourceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId)) {
    throw new HealthError(400, 'INVALID_IMPORT_ARGUMENTS', '需要本地 XML 路径、现有数据库路径和 apple_xml 来源 ID。');
  }
  let staging: string | undefined, validation: DatabaseSync | undefined, target: DatabaseSync | undefined;
  try {
    if (!(await stat(file)).isFile() || !(await stat(database)).isFile()) throw new HealthError(400, 'INVALID_IMPORT_FILE', '输入和数据库必须是现有普通文件。');
    // Read-only preflight. This operator CLI uses local database access, never an HTTP ingest token.
    const readOnly = new DatabaseSync(database, { readOnly: true });
    try {
      const source = readOnly.prepare('SELECT kind,enabled FROM health_sources WHERE id=?').get(sourceId);
      if (!source || source.kind !== 'apple_xml' || source.enabled !== 1) throw new HealthError(400, 'INVALID_IMPORT_SOURCE', '目标必须是现有、启用的 apple_xml 来源。');
    } finally { readOnly.close(); }
    validation = new DatabaseSync(':memory:');
    const validator = new HealthService(validation, timezone);
    const validationId = validator.createSource({ name: 'local-file-validation', kind: 'apple_xml' }).source.id;
    staging = await mkdtemp(join(tmpdir(), 'boji-health-import-'));
    await chmod(staging, 0o700);
    const manifest: { name: string; sha256: string }[] = [];
    let root = '<HealthData>', fragment = '', fragmentBytes = 0, pending = '', pendingBytes = 0, pendingCount = 0;
    let topElementCount = 0, totalBytes = 0, bytesSinceElement = 0;
    const queue: string[] = [];
    const fileHash = createHash('sha256');
    const queueBatch = () => {
      if (!pendingCount) return;
      queue.push(`${root}${pending}</HealthData>`);
      pending = ''; pendingBytes = 0; pendingCount = 0;
    };
    const addFragment = (value: string) => {
      fragmentBytes += Buffer.byteLength(value);
      if (fragmentBytes > maxElementBytes) throw new HealthError(413, 'XML_ELEMENT_TOO_LARGE', '单个 XML 顶层元素超过 16 MiB；不能安全拆分这个元素。');
      fragment += value;
    };
    const parser = createHealthXmlParser({
      open: (tag, depth) => {
        const attributes = Object.entries(tag.attributes).map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join('');
        if (depth === 1) { root = `<HealthData${attributes}>`; return; }
        if (depth === 2) { fragment = ''; fragmentBytes = 0; }
        addFragment(`<${tag.name}${attributes}>`);
      },
      close: (tag, depth) => {
        if (depth < 2) return;
        addFragment(`</${tag.name}>`);
        if (depth !== 2) return;
        topElementCount++; bytesSinceElement = 0;
        if (pendingCount && (pendingBytes + fragmentBytes > chunkBytes || pendingCount >= chunkRecords)) queueBatch();
        pending += fragment; pendingBytes += fragmentBytes; pendingCount++;
        fragment = ''; fragmentBytes = 0;
        if (pendingBytes >= chunkBytes || pendingCount >= chunkRecords) queueBatch();
      },
    });
    const spoolQueue = async () => {
      while (queue.length) {
        signal?.throwIfAborted();
        const xml = queue.shift()!;
        validation!.exec('SAVEPOINT health_file_validate');
        try { validator.importXml(validationId, xml); }
        finally { validation!.exec('ROLLBACK TO health_file_validate; RELEASE health_file_validate'); }
        const name = `${manifest.length.toString().padStart(10, '0')}.xml`;
        await writeFile(join(staging!, name), xml, { flag: 'wx', mode: 0o600 });
        manifest.push({ name, sha256: digest(xml) });
      }
    };
    const stream = createReadStream(file, { highWaterMark: 64 * 1024, signal });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const buffer of stream) {
      const bytes = buffer as Buffer;
      totalBytes += bytes.length; fileHash.update(bytes); bytesSinceElement += bytes.length;
      // Bound incomplete SAX tokens as well as completed elements; limits do not apply to the whole file.
      if (bytesSinceElement > maxElementBytes + 64 * 1024) throw new HealthError(413, 'XML_ELEMENT_TOO_LARGE', 'XML 标记或元素超过流式解析边界。');
      parser.write(decoder.decode(bytes, { stream: true }));
      await spoolQueue();
    }
    parser.write(decoder.decode()).close();
    queueBatch();
    if (topElementCount === 0) queue.push(`${root}</HealthData>`);
    await spoolQueue();
    signal?.throwIfAborted();
    const receipt: FileImportReceipt = { status: 'completed', source_id: sourceId, file_sha256: fileHash.digest('hex'), bytes_read: totalBytes,
      validated_batches: manifest.length, committed_batches: 0, replayed_batches: 0, inserted: 0, updated: 0, skipped: 0, unchanged: 0,
      coverage_complete: false, resumable: true };
    try {
      target = new DatabaseSync(database); target.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      const health = new HealthService(target, timezone);
      for (let index = 0; index < manifest.length; index++) {
        signal?.throwIfAborted();
        const entry = manifest[index], text = await readFile(join(staging, entry.name), 'utf8');
        if (digest(text) !== entry.sha256) throw new HealthError(409, 'IMPORT_SPOOL_CHANGED', '本地暂存批次校验失败。');
        const result = health.importXml(sourceId, text);
        receipt.committed_batches++;
        if (result.replayed) receipt.replayed_batches++;
        else { receipt.inserted += result.inserted; receipt.updated += result.updated; receipt.skipped += result.skipped; receipt.unchanged += result.unchanged; }
        options.onBatch?.({ batch: index + 1, total: manifest.length, receipt: result });
      }
      return receipt;
    } catch (error) {
      return { ...receipt, status: 'partial', code: safeError(error).code };
    }
  } catch (error) { throw safeError(error); }
  finally {
    target?.close(); validation?.close();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const flags: Record<string, string> = {};
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('用法：npm run import:health -- --file /path/export.xml --database /path/boji.sqlite --source SOURCE_UUID [--timezone Asia/Shanghai]');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    if (!['--file', '--database', '--source', '--timezone'].includes(args[index]) || !args[index + 1] || flags[args[index]]) {
      throw new HealthError(400, 'INVALID_IMPORT_ARGUMENTS', '使用 --help 查看导入参数。');
    }
    flags[args[index]] = args[index + 1];
  }
  if (!flags['--file'] || !flags['--database'] || !flags['--source']) throw new HealthError(400, 'INVALID_IMPORT_ARGUMENTS', '必须指定 --file、--database 和 --source。');
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const result = await importHealthFile({ file: resolve(flags['--file']), database: resolve(flags['--database']), sourceId: flags['--source'],
      timezone: flags['--timezone'] ?? 'Asia/Shanghai', signal: abort.signal,
      onBatch: ({ batch, total, receipt }) => console.error(JSON.stringify({ event: 'batch', batch, total, run_id: receipt.run_id, replayed: receipt.replayed })),
    });
    console.log(JSON.stringify(result));
    if (result.status !== 'completed') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { const safe = safeError(error); console.error(JSON.stringify({ status: 'failed', code: safe.code, message: safe.message })); process.exitCode = 1; });
}
