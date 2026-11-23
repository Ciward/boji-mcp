import React, { useState } from 'react';
import { formatNumber, prettyDate, prettyInstant, shiftDate } from '../model';
import { confidenceTypes, evidenceTypes, mealTypes, nutrientFields } from '../types';
import type { Meal, NutrientKey, Summary, Trend } from '../types';
import { EmptyState, Icon } from './ui';
import type { IconName } from './ui';

const mealIcons: Record<Meal['meal_type'], IconName> = { breakfast: 'sun', lunch: 'bowl', dinner: 'moon', snack: 'leaf' };

export function Overview({ summary }: { summary: Summary }) {
  const missing = Object.values(summary.unknown_counts || {}).reduce<number>((sum, value) => sum + (value || 0), 0);
  return <section className="overview" aria-label="营养概览"><div className="overview-top"><span>这一天，已记录的摄入</span><span className="pill">{summary.meal_count} 顿餐食</span></div><div className="overview-main"><div className="energy-number"><strong>{summary.meal_count ? formatNumber(summary.totals.energy_kcal, 0) : '—'}</strong><span>kcal <span className="energy-label">能量</span></span></div><div className="nutrition-macros">{nutrientFields.slice(1, 4).map(({ key, label, unit }) => <div className={`macro ${key}`} key={key}><span><i />{label}</span><strong>{summary.meal_count ? formatNumber(summary.totals[key]) : '—'}<small> {unit}</small></strong></div>)}</div></div>
    <div className="completeness"><Icon name="leaf" size={16} /><span>{!summary.meal_count ? '记录第一顿餐食，开始了解这一天。' : missing > 0 ? `有 ${missing} 项营养数据待补充，合计仅包含已知部分。` : '合计来自已记录的餐食，不代表全天全部摄入。'}</span></div>
    <details className="more-nutrition"><summary>查看完整营养</summary><dl>{nutrientFields.slice(4).map(({ key, label, unit }) => <div key={key}><dt>{label}</dt><dd>{summary.meal_count ? formatNumber(summary.totals[key]) : '—'} {unit}{(summary.unknown_counts?.[key] || 0) > 0 && <small> · {summary.unknown_counts[key]} 项未知</small>}</dd></div>)}</dl><p className="field-hint">数据版本 {summary.data_revision}</p></details>
  </section>;
}

export function MealCard({ meal, timezone, deleted, onEdit, onHistory, onDelete, onRestore, pending }: {
  meal: Meal; timezone: string; deleted: boolean; onEdit: () => void; onHistory: () => void; onDelete: () => void; onRestore: () => void; pending: boolean;
}) {
  return <article className={`meal-card ${deleted ? 'deleted-meal' : ''}`}><div className={`meal-symbol ${meal.meal_type}`}><Icon name={mealIcons[meal.meal_type]} size={24} /></div><div className="meal-content"><div className="meal-topline"><span>{mealTypes[meal.meal_type]}<span className="time-dot">·</span>{prettyInstant(meal.occurred_at, timezone, true)}</span><span className="version-label">v{meal.version}</span></div><div className="meal-title-row"><h3>{meal.title}</h3><div className="meal-energy"><strong>{formatNumber(meal.totals.energy_kcal, 0)}</strong><span> kcal</span></div></div>
    <p className="meal-foods">{meal.items.map((item) => item.name).join('、')}</p><div className="meal-macros">{nutrientFields.slice(1, 4).map(({ key, label, unit }) => <span key={key}>{label} <b>{formatNumber(meal.totals[key])}</b> {unit}</span>)}</div>
    <div className="meal-evidence">{[...new Set(meal.items.map((item) => item.evidence))].map((evidence) => <span key={evidence}>{evidenceTypes[evidence]}</span>)}{meal.items.some((item) => item.confidence === 'low') && <span className="needs-review">部分估算待核对</span>}{meal.items.some((item) => item.consumed_fraction > 0 && Object.values(item.nutrients).some((value) => value == null)) && <span className="needs-review">含未知营养</span>}</div>
    {meal.notes && <p className="meal-notes preserve-lines">{meal.notes}</p>}
    <details className="meal-detail"><summary>食物与份量</summary>{meal.items.map((item, index) => <div className="meal-item-detail" key={index}><strong>{item.name}</strong><p>整份 {item.amount_g == null ? '重量未知' : `${formatNumber(item.amount_g)} g`}，食用 {formatNumber(item.consumed_fraction * 100)}% · {evidenceTypes[item.evidence]} · 可信程度{confidenceTypes[item.confidence]}</p><div className="item-nutrient-list">{nutrientFields.map(({ key, label, unit }) => <span key={key}>{label} {formatNumber(item.nutrients[key])} {unit}</span>)}</div><p className="field-hint">以上为整份食物的营养，餐食合计已乘食用比例。</p>{item.notes && <p className="preserve-lines">{item.notes}</p>}</div>)}</details>
    {deleted && <p className="small muted">移除于 {prettyInstant(meal.deleted_at, timezone)}</p>}
    <footer className="meal-actions">{deleted ? <button className="text-button" disabled={pending} onClick={onRestore}><Icon name="restore" size={16} />{pending ? '正在恢复…' : '恢复这顿餐食'}</button> : <button className="text-button" onClick={onEdit}><Icon name="edit" size={16} />编辑记录</button>}<button className="text-button muted" onClick={onHistory}><Icon name="history" size={16} />历史</button>{!deleted && <button className="text-button muted delete-meal" disabled={pending} onClick={onDelete}><Icon name="trash" size={16} />移除</button>}</footer>
  </div></article>;
}

