export const nutrientFields = [
  { key: 'energy_kcal', label: '能量', unit: 'kcal' },
  { key: 'protein_g', label: '蛋白质', unit: 'g' },
  { key: 'carbs_g', label: '碳水化合物', unit: 'g' },
  { key: 'fat_g', label: '脂肪', unit: 'g' },
  { key: 'fiber_g', label: '膳食纤维', unit: 'g' },
  { key: 'sugar_g', label: '总糖', unit: 'g' },
  { key: 'sodium_mg', label: '钠', unit: 'mg' },
  { key: 'saturated_fat_g', label: '饱和脂肪', unit: 'g' },
] as const;
export type NutrientKey = typeof nutrientFields[number]['key'];
export type Nutrients = Record<NutrientKey, number | null>;
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';
export const mealTypes: Record<MealType, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
export const evidenceTypes = { vision: '视觉估算', label: '营养标签', weighed: '实际称重', database: '食物数据库', manual: '手工记录' } as const;
export const confidenceTypes = { low: '较低', medium: '中等', high: '较高' } as const;
export interface MealItem {
  food_library_ref?: { id: string; version: number };
  name: string;
  amount_g: number | null;
  consumed_fraction: number;
  nutrients: Nutrients;
  confidence: keyof typeof confidenceTypes;
  evidence: keyof typeof evidenceTypes;
  notes: string;
}
export interface MealInput {
  occurred_at: string;
  title: string;
  meal_type: MealType;
  notes: string;
  items: MealItem[];
}
export interface Meal extends MealInput {
  id: string;
  version: number;
  totals: Nutrients;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Session { authenticated: true; csrf_token: string }
export interface Context { timezone: string; today: string; profile: { display_name: string; timezone: string } }
export interface Summary {
  date: string;
  totals: Nutrients;
  meal_count: number;
  unknown_counts: Partial<Record<NutrientKey, number>>;
  health: Record<string, unknown>;
  data_revision: number | string;
}
export interface Trend { date: string; meal_count: number; totals: Nutrients }
export interface Source {
  id: string;
  name: string;
  kind: 'apple_xml' | 'health_auto_export' | 'generic';
  enabled: boolean;
  last_received_at: string | null;
  coverage_end: string | null;
  metrics: string[] | Record<string, unknown>;
  revoked?: boolean;
  counts?: Record<string, number>;
  coverage_start?: string | null;
  observed_metrics?: string[];
  [key: string]: unknown;
}
export interface Revision { version: number; operation: string; created_at: string; snapshot: Meal }
export interface PersistedMeal { persisted: true; meal: Meal }
export interface ItemDraft extends Omit<MealItem, 'amount_g' | 'consumed_fraction' | 'nutrients'> {
  rowId: string;
  amount_g: string;
  consumed_percent: string;
  nutrients: Record<NutrientKey, string>;
}
export interface MealDraft {
  original?: Meal;
  expectedVersion?: number;
  timezone: string;
  occurredLocal: string;
  exactTime: string;
  title: string;
  meal_type: MealType;
  notes: string;
  items: ItemDraft[];
}
export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export const foodEvidenceTypes = { ...evidenceTypes, web_research: '网络查证', restaurant_menu: '餐厅菜单' } as const;
export interface FoodInput {
  kind: 'food' | 'dish';
  name: string;
  aliases: string[];
  restaurant_name: string | null;
  variant: string;
  serving_label: string;
  amount_g: number | null;
  nutrients: Nutrients;
  confidence: keyof typeof confidenceTypes;
  evidence: keyof typeof foodEvidenceTypes;
  notes: string;
  source_urls: string[];
  verified_at: string | null;
}
export interface Food extends FoodInput {
  id: string;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface FoodList { items: Food[]; total: number; has_more: boolean; next_offset: number | null; data_revision: number | string }
export interface PersistedFood { persisted: true; item: Food; data_revision: number | string }
export interface FoodRevision { version: number; operation: string; actor: string; created_at: string; snapshot: Food }
