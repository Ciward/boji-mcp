import React, { useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api';
import { blankItem, draftPayload, formatNumber, hasUnknown, prettyInstant, previewNutrients } from '../model';
import { confidenceTypes, evidenceTypes, mealTypes, nutrientFields } from '../types';
import type { Api, ItemDraft, Meal, MealDraft, MealInput, Revision } from '../types';
import { ErrorNotice, Icon, Modal } from './ui';

interface Props {
  draft: MealDraft;
  onChange: (draft: MealDraft) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSave: (meal: MealInput, draft: MealDraft) => Promise<void>;
  api: Api;
}

export default function MealEditor({ draft, onChange, onClose, onDiscard, onSave, api }: Props) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Meal | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [removeItem, setRemoveItem] = useState<string | null>(null);
  const preview = previewNutrients(draft.items);
  const change = (patch: Partial<MealDraft>) => onChange({ ...draft, ...patch });
  const changeItem = (rowId: string, patch: Partial<ItemDraft>) => change({ items: draft.items.map((item) => item.rowId === rowId ? { ...item, ...patch } : item) });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    setError(null);
    try {
      const payload = draftPayload(draft);
      busyRef.current = true;
      setBusy(true);
      await onSave(payload, draft);
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError && (reason.status === 409 || reason.code === 'VERSION_CONFLICT')) setConflict(true);
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function loadLatest() {
    if (!draft.original) return;
    setLoadingLatest(true);
    try {
      const result = await api<{ items: Revision[] }>(`/meals/${encodeURIComponent(draft.original.id)}/history`);
      const newest = [...result.items].sort((a, b) => b.version - a.version)[0];
      if (!newest) throw new Error('没有可供对照的历史版本，请稍后重试。');
      setLatest(newest.snapshot);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setLoadingLatest(false); }
  }

  return <Modal title={draft.original ? '修正这顿餐食' : '记下一顿好好吃的饭'} onClose={onClose} wide busy={busy}>
    <form onSubmit={submit} className="editor-form">
      <div className="modal-body editor-body">
        <div className="editor-intro"><span className="pill">{draft.original ? `版本 ${draft.expectedVersion}` : '新的记录'}</span><span>收起后可继续编辑 · 草稿仅保留在当前页面</span></div>
        {error && <ErrorNotice message={error} />}
        {conflict && <section className="conflict-panel" aria-label="版本冲突处理"><h3>这条记录已有新的变化</h3><p>你的草稿仍在。先对照最新记录，再决定是否以新版本为基础保存。</p>
          <button type="button" className="button secondary" disabled={loadingLatest || busy} onClick={loadLatest}>{loadingLatest ? '正在读取…' : '查看最新版本'}</button>
          {latest && <div className="conflict-comparison"><p><strong>服务器 v{latest.version}：{latest.title}</strong></p><p>{prettyInstant(latest.occurred_at, draft.timezone)} · {formatNumber(latest.totals.energy_kcal)} kcal{latest.deleted_at ? ' · 已移入回收站' : ''}</p>
            <details><summary>展开最新餐食内容</summary><MealSnapshot meal={latest} timezone={draft.timezone} /></details>
            {latest.deleted_at ? <p>请先到回收站恢复这条记录，再回到草稿重新读取最新版本。</p> : <button type="button" className="button secondary" onClick={() => { change({ expectedVersion: latest.version }); setConflict(false); setError(null); setLatest(null); }}>保留草稿，以版本 {latest.version} 重新提交</button>}
          </div>}
        </section>}
        <fieldset disabled={busy} className="plain-fieldset">
          <div className="field"><label htmlFor="meal-title">餐食名称</label><input id="meal-title" value={draft.title} onChange={(event) => change({ title: event.target.value })} placeholder="给这顿饭起个名字" required maxLength={150} autoFocus /></div>
          <div className="field-row"><div className="field"><label htmlFor="meal-time">用餐时间</label><input id="meal-time" type="datetime-local" step="1" value={draft.occurredLocal} onChange={(event) => change({ occurredLocal: event.target.value, exactTime: '' })} required={!draft.exactTime} /><span className="field-hint">按 {draft.timezone} 记录</span></div>
            <div className="field"><label htmlFor="meal-type">餐别</label><select id="meal-type" value={draft.meal_type} onChange={(event) => change({ meal_type: event.target.value as MealDraft['meal_type'] })}>{Object.entries(mealTypes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div></div>
          <details className="precision-time"><summary>精确时间与时区</summary><div className="field"><label htmlFor="exact-time">带时区偏移的 ISO 时间（可选）</label><input id="exact-time" type="text" value={draft.exactTime} onChange={(event) => change({ exactTime: event.target.value })} placeholder="2026-10-20T12:30:00+08:00" /><span className="field-hint">填写后优先采用此时间，用于旅行或夏令时重复时刻。</span></div></details>
          <div className="section-heading compact"><h3>吃了些什么</h3><span>{draft.items.length} 项食物</span></div>
          <div className="info-note"><Icon name="leaf" /><p><strong>填写整份食物的营养值。</strong>摄入量 = 整份营养 × 食用比例。重量仅作份量说明；未知营养请留空，明确没有才填 0。</p></div>
          {draft.items.map((item, index) => <section className="food-editor" key={item.rowId} aria-label={`食物 ${index + 1}`}>
            <header><h4>食物 {index + 1}</h4><button type="button" className="icon-button danger-text" aria-label={`移除食物 ${index + 1}`} disabled={draft.items.length === 1} onClick={() => setRemoveItem(item.rowId)}><Icon name="trash" size={18} /></button></header>
            {removeItem === item.rowId && <div className="inline-confirm"><span>移除这项食物及其填写内容？</span><button type="button" className="text-button danger-text" onClick={() => { change({ items: draft.items.filter((entry) => entry.rowId !== item.rowId) }); setRemoveItem(null); }}>确认移除</button><button type="button" className="text-button" onClick={() => setRemoveItem(null)}>保留</button></div>}
            <>{item.food_library_ref && <p className="field-hint">食物库引用 · {item.food_library_ref.id} · v{item.food_library_ref.version}（保留原餐食快照）</p>}</><div className="field"><label htmlFor={`name-${item.rowId}`}>食物名称</label><input id={`name-${item.rowId}`} value={item.name} onChange={(event) => changeItem(item.rowId, { name: event.target.value })} placeholder="例如：一碗番茄鸡蛋面" required maxLength={150} /></div>
            <div className="field-row"><div className="field"><label htmlFor={`weight-${item.rowId}`}>整份重量 <span>g · 可留空</span></label><input id={`weight-${item.rowId}`} type="number" inputMode="decimal" min="0" step="any" value={item.amount_g} onChange={(event) => changeItem(item.rowId, { amount_g: event.target.value })} placeholder="未知" /></div>
              <div className="field"><label htmlFor={`percent-${item.rowId}`}>实际食用 <span>%</span></label><input id={`percent-${item.rowId}`} type="number" inputMode="decimal" min="0" max="100" step="any" required value={item.consumed_percent} onChange={(event) => changeItem(item.rowId, { consumed_percent: event.target.value })} /></div></div>
            <div className="nutrient-input-grid">{nutrientFields.map(({ key, label, unit }) => <div className="field" key={key}><label htmlFor={`${key}-${item.rowId}`}>{label} <span>{unit}</span></label><input id={`${key}-${item.rowId}`} type="number" inputMode="decimal" min="0" step="any" value={item.nutrients[key]} onChange={(event) => changeItem(item.rowId, { nutrients: { ...item.nutrients, [key]: event.target.value } })} placeholder="未知" /></div>)}</div>
            <div className="field-row"><div className="field"><label htmlFor={`evidence-${item.rowId}`}>估算依据</label><select id={`evidence-${item.rowId}`} value={item.evidence} onChange={(event) => changeItem(item.rowId, { evidence: event.target.value as ItemDraft['evidence'] })}>{Object.entries(evidenceTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
              <div className="field"><label htmlFor={`confidence-${item.rowId}`}>可信程度</label><select id={`confidence-${item.rowId}`} value={item.confidence} onChange={(event) => changeItem(item.rowId, { confidence: event.target.value as ItemDraft['confidence'] })}>{Object.entries(confidenceTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div></div>
            <div className="field"><label htmlFor={`notes-${item.rowId}`}>食物说明 <span>可选</span></label><textarea id={`notes-${item.rowId}`} rows={2} value={item.notes} onChange={(event) => changeItem(item.rowId, { notes: event.target.value })} placeholder="份量依据、配料或不确定的地方" /></div>
          </section>)}
          <button type="button" className="button add-food" onClick={() => change({ items: [...draft.items, blankItem()] })}><Icon name="plus" size={18} />再加一项食物</button>
          <div className="field meal-note"><label htmlFor="meal-note">这顿饭的备注 <span>可选</span></label><textarea id="meal-note" rows={3} value={draft.notes} onChange={(event) => change({ notes: event.target.value })} placeholder="留下一点与这顿饭有关的小事" /></div>
        </fieldset>
        <section className="preview-panel"><div className="section-heading compact"><h3>本次摄入预览</h3><span>{hasUnknown(draft.items) ? '包含未知项，合计为已知部分' : '按食用比例计算'}</span></div><div className="preview-grid">{nutrientFields.slice(0, 4).map(({ key, label, unit }) => <div key={key}><span>{label}</span><strong>{formatNumber(preview[key])}<small> {unit}</small></strong>{draft.original && <span className="previous-value">原记录 {formatNumber(draft.original.totals[key])}</span>}</div>)}</div><p className="field-hint">保存后以服务端计算的结果为准。</p></section>
        {discarding && <div className="inline-confirm"><span>放弃这份尚未保存的草稿？</span><button type="button" className="text-button danger-text" disabled={busy} onClick={onDiscard}>确认放弃</button><button type="button" className="text-button" onClick={() => setDiscarding(false)}>继续编辑</button></div>}
      </div>
      <footer className="modal-footer"><button type="button" className="text-button muted" disabled={busy} onClick={() => setDiscarding(true)}>放弃草稿</button><div><button type="button" className="button secondary" disabled={busy} onClick={onClose}>收起</button><button className="button primary" type="submit" disabled={busy || conflict}>{busy ? '正在保存…' : '保存餐食'}</button></div></footer>
    </form>
  </Modal>;
}

export function MealSnapshot({ meal, timezone }: { meal: Meal; timezone: string }) {
  return <div className="meal-snapshot"><p>{mealTypes[meal.meal_type]} · {prettyInstant(meal.occurred_at, timezone)} · {timezone}</p>{meal.notes && <p className="preserve-lines">{meal.notes}</p>}
    <div className="snapshot-totals">{nutrientFields.map(({ key, label, unit }) => <span key={key}>{label} <strong>{formatNumber(meal.totals[key])}</strong> {unit}</span>)}</div>
    {meal.items.map((item, index) => <section className="snapshot-item" key={index}><h4>{item.name}</h4><p>整份 {item.amount_g == null ? '重量未知' : `${formatNumber(item.amount_g)} g`} · 食用 {formatNumber(item.consumed_fraction * 100)}%</p><p>{evidenceTypes[item.evidence]} · 可信程度{confidenceTypes[item.confidence]}</p><dl className="snapshot-nutrients">{nutrientFields.map(({ key, label, unit }) => <div key={key}><dt>{label}（整份）</dt><dd>{formatNumber(item.nutrients[key])} {unit}</dd></div>)}</dl>{item.notes && <p className="preserve-lines">{item.notes}</p>}</section>)}
  </div>;
}
