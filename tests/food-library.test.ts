import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { foodLibraryInputSchema } from '../src/model.js';

const sample = {
  kind: 'dish' as const,
  name: '招牌鸡肉饭',
  aliases: ['鸡肉饭', 'Signature Chicken Rice', '鸡肉饭'],
  restaurant_name: '好味食堂',
  variant: '少饭',
  serving_label: '1盒，少饭',
  amount_g: 420,
  nutrients: { energy_kcal: 560, protein_g: 32, carbs_g: 64, fat_g: 18 },
  confidence: 'medium' as const,
  evidence: 'restaurant_menu' as const,
  notes: '菜单只列主料与热量；钠估值未提供。',
  source_urls: ['https://example.com/menu/chicken-rice'],
  verified_at: '2026-10-22T09:00:00+08:00',
};

test('food-library schema requires traceable URLs for web/menu research and protects URL credentials', () => {
  assert.equal(foodLibraryInputSchema.parse(sample).nutrients.sodium_mg, null);
  assert.throws(() => foodLibraryInputSchema.parse({ ...sample, source_urls: [] }), /来源链接/);
  assert.throws(() => foodLibraryInputSchema.parse({ ...sample, source_urls: ['https://user:password@example.com/menu'] }));
  assert.throws(() => foodLibraryInputSchema.parse({ ...sample, evidence: 'manual', source_urls: ['file:///tmp/menu'] }));
});

test('food library persists provenance, normalizes aliases, ranks/searches, paginates and survives reopen', () => {
  const directory=mkdtempSync(join(tmpdir(),'boji-food-library-'));
  const s = new Store(join(directory,'boji.sqlite'));
  try {
    const saved = s.recordFoodLibrary({ idempotency_key: 'food-library-create-01', item: sample }, 'mcp');
    assert.equal(saved.persisted, true);
    assert.equal(saved.item.version, 1);
    assert.deepEqual(saved.item.aliases, ['鸡肉饭', 'Signature Chicken Rice']);
    assert.equal(saved.item.verified_at, '2026-10-22T01:00:00.000Z');
    assert.equal(saved.item.nutrients.sodium_mg, null);
    const search = s.searchFoodLibrary({ query: 'ＣＨＩＣＫＥＮ rice', restaurant_name: '好味', kind: 'dish' });
    assert.equal(search.total, 1);
    assert.equal(search.items[0]!.id, saved.item.id);
    assert.ok(search.items[0]!.match_score > 0);
    assert.equal(s.searchFoodLibrary({ query: '不存在的菜' }).total, 0);
    assert.equal(s.recordFoodLibrary({ idempotency_key: 'food-library-create-01', item: sample }, 'mcp').replayed, true);
    assert.throws(() => s.recordFoodLibrary({ idempotency_key: 'food-library-create-01', item: { ...sample, variant: '正常饭' } }, 'mcp'), /请求编号/);
    assert.throws(() => s.recordFoodLibrary({ idempotency_key: 'food-library-create-02', item: sample }, 'mcp'), {code:'duplicate_food'});
    const reopened = new Store(s.path);
    try {
      assert.equal(reopened.getFoodLibraryItem(saved.item.id).id, saved.item.id);
      assert.equal(reopened.foodLibraryHistory(saved.item.id).items.length, 1);
    } finally { reopened.close(); }
  } finally { s.close();rmSync(directory,{recursive:true,force:true}); }
});

