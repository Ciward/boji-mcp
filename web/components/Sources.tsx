import React, { useCallback, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api';
import { prettyInstant } from '../model';
import type { Api, Source } from '../types';
import { EmptyState, ErrorNotice, Icon, Loading, Modal, useRemote } from './ui';

export const sourceKinds = { apple_xml: 'Apple 健康 XML', health_auto_export: 'Health Auto Export', generic: '通用健康来源' } as const;
const metricNames: Record<string, string> = { steps: '步数', step_count: '步数', heart_rate: '心率', weight: '体重', weight_kg: '体重', body_mass: '体重', sleep: '睡眠', active_energy: '活动能量', active_energy_kcal: '活动能量', resting_energy: '静息能量', resting_energy_kcal: '静息能量', exercise: '运动', water: '饮水' };
const countNames: Record<string, string> = { imported: '已导入', inserted: '新增', updated: '已更新', skipped: '跳过', duplicates: '重复', duplicate: '重复', rejected: '未接收', errors: '错误', total: '总计', parsed: '已解析', unsupported: '不支持的记录' };

export default function Sources({ api, timezone, enabled, revision, onChanged }: { api: Api; timezone: string; enabled: boolean; revision: number; onChanged: () => void }) {
  const load = useCallback((signal: AbortSignal) => { void revision; return api<{ items: Source[] }>('/sources', { signal }); }, [api, revision]);
  const sources = useRemote(load, enabled);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Source['kind']>('apple_xml');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [credential, setCredential] = useState<{ source: Source; token: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const importingRef = useRef(false);
  const [importResult, setImportResult] = useState<Record<string, string>>({});
  const [importError, setImportError] = useState<Record<string, string>>({});
  const [sourceAction, setSourceAction] = useState<{ source: Source; action: 'revoke' | 'enable' | 'disable' } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(null);
    try {
      const result = await api<{ source: Source; token: string }>('/sources', { method: 'POST', body: JSON.stringify({ name: name.trim(), kind }) });
      if (!result.source?.id || !result.token) throw new Error('来源创建响应不完整。请刷新列表核实后再操作。');
      setCredential(result); setCopyStatus(''); setCreating(false); setName(''); onChanged();
    } catch (reason) {
      setError(`${errorMessage(reason)}${reason instanceof ApiError && reason.status === 401 ? '' : ' 若请求已送达但回执丢失，请先刷新来源列表核实，避免重复创建。'}`);
    } finally { pendingRef.current = false; setPending(false); }
  }

  async function updateSource() {
    if (!sourceAction || actionBusy) return;
    setActionBusy(true); setError(null);
    try {
      if (sourceAction.action === 'revoke') await api(`/sources/${encodeURIComponent(sourceAction.source.id)}/revoke`, { method: 'POST' });
      else await api(`/sources/${encodeURIComponent(sourceAction.source.id)}`, { method: 'PUT', body: JSON.stringify({ enabled: sourceAction.action === 'enable' }) });
      setSourceAction(null); onChanged();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setActionBusy(false); }
  }

  async function importXml(source: Source) {
    const file = files[source.id];
    if (!file || importingRef.current) return;
    importingRef.current = true; setImporting(source.id);
    setImportError((previous) => ({ ...previous, [source.id]: '' }));
    setImportResult((previous) => ({ ...previous, [source.id]: '' }));
    try {
      const result = await api<Record<string, unknown>>(`/sources/${encodeURIComponent(source.id)}/import-xml`, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: file });
      const counts = result.counts && typeof result.counts === 'object' ? result.counts as Record<string, unknown> : result;
      const summary = Object.entries(counts).filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => `${countNames[key] || key} ${value}`).join('，');
      setImportResult((previous) => ({ ...previous, [source.id]: summary || '服务器已接收文件；请查看来源的最新接收与覆盖时间。' }));
      setFiles((previous) => ({ ...previous, [source.id]: undefined })); onChanged();
    } catch (reason) { setImportError((previous) => ({ ...previous, [source.id]: errorMessage(reason) })); }
    finally { importingRef.current = false; setImporting(null); }
  }

  return <section className="sources-page"><div className="section-heading"><div><h2>让日常数据汇入这里</h2><p>连接你的来源，保留每一份记录的来处。</p></div><button className="button primary" disabled={!!credential} onClick={() => { setCreating(true); setError(null); }}><Icon name="plus" />添加来源</button></div>
    {credential && <section className="credential-panel" aria-label="新来源凭证"><div className="section-heading compact"><h3>{credential.source.name} 已创建</h3><Icon name="lock" /></div><p>请现在保存上传凭证。关闭后不会再次显示；它仅用于此来源的数据上传。</p><textarea readOnly aria-label="仅显示一次的上传凭证" value={credential.token} rows={3} spellCheck={false} autoComplete="off" onFocus={(event) => event.target.select()} /><div className="credential-actions"><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(credential.token); setCopyStatus('已复制到剪贴板'); } catch { setCopyStatus('无法自动复制，请选中文本手动复制。'); } }}><Icon name="copy" size={17} />复制凭证</button><button className="button primary" onClick={() => { setCredential(null); setCopyStatus(''); }}>我已保存，关闭凭证</button></div><p className="field-hint" role="status">{copyStatus}</p></section>}
    {sources.loading && <Loading text="正在读取数据来源…" />}{sources.error && <ErrorNotice message={sources.error} onRetry={sources.retry} />}
    {sources.data && sources.data.items.length === 0 && <EmptyState title="给健康记录一个来源" icon="source" action={<button className="button secondary" onClick={() => setCreating(true)}>添加第一个来源</button>}>可以先从 Apple 健康导出的 XML 开始，或为手机桥接工具建立上传来源。</EmptyState>}
    <div className="source-list">{sources.data?.items.map((source) => {
      const metrics = Array.isArray(source.metrics) ? source.metrics : Object.keys(source.metrics || {});
      const ingestUrl = `${window.location.origin}/ingest/v1/${source.id}`;
      return <article className="source-card" key={source.id}><div className="source-heading"><span className="source-symbol"><Icon name="source" size={25} /></span><div><h3>{source.name}</h3><p>{sourceKinds[source.kind] || source.kind}</p></div><span className={`pill ${source.revoked ? 'danger-pill' : source.enabled ? '' : 'neutral'}`}>{source.revoked ? '凭证已撤销' : source.enabled ? '已启用' : '已停用'}</span></div>
        <dl className="source-dates"><div><dt>最近接收</dt><dd>{prettyInstant(source.last_received_at, timezone)}</dd></div><div><dt>数据覆盖至</dt><dd>{prettyInstant(source.coverage_end, timezone)}</dd></div></dl>
        <p className="field-hint">接收时间不代表数据覆盖到了当前时刻。</p>
        {metrics.length > 0 ? <div className="metric-tags">{metrics.map((metric) => <span key={metric}>{metricNames[metric] || metric}</span>)}</div> : <p className="muted small">尚未提供指标范围</p>}
        {source.stale === true && <p className="warning-text">来源提示数据已过期，请检查设备上传状态。</p>}
        {typeof source.last_error === 'string' && source.last_error && <ErrorNotice message={source.last_error} />}
        <div className="ingest-url"><div><span className="field-label">Bridge ingest URL</span><code>{ingestUrl}</code></div><button type="button" className="icon-button" aria-label="复制 bridge ingest URL" onClick={async () => { try { await navigator.clipboard.writeText(ingestUrl); setCopyStatus('上传地址已复制'); } catch { setCopyStatus('无法自动复制上传地址，请手动选择。'); } }}><Icon name="copy" size={17} /></button></div>
        {source.kind === 'apple_xml' && <div className="xml-import"><label htmlFor={`xml-${source.id}`}><Icon name="upload" size={18} />导入 Apple 健康 XML</label><p className="field-hint">从健康 App 导出并解压，选择 export.xml。文件将直接发送至你的 Boji 服务。</p>
          <input id={`xml-${source.id}`} type="file" accept=".xml,application/xml,text/xml" disabled={!source.enabled || importing !== null} onChange={(event) => setFiles((previous) => ({ ...previous, [source.id]: event.target.files?.[0] }))} />
          {files[source.id] && <p className="small selected-file">待导入：{files[source.id]?.name}</p>}
          <button type="button" className="button secondary" disabled={!source.enabled || !files[source.id] || importing !== null} onClick={() => importXml(source)}>{importing === source.id ? '正在导入，请稍候…' : '上传并导入'}</button>
        </div>}
        {source.kind !== 'apple_xml' && <p className="source-footnote">在设备的桥接工具中配置此来源凭证和上传地址。是否持续更新，以实际收到的数据为准。</p>}
        <div className="source-controls">{source.revoked ? <span className="muted small">凭证已撤销，需重新创建来源。</span> : <>{source.enabled ? <button type="button" className="text-button muted" onClick={() => setSourceAction({ source, action: 'disable' })}>暂停接收</button> : <button type="button" className="text-button" onClick={() => setSourceAction({ source, action: 'enable' })}>恢复接收</button>}<button type="button" className="text-button danger-text" onClick={() => setSourceAction({ source, action: 'revoke' })}>撤销凭证</button></>}</div>
        {importError[source.id] && <ErrorNotice message={importError[source.id]} />}{importResult[source.id] && <p className="success-note" role="status">导入回执：{importResult[source.id]}</p>}
      </article>;
    })}</div>
    {sourceAction && <Modal title={sourceAction.action === 'revoke' ? '撤销这个来源的凭证？' : sourceAction.action === 'enable' ? '恢复这个来源？' : '暂停这个来源？'} onClose={() => { if (!actionBusy) setSourceAction(null); }} busy={actionBusy}><div className="modal-body">{error && <ErrorNotice message={error} />}<p>{sourceAction.action === 'revoke' ? '撤销后，当前 bridge ingest URL 和凭证都不能继续接收数据；已经导入的健康记录会保留。' : sourceAction.action === 'enable' ? '恢复后，使用有效凭证发送的新数据会继续进入 Boji。' : '暂停后，来源的上传请求会被拒绝；已经导入的健康记录会保留。'}</p></div><footer className="modal-footer"><button type="button" className="button secondary" disabled={actionBusy} onClick={() => setSourceAction(null)}>取消</button><button type="button" className={`button ${sourceAction.action === 'revoke' ? 'danger' : 'primary'}`} disabled={actionBusy} onClick={updateSource}>{actionBusy ? '正在处理…' : sourceAction.action === 'revoke' ? '撤销凭证' : sourceAction.action === 'enable' ? '恢复接收' : '暂停接收'}</button></footer></Modal>}
    {creating && enabled && <Modal title="添加一个数据来源" onClose={() => setCreating(false)} busy={pending}><form onSubmit={create}><div className="modal-body">{error && <ErrorNotice message={error} />}<fieldset className="plain-fieldset" disabled={pending}><div className="field"><label htmlFor="source-name">来源名称</label><input id="source-name" value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} placeholder="例如：我的 Apple 健康" autoFocus /></div><div className="field"><label htmlFor="source-kind">接入方式</label><select id="source-kind" value={kind} onChange={(event) => setKind(event.target.value as Source['kind'])}>{Object.entries(sourceKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><p className="info-note">创建后将显示一次上传凭证，请及时保存。</p></fieldset></div><footer className="modal-footer"><button type="button" className="button secondary" disabled={pending} onClick={() => setCreating(false)}>收起</button><button type="submit" className="button primary" disabled={pending || !name.trim()}>{pending ? '正在创建…' : '创建来源'}</button></footer></form></Modal>}
  </section>;
}
