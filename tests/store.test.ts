import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync,backup } from 'node:sqlite';
import { Store } from '../src/store.js';
import { sumMeals,mealInputSchema } from '../src/model.js';
const meal={title:'测试午餐',occurred_at:'2026-10-20T12:30:00+08:00',meal_type:'lunch',items:[{name:'米饭',amount_g:200,consumed_fraction:.5,nutrients:{energy_kcal:260,protein_g:5,carbs_g:58,fat_g:1},evidence:'weighed',confidence:'high'}]};
test('meal persisted, retry dedup, conflicting request rejected, history and optimistic edits survive restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'boji-store-'));let s=new Store(join(dir,'db.sqlite'));
 try{
  const first=s.createMeal({idempotency_key:'test-request-1',meal});assert.equal(first.persisted,true);assert.equal(first.meal.totals.energy_kcal,130);assert.equal(first.meal.totals.sodium_mg,null);
  assert.equal(s.createMeal({idempotency_key:'test-request-1',meal}).replayed,true);
  assert.equal(s.listMeals('2026-10-20').total,1);
  assert.throws(()=>s.createMeal({idempotency_key:'test-request-1',meal:{...meal,title:'different'}}),/编号/);
  s.close();s=new Store(join(dir,'db.sqlite'));assert.equal(s.getMeal(first.meal.id).version,1);
  const edit=s.updateMeal(first.meal.id,{idempotency_key:'test-edit-1',expected_version:1,meal:{...meal,title:'改了标题'}});
  assert.equal(edit.meal.version,2);assert.equal(s.history(first.meal.id).items.length,2);
  assert.throws(()=>s.updateMeal(first.meal.id,{idempotency_key:'test-edit-2',expected_version:1,meal}),/草稿/);
  assert.equal(s.getMeal(first.meal.id).title,'改了标题');
  s.changeState(first.meal.id,{idempotency_key:'test-delete-1',expected_version:2},false);
  assert.equal(s.summary('2026-10-20').meal_count,0);assert.equal(s.summary('2026-10-20').totals.energy_kcal,null);
  assert.equal(s.listMeals(undefined,true).total,1);
  s.changeState(first.meal.id,{idempotency_key:'test-restore-1',expected_version:3},true);
  assert.equal(s.summary('2026-10-20').totals.energy_kcal,130);assert.equal(s.history(first.meal.id).items.length,4);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('local day boundaries, null coverage, zero consumption and validated dates',()=>{
 const s=new Store(':memory:');try{
 s.createMeal({idempotency_key:'late-event-1',meal:{...meal,occurred_at:'2026-10-19T17:01:00Z'}});
 assert.equal(s.summary('2026-10-20').meal_count,1);assert.equal(s.summary('2026-10-19').meal_count,0);
 const unknown=mealInputSchema.parse({...meal,items:[...meal.items,{name:'未知配料',nutrients:{},consumed_fraction:1}]});
 const sum=sumMeals([unknown]);assert.equal(sum.totals.energy_kcal,130);assert.equal(sum.unknown_counts.energy_kcal,1);
 const zero=sumMeals([mealInputSchema.parse({...meal,items:[{name:'未食用',nutrients:{},consumed_fraction:0}]})]);assert.equal(zero.unknown_counts.energy_kcal,0);
 assert.throws(()=>s.summary('2026-02-31'));assert.throws(()=>s.createMeal({idempotency_key:'bad-date-001',meal:{...meal,occurred_at:'2026-10-20T12:00:00'}}));
 assert.throws(()=>s.createMeal({idempotency_key:'bad-negative',meal:{...meal,items:[{...meal.items[0],nutrients:{energy_kcal:-1}}]}}));
 }finally{s.close();}
});
test('daily totals include >200 records, list bounds and pagination stable',()=>{
 const s=new Store(':memory:');try{for(let i=0;i<205;i++)s.createMeal({idempotency_key:`pagination-${i}`,meal});
 assert.equal(s.listMeals('2026-10-20',false,20).items.length,20);assert.equal(s.listMeals('2026-10-20',false,20,200).items.length,5);
 assert.equal(s.summary('2026-10-20').totals.energy_kcal,205*130);assert.throws(()=>s.listMeals(undefined,false,NaN));
 }finally{s.close();}
});
test('online SQLite backup is readable with WAL writes and retains versions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'boji-backup-')),s=new Store(join(dir,'live.sqlite'));
 try{s.createMeal({idempotency_key:'backup-test-1',meal});await backup(s.db,join(dir,'backup.sqlite'));const restored=new DatabaseSync(join(dir,'backup.sqlite'),{readOnly:true});try{assert.equal(restored.prepare('SELECT count(*) AS n FROM meals').get()!.n,1);assert.equal(restored.prepare('SELECT count(*) AS n FROM meal_history').get()!.n,1);}finally{restored.close();}}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