test('food-library versions, duplicate identity, archive and restore are optimistic and history-backed', () => {
  const s = new Store(':memory:');
  try {
    const first = s.recordFoodLibrary({ idempotency_key: 'food-library-create-11', item: sample });
    const second = s.recordFoodLibrary({ idempotency_key: 'food-library-create-12', item: { ...sample, name: '家常牛肉饭' } });
    assert.throws(() => s.updateFoodLibrary(second.item.id, { idempotency_key: 'food-library-update-11', expected_version: 1, item: sample }), {code:'duplicate_food'});
    const changed = s.updateFoodLibrary(first.item.id, { idempotency_key: 'food-library-update-12', expected_version: 1, item: { ...sample, nutrients: { ...sample.nutrients, energy_kcal: 600 } } });
    assert.equal(changed.item.version, 2);
    assert.throws(() => s.updateFoodLibrary(first.item.id, { idempotency_key: 'food-library-update-13', expected_version: 1, item: sample }), {code:'version_conflict'});
    const archived = s.changeFoodLibraryState(first.item.id, { idempotency_key: 'food-library-delete-11', expected_version: 2 }, false);
    assert.ok(archived.item.archived_at);
    assert.equal(s.searchFoodLibrary({ query: sample.name }).total, 0);
    assert.equal(s.searchFoodLibrary({ query: sample.name, archived: true }).total, 1);
    const restored = s.changeFoodLibraryState(first.item.id, { idempotency_key: 'food-library-restore-11', expected_version: 3 }, true);
    assert.equal(restored.item.archived_at, null);
    assert.equal(s.foodLibraryHistory(first.item.id).items.length, 4);
    assert.equal(s.revision(), 5);
    assert.throws(() => s.changeFoodLibraryState(first.item.id, { idempotency_key: 'food-library-delete-stale', expected_version: 2 }, false), {code:'version_conflict'});
    assert.equal(second.item.version, 1);
  } finally { s.close(); }
});

test('meal snapshots pin referenced food-library versions and never change with later catalogue edits', () => {
  const s = new Store(':memory:');
  const meal = { title: '餐厅午餐', occurred_at: '2026-10-24T12:00:00+08:00', meal_type: 'lunch' as const, notes: '', items: [{ name: sample.name, amount_g: 420, consumed_fraction: 1, nutrients: sample.nutrients, confidence: 'medium' as const, evidence: 'database' as const, notes: '核对少饭份量', food_library_ref: undefined as {id:string;version:number}|undefined }] };
  try {
    const food = s.recordFoodLibrary({ idempotency_key: 'food-library-create-21', item: sample });
    meal.items[0]!.food_library_ref = { id: food.item.id, version: food.item.version };
    const saved = s.createMeal({ idempotency_key: 'meal-with-library-21', meal });
    assert.equal(saved.meal.items[0]!.food_library_ref!.version, 1);
    const updated = s.updateFoodLibrary(food.item.id, { idempotency_key: 'food-library-update-21', expected_version: 1, item: { ...sample, nutrients: { ...sample.nutrients, energy_kcal: 700 } } });
    assert.equal(updated.item.version, 2);
    assert.equal(s.getMeal(saved.meal.id).items[0]!.nutrients.energy_kcal, 560);
    assert.throws(() => s.createMeal({ idempotency_key: 'meal-stale-food-ref-21', meal }), /食物库条目已变化/);
    const archived = s.changeFoodLibraryState(food.item.id, { idempotency_key: 'food-library-delete-21', expected_version: 2 }, false);
    assert.ok(archived.item.archived_at);
    assert.throws(() => s.createMeal({ idempotency_key: 'meal-archived-food-ref-21', meal: { ...meal, title: '另一餐' } }), /食物库条目已变化/);
    const corrected = { ...meal, items: [{ ...meal.items[0]!, name: '本次手工确认的鸡肉饭', nutrients: { ...meal.items[0]!.nutrients, energy_kcal: 590 }, food_library_ref: { id: food.item.id, version: 1 } }] };
    const oldPinned = s.updateMeal(saved.meal.id, { idempotency_key: 'meal-keep-old-reference-21', expected_version: 1, meal: corrected });
    assert.equal(oldPinned.meal.version, 2);
    assert.equal(oldPinned.meal.items[0]!.nutrients.energy_kcal, 590);
    assert.equal(oldPinned.meal.items[0]!.food_library_ref!.version, 1);
  } finally { s.close(); }
});