export function WeekChart({ items, today, selected, onDate, large = false }: { items: Trend[]; today: string; selected: string; onDate: (date: string) => void; large?: boolean }) {
  const [metric, setMetric] = useState<NutrientKey>('energy_kcal');
  const fields = nutrientFields.find(({ key }) => key === metric)!;
  const dates = Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
  const days = dates.map((date) => ({ date, entry: items.find((item) => item.date === date) }));
  const valid = days.filter(({ entry }) => entry && entry.meal_count > 0 && entry.totals[metric] != null);
  const max = Math.max(1, ...valid.map(({ entry }) => entry!.totals[metric]!));
  return <section className={`week-chart ${large ? 'large-chart' : ''}`} aria-label="近七天趋势"><div className="section-heading compact"><h2>日常的轨迹</h2><span className="muted small">近 7 天</span></div><p className="chart-subtitle">{prettyDate(dates[0], { month: 'numeric', day: 'numeric' })} — {prettyDate(today, { month: 'numeric', day: 'numeric' })}</p><div className="chart-control"><label className="sr-only" htmlFor={large ? 'trend-metric-large' : 'trend-metric'}>趋势指标</label><select id={large ? 'trend-metric-large' : 'trend-metric'} value={metric} onChange={(event) => setMetric(event.target.value as NutrientKey)}>{nutrientFields.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}</select><span>{fields.unit}</span></div>
    <div className="bars">{days.map(({ date, entry }) => {
      const value = entry && entry.meal_count > 0 ? entry.totals[metric] : null;
      const missing = value == null;
      return <button key={date} className={`chart-day ${date === selected ? 'selected' : ''} ${missing ? 'missing' : ''}`} onClick={() => onDate(date)} aria-label={`${prettyDate(date)}，${fields.label}${missing ? '未记录或未知' : `${formatNumber(value)} ${fields.unit}`}，查看日记`}>
        <span className="bar-track"><span className="bar-value">{missing ? '—' : formatNumber(value, 0)}</span>{missing ? <span className="bar-missing" /> : <span className={`bar ${metric === 'protein_g' ? 'plum' : ''}`} style={{ height: `${Math.max(1.5, value! / max * 78)}%` }} />}</span><span className="bar-label">{date === today ? '今天' : prettyDate(date, { weekday: 'short' }).replace('周', '')}</span><span className="bar-date">{date.slice(5).replace('-', '/')}</span>
      </button>;
    })}</div><p className="chart-note"><span className="legend-dot" />已记录摄入<span className="legend-missing" />未记录或未知</p>{!valid.length && <p className="muted small">这一周还没有可绘制的{fields.label}记录。缺失值保留为空。</p>}
    {large && <details className="trend-table"><summary>查看每日数值</summary><div className="table-scroll"><table><caption>近七天已记录营养；“—”表示没有记录或营养未知</caption><thead><tr><th>日期</th><th>餐数</th>{nutrientFields.map(({ key, label, unit }) => <th key={key}>{label} ({unit})</th>)}</tr></thead><tbody>{days.map(({ date, entry }) => <tr key={date}><th>{date}</th><td>{entry?.meal_count ?? '—'}</td>{nutrientFields.map(({ key }) => <td key={key}>{entry?.meal_count ? formatNumber(entry.totals[key]) : '—'}</td>)}</tr>)}</tbody></table></div></details>}
  </section>;
}

