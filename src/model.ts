import { z } from 'zod';
export const nutrientKeys = ['energy_kcal','protein_g','carbs_g','fat_g','fiber_g','sugar_g','sodium_mg','saturated_fat_g'] as const;
export type NutrientKey = typeof nutrientKeys[number];
const quantity = z.number().finite().nonnegative().max(1_000_000).nullable().default(null);
export const nutrientsSchema = z.object({energy_kcal:quantity,protein_g:quantity,carbs_g:quantity,fat_g:quantity,fiber_g:quantity,sugar_g:quantity,sodium_mg:quantity,saturated_fat_g:quantity}).strict();
export type Nutrients = z.infer<typeof nutrientsSchema>;
export const itemSchema = z.object({name:z.string().trim().min(1).max(150),amount_g:z.number().finite().nonnegative().max(100000).nullable().default(null),consumed_fraction:z.number().finite().min(0).max(1).default(1),nutrients:nutrientsSchema,confidence:z.enum(['low','medium','high']).default('medium'),evidence:z.enum(['vision','label','weighed','database','manual']).default('vision'),notes:z.string().max(1000).default(''),food_library_ref:z.object({id:z.string().uuid(),version:z.number().int().positive()}).strict().optional()}).strict();
export const instantSchema = z.string().datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)),'时间无效，必须包含时区偏移');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===v;},'日期不存在');
export const mealInputSchema = z.object({occurred_at:instantSchema,title:z.string().trim().min(1).max(150),meal_type:z.enum(['breakfast','lunch','dinner','snack']),notes:z.string().max(4000).default(''),items:z.array(itemSchema).min(1).max(50)}).strict();
export const operationKey = z.string().min(8).max(150).regex(/^[A-Za-z0-9_.:\-]+$/);
export const createMealSchema = z.object({idempotency_key:operationKey,meal:mealInputSchema}).strict();
export const updateMealSchema = createMealSchema.extend({expected_version:z.number().int().positive()});
export const changeStateSchema = z.object({idempotency_key:operationKey,expected_version:z.number().int().positive()}).strict();
export const foodLibraryKindSchema = z.enum(['food','dish']);
export const foodLibraryEvidenceSchema = z.enum(['vision','label','weighed','database','manual','web_research','restaurant_menu']);
export const foodLibraryInputSchema = z.object({
  kind:foodLibraryKindSchema,
  name:z.string().trim().min(1).max(150).refine(value=>/[\p{L}\p{N}]/u.test(value),'名称需要包含文字或数字'),
  aliases:z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  restaurant_name:z.string().trim().min(1).max(150).nullable().default(null),
  variant:z.string().trim().max(150).default(''),
  serving_label:z.string().trim().min(1).max(150).default('1份'),
  amount_g:z.number().finite().nonnegative().max(100000).nullable().default(null),
  nutrients:nutrientsSchema,
  confidence:z.enum(['low','medium','high']).default('medium'),
  evidence:foodLibraryEvidenceSchema.default('manual'),
  notes:z.string().max(2000).default(''),
  source_urls:z.array(z.string().url().max(2048).refine(value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}},'来源链接必须是无凭证的 HTTP(S) URL')).max(10).default([]),
  verified_at:instantSchema.nullable().default(null),
}).strict().refine(item=>!['web_research','restaurant_menu'].includes(item.evidence)||item.source_urls.length>0,{message:'网络检索和餐厅菜单依据需要至少一个来源链接',path:['source_urls']});
export const recordFoodLibrarySchema = z.object({idempotency_key:operationKey,item:foodLibraryInputSchema}).strict();
export const updateFoodLibrarySchema = recordFoodLibrarySchema.extend({expected_version:z.number().int().positive()});
export const foodLibrarySearchSchema = z.object({query:z.string().trim().max(150).default(''),kind:foodLibraryKindSchema.optional(),restaurant_name:z.string().trim().min(1).max(150).optional(),archived:z.boolean().default(false),limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(100000).default(0)}).strict();
export type MealInput = z.infer<typeof mealInputSchema>;
export type FoodLibraryInput = z.infer<typeof foodLibraryInputSchema>;
export interface FoodLibraryItem extends FoodLibraryInput {id:string;version:number;archived_at:string|null;created_at:string;updated_at:string;}
export interface Meal extends MealInput {id:string;version:number;totals:Nutrients;unknown_counts:Record<NutrientKey,number>;deleted_at:string|null;created_at:string;updated_at:string;}
export class AppError extends Error {constructor(public status:number,public code:string,message:string,public details?:unknown){super(message);}}
export function localDate(instant:string,timezone:string):string {return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant));}
export function sumMeals(meals:Pick<MealInput,'items'>[]) {
  const totals=Object.fromEntries(nutrientKeys.map(k=>[k,null])) as Nutrients;
  const unknown_counts=Object.fromEntries(nutrientKeys.map(k=>[k,0])) as Record<NutrientKey,number>;
  for(const {items} of meals) for(const item of items) for(const k of nutrientKeys){
    if(item.consumed_fraction===0) continue;
    const n=item.nutrients[k];
    if(n===null) unknown_counts[k]++;
    else totals[k]=(totals[k]??0)+n*item.consumed_fraction;
  }
  for(const k of nutrientKeys) if(totals[k]!==null) totals[k]=Math.round(totals[k]!*100)/100;
  return {totals,unknown_counts};
}