test('food search separates restaurants and portion variants, ranks exact names first and uses bounded pages', () => {
  const s = new Store(':memory:');
  try {
    const exact=s.recordFoodLibrary({ idempotency_key: 'search-exact-001', item: sample });
    s.recordFoodLibrary({ idempotency_key: 'search-alias-001', item: { ...sample,name:'大份招牌鸡肉饭',aliases:[sample.name] } });
    s.recordFoodLibrary({ idempotency_key: 'search-restaurant-001', item: { ...sample,restaurant_name:'另一家食堂' } });
    s.recordFoodLibrary({ idempotency_key: 'search-size-001', item: { ...sample,serving_label:'1.5份' } });
    s.recordFoodLibrary({ idempotency_key: 'search-size-002', item: { ...sample,serving_label:'15份' } });
    const page=s.searchFoodLibrary({ query: sample.name,restaurant_name:sample.restaurant_name,limit:2 });
    assert.equal(page.total,4);
    assert.equal(page.items.length,2);
    assert.equal(page.has_more,true);
    const next=s.searchFoodLibrary({ query: sample.name,restaurant_name:sample.restaurant_name,limit:2,offset:page.next_offset });
    assert.equal(next.items.length,2);assert.equal(next.next_offset,null);
    assert.equal(new Set([...page.items,...next.items].map(item=>item.id)).size,4);
    const exactMatches=s.searchFoodLibrary({ query: sample.name,restaurant_name:sample.restaurant_name });
    assert.ok(exactMatches.items.findIndex(item=>item.id===exact.item.id)<exactMatches.items.findIndex(item=>item.name==='大份招牌鸡肉饭'));
    assert.equal(s.searchFoodLibrary({ query:'好味食堂 鸡肉饭 少饭' }).total,4);
    assert.equal(s.searchFoodLibrary({ query:'％' }).total,0);
    assert.equal(s.searchFoodLibrary({ restaurant_name:'％' }).total,0);
    assert.equal(s.searchFoodLibrary({ query:"' OR 1=1 --" }).total,0);
    assert.throws(()=>s.searchFoodLibrary({ limit:500 }));
    assert.throws(()=>s.searchFoodLibrary({ offset:-1 }));
  } finally { s.close(); }
});

test('migration from the existing ledger preserves meals and idempotency; reopened library keeps history and export', () => {
  const dir=mkdtempSync(join(tmpdir(),'boji-food-migration-')),file=join(dir,'boji.sqlite');
  let s=new Store(file);
  try {
    const oldMeal={title:'迁移前午餐',occurred_at:'2026-10-20T12:00:00+08:00',meal_type:'lunch',items:[{name:'米饭',nutrients:{energy_kcal:260}}]};
    const saved=s.createMeal({idempotency_key:'migration-old-meal-01',meal:oldMeal});
    // Recreate the actual v1 shape: catalogue tables and its migration marker did not exist.
    s.db.exec('DROP TABLE food_library_history; DROP TABLE food_library; DELETE FROM migrations WHERE version=2');
    s.close();s=new Store(file);
    assert.equal(s.getMeal(saved.meal.id).totals.energy_kcal,260);
    assert.equal(s.createMeal({idempotency_key:'migration-old-meal-01',meal:oldMeal}).replayed,true);
    const food=s.recordFoodLibrary({idempotency_key:'migration-food-01',item:sample});
    s.changeFoodLibraryState(food.item.id,{idempotency_key:'migration-food-del-01',expected_version:1},false);
    s.close();s=new Store(file);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM migrations WHERE version=2').get()!.n,1);
    assert.equal(s.foodLibraryHistory(food.item.id).items.length,2);
    assert.equal(s.exportData().food_library.length,1);
    assert.equal(s.exportData().food_library_history.length,2);
    assert.equal(s.exportData().meals[0]!.totals.energy_kcal,260);
  } finally { s.close();rmSync(dir,{recursive:true,force:true}); }
});