export function HealthSummary({ health }: { health: Record<string, unknown> | null | undefined }) {
  const labels: Record<string, { label: string; unit: string }> = {
    steps: { label: '步数', unit: '步' }, step_count: { label: '步数', unit: '步' },
    active_energy: { label: '活动能量', unit: 'kcal' }, active_energy_kcal: { label: '活动能量', unit: 'kcal' },
    basal_energy: { label: '静息能量', unit: 'kcal' }, resting_energy_kcal: { label: '静息能量', unit: 'kcal' },
    weight: { label: '体重', unit: 'kg' }, weight_kg: { label: '体重', unit: 'kg' },
    sleep: { label: '睡眠', unit: '分钟' }, sleep_minutes: { label: '睡眠', unit: '分钟' },
    heart_rate: { label: '心率', unit: '次/分' }, water: { label: '饮水', unit: 'ml' }, water_ml: { label: '饮水', unit: 'ml' },
  };
  const metrics = health && typeof health.metrics === 'object' && health.metrics !== null
    ? health.metrics as Record<string, unknown>
    : {};
  const entries = Object.entries(metrics).flatMap(([key, raw]) => {
    if (!raw || typeof raw !== 'object') return [];
    const metric = raw as Record<string, unknown>;
    const value = metric.value;
    if (!labels[key] || typeof value !== 'number') return [];
    const source = typeof metric.source_name === 'string' ? metric.source_name : '';
    const coverage = typeof metric.coverage_end === 'string' ? metric.coverage_end : '';
    return [{ key, value, label: labels[key].label, unit: typeof metric.unit === 'string' ? metric.unit : labels[key].unit, source, coverage }];
  });
  return <section className="health-summary"><div className="section-heading compact"><h2>身体的日常</h2><Icon name="leaf" size={19} /></div>{entries.length ? <dl>{entries.map(({ key, value, label, unit, source, coverage }) => <div key={key}><dt>{label}{source && <small className="metric-source">{source}</small>}</dt><dd>{formatNumber(value)} <small>{unit}</small>{coverage && <small className="metric-coverage">覆盖至 {coverage.slice(0, 16).replace('T', ' ')}</small>}</dd></div>)}</dl> : <div className="health-empty"><p>这一天还没有可展示的健康指标</p><span>在「数据源」接入设备记录后查看。</span></div>}<p className="field-hint">摄入与活动分别记录，不推算能量缺口。</p></section>;
}

export function NoMeals({ deleted, onAdd }: { deleted: boolean; onAdd: () => void }) {
  return <EmptyState title={deleted ? '这一天的回收站是空的' : '从一顿饭，慢慢了解自己'} icon={deleted ? 'trash' : 'bowl'} action={!deleted && <button className="button primary" onClick={onAdd}><Icon name="plus" size={18} />记录第一顿餐食</button>}>{deleted ? '移除的餐食会保留在这里，需要时可以恢复。试试选择其他日期。' : '记录吃了什么、吃了多少。不确定的地方可以留白，之后再补充。'}</EmptyState>;
}
