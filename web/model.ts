import { nutrientFields } from './types';
import type { ItemDraft, Meal, MealDraft, MealInput, MealItem, Nutrients } from './types';

export const formatNumber = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);

export function uniqueKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function dateTimeLocal(instant: string | Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (key: string) => parts.find((part) => part.type === key)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

// Find valid instants rather than silently shifting gaps or guessing a repeated DST hour.
export function localToIso(value: string, timezone: string): string {
  const normalized = value.length === 16 ? `${value}:00` : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(normalized)) throw new Error('请填写完整的用餐日期和时间。');
  const naive = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 19) !== normalized) throw new Error('用餐日期或时间无效。');
  const offsets = new Set<number>();
  for (const hour of [-36, -12, 0, 12, 36]) {
    const sample = naive + hour * 3600000;
    offsets.add(Date.parse(`${dateTimeLocal(new Date(sample), timezone)}Z`) - sample);
  }
  const candidates = [...offsets].map((offset) => naive - offset)
    .filter((instant) => dateTimeLocal(new Date(instant), timezone) === normalized);
  if (!candidates.length) throw new Error('该时间在所选时区不存在（可能处于夏令时跳转），请调整用餐时间。');
  if (candidates.length > 1) throw new Error('该时间在夏令时切换时出现两次。请在“精确时间”中填写含时区偏移的 ISO 时间。');
  return new Date(candidates[0]).toISOString();
}

export function shiftDate(date: string, amount: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
}

export function prettyDate(date: string, options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric', weekday: 'long' }): string {
  return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export function prettyInstant(instant: string | null | undefined, timezone: string, short = false): string {
  if (!instant || !Number.isFinite(Date.parse(instant))) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, ...(short ? {} : { month: 'numeric', day: 'numeric' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(instant));
}

export function blankItem(): ItemDraft {
  return {
    rowId: uniqueKey(), name: '', amount_g: '', consumed_percent: '100',
    nutrients: Object.fromEntries(nutrientFields.map(({ key }) => [key, ''])) as ItemDraft['nutrients'],
    confidence: 'medium', evidence: 'manual', notes: '',
  };
}

export function makeDraft(date: string, timezone: string, meal?: Meal): MealDraft {
  const now = dateTimeLocal(new Date(), timezone);
  return {
    original: meal, expectedVersion: meal?.version, timezone,
    occurredLocal: meal ? dateTimeLocal(meal.occurred_at, timezone) : `${date}${now.slice(10, 16)}:00`,
    exactTime: '', title: meal?.title ?? '', meal_type: meal?.meal_type ?? 'lunch', notes: meal?.notes ?? '',
    items: meal ? meal.items.map((item) => ({
      ...item, rowId: uniqueKey(), amount_g: item.amount_g == null ? '' : String(item.amount_g),
      consumed_percent: String(Number((item.consumed_fraction * 100).toFixed(8))),
      nutrients: Object.fromEntries(nutrientFields.map(({ key }) => [key, item.nutrients[key] == null ? '' : String(item.nutrients[key])])) as ItemDraft['nutrients'],
    })) : [blankItem()],
  };
}

function optionalNumber(value: string, label: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}需要填写大于或等于 0 的数字；未知请留空。`);
  return parsed;
}

export function itemPayload(item: ItemDraft, index: number): MealItem {
  if (!item.name.trim()) throw new Error(`请填写第 ${index + 1} 项食物的名称。`);
  const consumed = optionalNumber(item.consumed_percent, '食用比例');
  if (consumed == null || consumed > 100) throw new Error('食用比例需要填写 0 到 100 之间的数字。');
  return {
    ...(item.food_library_ref ? { food_library_ref: { ...item.food_library_ref } } : {}),
    name: item.name.trim(), amount_g: optionalNumber(item.amount_g, '整份重量'), consumed_fraction: consumed / 100,
    confidence: item.confidence, evidence: item.evidence, notes: item.notes,
    nutrients: Object.fromEntries(nutrientFields.map(({ key, label }) => [key, optionalNumber(item.nutrients[key], label)])) as Nutrients,
  };
}

export function draftPayload(draft: MealDraft): MealInput {
  if (!draft.title.trim()) throw new Error('请为这顿餐食写一个名称。');
  if (!draft.items.length) throw new Error('请至少添加一项食物。');
  let occurredAt: string;
  if (draft.exactTime.trim()) {
    const exact = draft.exactTime.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(exact) || !Number.isFinite(Date.parse(exact))) {
      throw new Error('精确时间必须包含时区，例如 2026-10-20T12:30:00+08:00。');
    }
    const local = exact.replace(/(Z|[+-]\d{2}:\d{2})$/, '');
    if (new Date(`${local}Z`).toISOString().slice(0, 10) !== local.slice(0, 10)) throw new Error('精确时间的日期无效。');
    occurredAt = new Date(exact).toISOString();
  } else if (draft.original && draft.occurredLocal === dateTimeLocal(draft.original.occurred_at, draft.timezone)) {
    occurredAt = draft.original.occurred_at;
  } else occurredAt = localToIso(draft.occurredLocal, draft.timezone);
  return { occurred_at: occurredAt, title: draft.title.trim(), meal_type: draft.meal_type, notes: draft.notes, items: draft.items.map(itemPayload) };
}

// Preview only. Persisted records and daily summaries always use server totals.
export function previewNutrients(items: ItemDraft[]): Nutrients {
  return Object.fromEntries(nutrientFields.map(({ key }) => {
    let total = 0;
    let known = false;
    for (const item of items) {
      const percent = Number(item.consumed_percent);
      if (item.consumed_percent.trim() === '' || !Number.isFinite(percent) || percent < 0 || percent > 100) return [key, null];
      if (percent === 0) continue;
      const raw = item.nutrients[key];
      const value = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(value) && value >= 0) { total += value * percent / 100; known = true; }
    }
    return [key, known ? total : null];
  })) as Nutrients;
}

export function hasUnknown(items: ItemDraft[]): boolean {
  return items.some((item) => Number(item.consumed_percent) > 0 && nutrientFields.some(({ key }) => item.nutrients[key].trim() === ''));
}

export function createSaveKeys() {
  const entries = new Map<string, { fingerprint: string; key: string }>();
  return {
    forPayload(scope: string, payload: unknown): string {
      const fingerprint = JSON.stringify(payload);
      const previous = entries.get(scope);
      if (previous?.fingerprint === fingerprint) return previous.key;
      const key = uniqueKey();
      entries.set(scope, { fingerprint, key });
      return key;
    },
    complete(scope: string) { entries.delete(scope); },
  };
}