test('archive restore cannot shadow a replacement, and invalid refs rollback meals/history/revisions', () => {
  const s=new Store(':memory:');
  try {
    const food=s.recordFoodLibrary({idempotency_key:'archive-old-001',item:sample});
    s.changeFoodLibraryState(food.item.id,{idempotency_key:'archive-old-del-001',expected_version:1},false);
    s.recordFoodLibrary({idempotency_key:'archive-new-001',item:sample});
    const revision=s.revision();
    assert.throws(()=>s.changeFoodLibraryState(food.item.id,{idempotency_key:'archive-old-restore-001',expected_version:2},true),{code:'duplicate_food'});
    assert.equal(s.getFoodLibraryItem(food.item.id).version,2);assert.ok(s.getFoodLibraryItem(food.item.id).archived_at);
    assert.equal(s.revision(),revision);
    const meal={title:'不存在的引用',occurred_at:'2026-10-24T12:00:00+08:00',meal_type:'lunch',items:[{name:sample.name,nutrients:sample.nutrients,food_library_ref:{id:food.item.id,version:999}}]};
    assert.throws(()=>s.createMeal({idempotency_key:'invalid-food-ref-001',meal}),{code:'invalid_food_reference'});
    assert.equal(s.listMeals().total,0);assert.equal(s.revision(),revision);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM operations WHERE key=?').get('invalid-food-ref-001')!.n,0);
  } finally { s.close(); }
});

test('editing an old meal cannot multiply an obsolete food-library reference', () => {
  const s=new Store(':memory:');
  try {
    const food=s.recordFoodLibrary({idempotency_key:'pinned-once-food-01',item:sample});
    const item={name:sample.name,nutrients:sample.nutrients,food_library_ref:{id:food.item.id,version:1}};
    const meal={title:'保留旧引用',occurred_at:'2026-10-24T12:00:00+08:00',meal_type:'lunch',items:[item]};
    const saved=s.createMeal({idempotency_key:'pinned-once-meal-01',meal});
    s.updateFoodLibrary(food.item.id,{idempotency_key:'pinned-once-update-01',expected_version:1,item:{...sample,notes:'新版核验'}});
    const revision=s.revision();
    assert.throws(()=>s.updateMeal(saved.meal.id,{idempotency_key:'pinned-once-copy-01',expected_version:1,meal:{...meal,items:[item,item]}}),{code:'food_library_version_conflict'});
    assert.equal(s.getMeal(saved.meal.id).version,1);assert.equal(s.history(saved.meal.id).items.length,1);assert.equal(s.revision(),revision);
    assert.equal(s.updateMeal(saved.meal.id,{idempotency_key:'pinned-once-retain-01',expected_version:1,meal:{...meal,title:'只改本餐标题'}}).meal.version,2);
  } finally { s.close(); }
});

test('food identity preserves decimal points and meaningful symbols while folding width and case', () => {
  const s=new Store(':memory:');
  try {
    const item={...sample,name:'1.5%酸奶',restaurant_name:'同一品牌',kind:'food',variant:'标准杯',serving_label:'150g'};
    s.recordFoodLibrary({idempotency_key:'identity-decimal-01',item});
    s.recordFoodLibrary({idempotency_key:'identity-integer-01',item:{...item,name:'15%酸奶'}});
    assert.throws(()=>s.recordFoodLibrary({idempotency_key:'identity-fullwidth-01',item:{...item,name:'１．５％酸奶'}}),{code:'duplicate_food'});
    assert.equal(s.searchFoodLibrary({}).total,2);
  } finally { s.close(); }
});

test('migration rechecks the version after obtaining the transaction lock', () => {
  const dir=mkdtempSync(join(tmpdir(),'boji-food-race-')),file=join(dir,'boji.sqlite');
  const initial=new Store(file);initial.db.exec('DROP TABLE food_library_history; DROP TABLE food_library; DELETE FROM migrations WHERE version=2');initial.close();
  class RacingStore extends Store {
    override transaction<T>(fn:()=>T):T {
      // Another initializer wins after this initializer's optimistic version check.
      if(!this.db.prepare('SELECT version FROM migrations WHERE version=2').get()){const peer=new Store(this.path,this.timezone);peer.close();}
      return super.transaction(fn);
    }
  }
  try {
    const s=new RacingStore(file);
    try { assert.equal(s.searchFoodLibrary({}).total,0);assert.equal(s.db.prepare('SELECT count(*) AS n FROM migrations WHERE version=2').get()!.n,1); }
    finally { s.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
