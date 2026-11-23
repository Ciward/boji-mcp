import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api';
import { createSaveKeys, formatNumber, prettyInstant, dateTimeLocal, localToIso } from '../model';
import { confidenceTypes, foodEvidenceTypes, nutrientFields } from '../types';
import type { Api, Food, FoodInput, FoodList, FoodRevision, Nutrients, PersistedFood } from '../types';
import { EmptyState, ErrorNotice, Icon, Loading, Modal, useRemote } from './ui';

interface Props { api: Api; timezone: string; authenticated: boolean; visible: boolean; revision: number }
type Draft = Omit<FoodInput, 'amount_g' | 'nutrients' | 'verified_at'> & { amount_g: string; nutrients: Record<keyof Nutrients, string>; verified_at: string; id?: string; version?: number; originalVerified?: string | null };
const initialDraft = (): Draft => ({ kind: 'food', name: '', aliases: [], restaurant_name: null, variant: '', serving_label: '1份', amount_g: '', nutrients: Object.fromEntries(nutrientFields.map(({ key }) => [key, ''])) as Draft['nutrients'], confidence: 'medium', evidence: 'manual', notes: '', source_urls: [], verified_at: '' });
const toDraft = (food: Food, timezone: string): Draft => ({ ...food, aliases: [...food.aliases], source_urls: [...food.source_urls], amount_g: food.amount_g == null ? '' : String(food.amount_g), nutrients: Object.fromEntries(nutrientFields.map(({ key }) => [key, food.nutrients[key] == null ? '' : String(food.nutrients[key])])) as Draft['nutrients'], verified_at: food.verified_at ? dateTimeLocal(food.verified_at, timezone) : '', originalVerified: food.verified_at });
function toInput(draft: Draft, timezone: string): FoodInput {
  const amount = draft.amount_g.trim() === '' ? null : Number(draft.amount_g);
  if (!draft.name.trim()) throw new Error('请填写食物或菜品名称。');
  if (!draft.serving_label.trim()) throw new Error('请填写参考份量。');
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('份量克重需要是大于或等于 0 的数字，未知请留空。');
  const nutrients = Object.fromEntries(nutrientFields.map(({ key, label }) => {
    const value = draft.nutrients[key].trim() === '' ? null : Number(draft.nutrients[key]);
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${label}需要是大于或等于 0 的数字，未知请留空。`);
    return [key, value];
  })) as Nutrients;
  const urls = draft.source_urls.map((url) => url.trim()).filter(Boolean);
  if (['web_research', 'restaurant_menu'].includes(draft.evidence) && !urls.length) throw new Error('网络查证或餐厅菜单来源至少需要一个 HTTP(S) 链接。');
  for (const value of urls) {
      try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
      catch { throw new Error('来源链接必须是无凭证的 HTTP(S) URL。'); }
  }
  const verified = !draft.verified_at.trim() ? null : draft.originalVerified && dateTimeLocal(draft.originalVerified, timezone) === draft.verified_at ? draft.originalVerified : localToIso(draft.verified_at, timezone);
  return { kind: draft.kind, name: draft.name.trim(), aliases: draft.aliases.map((item) => item.trim()).filter(Boolean), restaurant_name: draft.restaurant_name?.trim() || null, variant: draft.variant.trim(), serving_label: draft.serving_label.trim(), amount_g: amount, nutrients, confidence: draft.confidence, evidence: draft.evidence, notes: draft.notes.trim(), source_urls: urls, verified_at: verified };
}
const evidenceLabel = (value: FoodInput['evidence']) => foodEvidenceTypes[value] || value;
const foodPath = (id: string) => `/foods/${encodeURIComponent(id)}`;
function mergeFoodDraft(base: Food, local: Draft, latest: Food, timezone: string): Draft {
  const baseDraft = toDraft(base, timezone);
  const latestDraft = toDraft(latest, timezone);
  const merged = { ...latestDraft, id: latest.id, version: latest.version } as Draft;
  const fields: (keyof FoodInput)[] = ['kind', 'name', 'aliases', 'restaurant_name', 'variant', 'serving_label', 'amount_g', 'confidence', 'evidence', 'notes', 'source_urls', 'verified_at'];
  for (const field of fields) {
    const baseValue = field === 'verified_at' ? baseDraft.verified_at : baseDraft[field];
    const localValue = field === 'verified_at' ? local.verified_at : local[field];
    if (JSON.stringify(localValue) !== JSON.stringify(baseValue)) Object.assign(merged, { [field]: localValue });
  }
  const nutrients = { ...latestDraft.nutrients };
  for (const { key } of nutrientFields) {
    if (local.nutrients[key] !== baseDraft.nutrients[key]) nutrients[key] = local.nutrients[key];
  }
  merged.nutrients = nutrients;
  if (local.verified_at === baseDraft.verified_at) merged.originalVerified = latest.verified_at;
  return merged;
}

export default function FoodLibrary({ api, timezone, authenticated, visible, revision }: Props) {
  const [query, setQuery] = useState('');
  const [restaurant, setRestaurant] = useState('');
  const [kind, setKind] = useState<'' | FoodInput['kind']>('');
  const [archived, setArchived] = useState(false);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [baseSnapshot, setBaseSnapshot] = useState<Food | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Food | null>(null);
  const [latestLoading, setLatestLoading] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionConflict, setActionConflict] = useState(false);
  const [actionLatest, setActionLatest] = useState<Food | null>(null);
  const [history, setHistory] = useState<FoodRevision[] | null>(null);
  const [historyFood, setHistoryFood] = useState<Food | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionFood, setActionFood] = useState<Food | null>(null);
  const [toast, setToast] = useState('');
  const keys = useRef(createSaveKeys());
  const lock = useRef(false);
  const params = new URLSearchParams({ query, archived: String(archived), limit: '20', offset: String(offset) });
  if (kind) params.set('kind', kind);
  if (restaurant.trim()) params.set('restaurant_name', restaurant.trim());
  const search = params.toString();
  const load = useCallback(async (signal: AbortSignal) => { void revision; return api<FoodList>(`/foods?${search}`, { signal }); }, [api, search, revision]);
  const remote = useRemote(load, authenticated && visible);

  useEffect(() => {
    if (!draft) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft]);
  function begin(food?: Food) {
    if (!draft) { setError(null); setConflict(false); setLatest(null); setBaseSnapshot(food || null); setDiscarding(false); setDraft(food ? toDraft(food, timezone) : initialDraft()); }
    else setToast('已打开未保存草稿。保存或放弃后，再选择其他条目。');
    setEditorOpen(true);
  }
  const openNew = () => begin();
  const openEdit = (food: Food) => begin(food);
  function closeEditor() { if (!lock.current) setEditorOpen(false); }
  function patch(patch: Partial<Draft>) { setDraft((current) => current ? { ...current, ...patch } : current); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft || lock.current) return;
    setError(null);
    try {
      const item = toInput(draft, timezone);
      const id = draft.id;
      const version = draft.version;
      const scope = id ? `food-edit:${id}` : 'food-new';
      const payload = id ? { expected_version: version, item } : { item };
      const key = keys.current.forPayload(scope, payload);
      lock.current = true; setPending('save');
      const result = await api<PersistedFood>(id ? foodPath(id) : '/foods', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ idempotency_key: key, ...payload }) });
      if (result?.persisted !== true || !result.item?.id || !Number.isInteger(result.item.version)) throw new Error('未收到完整的保存回执。草稿已保留，请使用相同内容重试。');
      keys.current.complete(scope); setDraft(null); setBaseSnapshot(null); setDiscarding(false); setEditorOpen(false); setConflict(false); setLatest(null); setToast(`「${result.item.name}」已保存 · 版本 ${result.item.version}`); remote.retry();
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && ['version_conflict', 'VERSION_CONFLICT'].includes(reason.code)) { setConflict(true); setLatest(null); }
    } finally { lock.current = false; setPending(null); }
  }
  async function loadLatest() {
    const id = draft?.id;
    if (!id) return;
    setLatestLoading(true); setError(null);
    try { const result = await api<{ item: Food }>(foodPath(id)); setLatest(result.item); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setLatestLoading(false); }
  }
  function reconcile(useServer: boolean) {
    if (!latest || !draft) return;
    const merged = useServer || !baseSnapshot ? toDraft(latest, timezone) : mergeFoodDraft(baseSnapshot, draft, latest, timezone);
    setDraft(merged); setBaseSnapshot(latest);
    setConflict(false); setLatest(null); setError(null);
  }
  async function changeArchive(food: Food, restore: boolean) {
    if (lock.current) return;
    lock.current = true; setPending(food.id); setError(null);
    const action = restore ? 'restore' : 'delete'; const scope = `food-${action}:${food.id}`; const payload = { expected_version: food.version };
    try {
      const result = await api<PersistedFood>(`${foodPath(food.id)}/${action}`, { method: 'POST', body: JSON.stringify({ idempotency_key: keys.current.forPayload(scope, payload), ...payload }) });
      if (result?.persisted !== true || result.item?.id !== food.id) throw new Error('未收到完整的保存回执，请稍后重试。');
      keys.current.complete(scope); setActionFood(null); setActionConflict(false); setActionLatest(null); setToast(restore ? `「${food.name}」已恢复` : `「${food.name}」已归档`); remote.retry();
    } catch (reason) { setError(errorMessage(reason)); if (reason instanceof ApiError && ['version_conflict', 'VERSION_CONFLICT'].includes(reason.code)) { setActionConflict(true); setActionLatest(null); remote.retry(); } }
    finally { lock.current = false; setPending(null); }
  }
  async function showHistory(food: Food) {
    setHistoryFood(food); setHistory(null); setError(null);
    try { const result = await api<{ items: FoodRevision[] }>(`${foodPath(food.id)}/history`); setHistory(result.items); }
    catch (reason) { setError(errorMessage(reason)); }
  }

  return <section className="food-library" hidden={!visible} aria-label="食物库">
    <div className="food-library-intro"><div><p className="greeting">记下常吃的味道与份量</p><h2>我的食物库</h2><p>个人常用食物与餐厅菜品。未知营养保持为空，后续可以继续核实。</p></div><button className="button primary" type="button" onClick={openNew}><Icon name="plus" size={18} />新增条目</button></div>
    {draft && !editorOpen && <div className="draft-banner"><div><Icon name="edit" size={18} /><span>有一份未保存的食物库草稿</span></div><button type="button" className="text-button" onClick={() => setEditorOpen(true)}>继续编辑食物库草稿</button></div>}
    <div className="food-filters"><div className="field"><label htmlFor="food-query">名称、别名或餐厅</label><input id="food-query" type="search" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="搜索常吃的食物" /></div><div className="field"><label htmlFor="food-restaurant">餐厅</label><input id="food-restaurant" value={restaurant} onChange={(event) => { setRestaurant(event.target.value); setOffset(0); }} placeholder="按餐厅筛选" /></div><div className="field"><label htmlFor="food-kind">类型</label><select id="food-kind" value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setOffset(0); }}><option value="">全部</option><option value="food">食物</option><option value="dish">菜品</option></select></div><label className="food-archived-toggle"><input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); setOffset(0); }} />显示已归档</label></div>
    {error && !editorOpen && !actionFood && !historyFood && <ErrorNotice message={error} />}
    {remote.loading && <Loading text="正在读取食物库…" />}{remote.error && <ErrorNotice message={remote.error} onRetry={remote.retry} />}
    {remote.data && remote.data.items.length === 0 && <EmptyState icon="leaf" title={archived ? '没有已归档条目' : '食物库还是空的'} action={!archived ? <button type="button" className="button secondary" onClick={openNew}>添加第一项</button> : undefined}>{archived ? '归档的食物会显示在这里，需要时可以恢复。' : '记录常吃的食物、熟悉的份量和来源，之后查找会更方便。'}</EmptyState>}
    <div className="food-list">{remote.data?.items.map((food) => <article className="food-card" key={food.id}><div className="food-card-heading"><span className="food-kind-mark"><Icon name={food.kind === 'dish' ? 'diary' : 'leaf'} size={20} /></span><div className="food-card-title"><h3>{food.name}</h3><p>{food.kind === 'dish' ? '菜品' : '食物'}{food.variant ? ` · ${food.variant}` : ''}{food.restaurant_name ? ` · ${food.restaurant_name}` : ''}</p></div><span className="pill neutral">v{food.version}</span></div>
      {food.aliases.length > 0 && <p className="food-aliases">别名：{food.aliases.join('、')}</p>}<dl className="food-details"><div><dt>参考份量</dt><dd>{food.serving_label}{food.amount_g == null ? '' : ` · ${formatNumber(food.amount_g)} g`}</dd></div><div><dt>来源</dt><dd>{evidenceLabel(food.evidence)}{food.source_urls.length > 0 && <span className="food-source-links">{food.source_urls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">查看来源</a>)}</span>}</dd></div><div><dt>核实时间</dt><dd>{food.verified_at ? prettyInstant(food.verified_at, timezone) : '尚未核实'}</dd></div></dl>
      <div className="food-nutrient-summary">{nutrientFields.slice(0, 4).map(({ key, label, unit }) => <span key={key}>{label} <strong>{formatNumber(food.nutrients[key])}</strong> {unit}</span>)}</div>{food.notes && <p className="food-notes">{food.notes}</p>}
      <footer className="food-card-actions"><button type="button" className="text-button" disabled={Boolean(food.archived_at)} title={food.archived_at ? '先恢复条目，再编辑' : undefined} onClick={() => openEdit(food)}><Icon name="edit" size={16} />编辑</button><button type="button" className="text-button" onClick={() => showHistory(food)}><Icon name="history" size={16} />历史</button>{food.archived_at ? <button type="button" className="text-button" disabled={pending === food.id} onClick={() => { setError(null); setActionConflict(false); setActionLatest(null); setActionFood(food); }}><Icon name="restore" size={16} />恢复</button> : <button type="button" className="text-button danger-text" onClick={() => { setError(null); setActionConflict(false); setActionLatest(null); setActionFood(food); }}><Icon name="trash" size={16} />归档</button>}</footer>
    </article>)}</div>
    {remote.data && <div className="food-pagination"><span>共 {remote.data.total} 项 · 第 {Math.floor(offset / 20) + 1} 页</span><div><button className="button secondary" type="button" disabled={offset === 0 || remote.loading} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><button className="button secondary" type="button" disabled={!remote.data.has_more || remote.loading} onClick={() => setOffset(remote.data?.next_offset ?? offset + 20)}>下一页</button></div></div>}
    {authenticated && visible && editorOpen && draft && <Modal title={draft.id ? '编辑食物库条目' : '新增食物库条目'} wide onClose={closeEditor} busy={pending === 'save'}><form className="food-form" onSubmit={save}><div className="modal-body food-form-body"><p className="field-hint">保存到食物库不会修改已经记录的餐食。</p>{error && <ErrorNotice message={error} />}
      {conflict && <section className="conflict-panel"><h3>条目已被其他操作更新</h3><p>草稿已保留。读取服务器最新版，对照全部字段，再明确选择保留草稿合并或采用最新版重新编辑。</p><button type="button" className="button secondary" disabled={latestLoading} onClick={loadLatest}>{latestLoading ? '正在读取…' : '加载最新版'}</button>{latest && <div className="conflict-comparison"><FoodSnapshot food={latest} timezone={timezone} /><button type="button" className="button secondary" onClick={() => reconcile(false)}>保留草稿，合并到版本 {latest.version}</button><button type="button" className="button secondary" onClick={() => reconcile(true)}>采用最新版重新编辑</button></div>}</section>}
      <fieldset className="plain-fieldset" disabled={pending === 'save'}><div className="field-row"><div className="field"><label htmlFor="food-kind-edit">类型</label><select id="food-kind-edit" value={draft.kind} onChange={(event) => patch({ kind: event.target.value as FoodInput['kind'] })}><option value="food">食物</option><option value="dish">菜品</option></select></div><div className="field"><label htmlFor="food-name-edit">名称</label><input id="food-name-edit" required maxLength={150} value={draft.name} onChange={(event) => patch({ name: event.target.value })} autoFocus /></div></div>
      <div className="field"><label htmlFor="food-aliases-edit">别名 <span>每行一个</span></label><textarea id="food-aliases-edit" rows={2} value={draft.aliases.join('\n')} onChange={(event) => patch({ aliases: event.target.value.split('\n') })} placeholder="例如：煎蛋" /></div>
      <div className="field-row"><div className="field"><label htmlFor="food-restaurant-edit">餐厅 <span>可选</span></label><input id="food-restaurant-edit" value={draft.restaurant_name || ''} onChange={(event) => patch({ restaurant_name: event.target.value || null })} /></div><div className="field"><label htmlFor="food-variant-edit">规格或变体</label><input id="food-variant-edit" value={draft.variant} onChange={(event) => patch({ variant: event.target.value })} /></div></div>
      <div className="field-row"><div className="field"><label htmlFor="food-serving-edit">参考份量</label><input id="food-serving-edit" required value={draft.serving_label} onChange={(event) => patch({ serving_label: event.target.value })} placeholder="1份" /></div><div className="field"><label htmlFor="food-amount-edit">参考重量 <span>g · 未知留空</span></label><input id="food-amount-edit" type="number" min="0" step="any" value={draft.amount_g} onChange={(event) => patch({ amount_g: event.target.value })} placeholder="未知" /></div></div>
      <div className="section-heading compact"><h3>每份营养</h3><span>未知留空，已知为零请填 0</span></div><div className="nutrient-input-grid">{nutrientFields.map(({ key, label, unit }) => <div className="field" key={key}><label htmlFor={`food-${key}`}>{label} <span>{unit}</span></label><input id={`food-${key}`} type="number" min="0" step="any" value={draft.nutrients[key]} onChange={(event) => patch({ nutrients: { ...draft.nutrients, [key]: event.target.value } })} placeholder="未知" /></div>)}</div>
      <div className="field-row"><div className="field"><label htmlFor="food-evidence-edit">来源类型</label><select id="food-evidence-edit" value={draft.evidence} onChange={(event) => patch({ evidence: event.target.value as FoodInput['evidence'] })}>{Object.entries(foodEvidenceTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="field"><label htmlFor="food-confidence-edit">可信程度</label><select id="food-confidence-edit" value={draft.confidence} onChange={(event) => patch({ confidence: event.target.value as FoodInput['confidence'] })}>{Object.entries(confidenceTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <div className="field"><label htmlFor="food-urls-edit">来源链接 <span>每行一个；网络查证或餐厅菜单必填</span></label><textarea id="food-urls-edit" rows={2} value={draft.source_urls.join('\n')} onChange={(event) => patch({ source_urls: event.target.value.split('\n') })} placeholder="https://…" /></div>
      <div className="field"><label htmlFor="food-verified-edit">核实时间 <span>可选</span></label><span className="field-hint">按 {timezone} 输入，未修改的原始核实时间完整保留。</span><input id="food-verified-edit" step="1" type="datetime-local" value={draft.verified_at} onChange={(event) => patch({ verified_at: event.target.value })} /></div><div className="field"><label htmlFor="food-notes-edit">备注</label><textarea id="food-notes-edit" rows={3} maxLength={2000} value={draft.notes} onChange={(event) => patch({ notes: event.target.value })} /></div></fieldset></div>
      {discarding && <div className="inline-confirm"><span>放弃当前食物库草稿？</span><button type="button" className="text-button danger-text" disabled={pending === 'save'} onClick={() => { keys.current.complete(draft.id ? `food-edit:${draft.id}` : 'food-new'); setDraft(null); setBaseSnapshot(null); setEditorOpen(false); setConflict(false); setLatest(null); setDiscarding(false); }}>确认放弃</button><button type="button" className="text-button" onClick={() => setDiscarding(false)}>继续编辑</button></div>}
      <footer className="modal-footer"><button type="button" className="text-button muted" disabled={pending === 'save'} onClick={() => setDiscarding(true)}>放弃草稿</button><div><button type="button" className="button secondary" disabled={pending === 'save'} onClick={closeEditor}>收起</button><button type="submit" className="button primary" disabled={pending === 'save' || conflict}>{pending === 'save' ? '正在保存…' : '保存条目'}</button></div></footer></form></Modal>}
    {authenticated && visible && actionFood && <Modal title={actionFood.archived_at ? '恢复这个条目？' : '归档这个条目？'} onClose={() => setActionFood(null)} busy={pending !== null}><div className="modal-body"><p>「{actionFood.name}」{actionFood.archived_at ? '将回到常用列表。' : '将从常用列表隐藏，需要时可以恢复。'}既有餐食保持原记录。</p>{error && <ErrorNotice message={error} />}{actionConflict && <section className="conflict-panel"><h3>条目版本已变化</h3><p>加载最新版并确认后再操作。</p><button className="button secondary" type="button" disabled={latestLoading} onClick={async () => { setLatestLoading(true); try { const result = await api<{ item: Food }>(foodPath(actionFood.id)); setActionLatest(result.item); } catch (reason) { setError(errorMessage(reason)); } finally { setLatestLoading(false); } }}>加载最新状态</button>{actionLatest && <><FoodSnapshot food={actionLatest} timezone={timezone} /><button className="button secondary" type="button" onClick={() => { setActionFood(actionLatest); setActionConflict(false); setActionLatest(null); setError(null); }}>采用此版本重新确认操作</button></>}</section>}</div><footer className="modal-footer"><button className="button secondary" disabled={pending !== null} onClick={() => setActionFood(null)}>取消</button><button className="button danger" disabled={pending !== null || actionConflict} onClick={() => changeArchive(actionFood, Boolean(actionFood.archived_at))}>{pending ? '正在处理…' : actionFood.archived_at ? '确认恢复' : '确认归档'}</button></footer></Modal>}
    {authenticated && visible && historyFood && <Modal title={`「${historyFood.name}」的修改历史`} onClose={() => { setHistoryFood(null); setHistory(null); }}><div className="modal-body">{error && <ErrorNotice message={error} />}{history === null ? <Loading text="正在读取历史…" /> : history.length === 0 ? <p className="muted">暂无历史版本。</p> : history.map((entry) => <article className="food-history-row" key={entry.version}><h3>版本 {entry.version} · {entry.operation}</h3><p>{prettyInstant(entry.created_at, timezone)} · {entry.actor}</p><p>{entry.snapshot.name} · {entry.snapshot.serving_label} · {evidenceLabel(entry.snapshot.evidence)}</p></article>)}</div></Modal>}
    {authenticated && visible && toast && <div className="toast" role="status"><Icon name="check" size={18} /><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}><Icon name="close" size={17} /></button></div>}
  </section>;
}

function FoodSnapshot({ food, timezone }: { food: Food; timezone: string }) {
  return <div className="food-snapshot"><h4>服务器 v{food.version} · {food.name}</h4><p>{food.kind === 'dish' ? '菜品' : '食物'} · {food.restaurant_name || '未填餐厅'} · {food.variant || '无变体'} · {food.archived_at ? '已归档' : '常用'}</p><p>别名：{food.aliases.join('、') || '无'}</p><p>参考份量：{food.serving_label} · {formatNumber(food.amount_g)} g</p><p>{evidenceLabel(food.evidence)} · 可信程度{confidenceTypes[food.confidence]} · 核实时间 {food.verified_at ? prettyInstant(food.verified_at, timezone) : '尚未核实'}</p><dl className="snapshot-nutrients">{nutrientFields.map(({ key, label, unit }) => <div key={key}><dt>{label}</dt><dd>{formatNumber(food.nutrients[key])} {unit}</dd></div>)}</dl><p className="preserve-lines">备注：{food.notes || '无'}</p><p>来源：{food.source_urls.join('、') || '无'}</p></div>;
}
