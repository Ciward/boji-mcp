import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import type { FoodLibraryItem, Meal } from '../src/model.js';

const sample = {
  kind: 'dish' as const,
  name: '招牌鸡肉饭',
  aliases: ['鸡肉便当', 'Signature Chicken Rice'],
  restaurant_name: '好味食堂',
  variant: '少饭',
  serving_label: '1盒，少饭',
  amount_g: 420,
  nutrients: { energy_kcal: 560, protein_g: 32, carbs_g: 64, fat_g: 18, fiber_g: null, sugar_g: null, sodium_mg: null, saturated_fat_g: null },
  confidence: 'medium' as const,
  evidence: 'restaurant_menu' as const,
  notes: '菜单核验；钠与糖未知。',
  source_urls: ['https://example.com/menu/chicken-rice'],
  verified_at: '2026-10-24T01:00:00.000Z',
};
type SavedFood = { persisted: boolean; item: FoodLibraryItem; replayed?: boolean };
type FoodPage = { items: FoodLibraryItem[]; total: number };
type FoodHistory = { items: Array<{ version: number; operation: string; actor: string; snapshot: FoodLibraryItem }> };
type ExportData = { food_library: FoodLibraryItem[]; food_library_history: Array<FoodHistory['items'][number] & { food_id: string }>; meals: Meal[] };

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function fixture(t: TestContext) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const directory = mkdtempSync(join(tmpdir(), 'boji-food-library-api-'));
  const password = randomBytes(24).toString('hex');
  const { app, store } = createApp({ host: '127.0.0.1', port, publicUrl: base, dataDir: directory,
    timezone: 'Asia/Shanghai', adminPassword: password, webDir: join(directory, 'nonexistent') });
  const clients: Client[] = [];
  const tokensByClient = new Map<Client, string>();
  const server = app.listen(port, '127.0.0.1');
  t.after(async () => {
    try { await Promise.all(clients.map(client => client.close())); }
    finally {
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') =>
    fetch(base + path, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const text = await response.text();
    assert.equal(response.status, status, `${response.url}: ${text}`);
    return JSON.parse(text) as T;
  };
  const login = await request('/api/v1/login', { password }, { Origin: base });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const { csrf_token } = await json<{ csrf_token: string }>(login);
  assert.ok(csrf_token);
  const readHeaders = { Cookie: cookie };
  const writeHeaders = { ...readHeaders, Origin: base, 'X-CSRF-Token': csrf_token };
  const redirectUri = 'https://client.example/food-library-callback';
  const registration = await json<{ client_id: string }>(await request('/oauth/register', {
    client_name: 'Food library API integration', redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
  }), 201);

  async function connect(scope = 'health.read health.write') {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomUUID();
    const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirectUri, response_type: 'code',
      scope, resource: base + '/mcp', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state });
    const consentPage = await request('/oauth/authorize?' + query, undefined, readHeaders);
    assert.equal(consentPage.status, 200);
    const html = await consentPage.text();
    const requestId = html.match(/name="request_id" value="([^"<>]+)"/)?.[1];
    assert.ok(requestId, 'OAuth consent must provide a real authorization request');
    const consent = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual',
      headers: { ...readHeaders, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request_id: requestId, csrf_token, decision: 'approve' }) });
    assert.equal(consent.status, 303, await consent.text());
    const location = consent.headers.get('location');
    assert.ok(location);
    const redirect = new URL(location);
    assert.equal(redirect.origin + redirect.pathname, redirectUri);
    assert.equal(redirect.searchParams.get('state'), state);
    assert.equal(redirect.searchParams.get('iss'), base);
    const code = redirect.searchParams.get('code');
    assert.ok(code);
    const tokens = await json<{ access_token: string; scope: string }>(await fetch(base + '/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirectUri, grant_type: 'authorization_code',
        code, code_verifier: verifier, resource: base + '/mcp' }),
    }));
    assert.ok(tokens.access_token);
    assert.equal(tokens.scope, scope);
    const client = new Client({ name: 'boji-food-library-api-test', version: '1' });
    clients.push(client);
    tokensByClient.set(client, tokens.access_token);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } },
    }));
    return client;
  }

  // Compare records, history, revision and idempotency entries, not just row counts.
  const ledger = () => Object.fromEntries(['food_library', 'food_library_history', 'meals', 'meal_history', 'operations', 'settings']
    .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  // SDK parsing removes unknown top-level descriptor fields; inspect their actual wire representation.
  const wireTools = async (client: Client) => json<{ result: { tools: Array<{ name: string; securitySchemes: unknown; _meta?: { securitySchemes: unknown } }> } }>(
    await request('/mcp', { jsonrpc: '2.0', id: 'food-tool-permissions', method: 'tools/list' }, {
      Authorization: 'Bearer ' + tokensByClient.get(client), Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
    }));
  return { base, request, json, readHeaders, writeHeaders, connect, ledger, wireTools };
}

async function mcp<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
  assert.ok(result.structuredContent, name + ' must return structured content');
  return result.structuredContent as T;
}

test('food library shares MCP/REST provenance, optimistic versions, archive history and immutable meal snapshots', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect();
  const expectedScopes: Record<string, string> = {
    boji_get_context: 'health.read', boji_record_meal: 'health.write', boji_get_meal: 'health.read', boji_list_meals: 'health.read',
    boji_update_meal: 'health.write', boji_delete_meal: 'health.write', boji_restore_meal: 'health.write',
    boji_get_summary: 'health.read', boji_get_source_status: 'health.read', boji_get_trends: 'health.read',
    boji_search_food_library: 'health.read', boji_get_food_library_item: 'health.read', boji_record_food_library_item: 'health.write',
    boji_update_food_library_item: 'health.write', boji_delete_food_library_item: 'health.write', boji_restore_food_library_item: 'health.write',
  };
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  assert.deepEqual(new Set(tools.map(tool => tool.name)), new Set(Object.keys(expectedScopes)));
  for (const tool of tools) {
    const required = [{ type: 'oauth2', scopes: [expectedScopes[tool.name]] }];
    assert.deepEqual(tool._meta?.securitySchemes, required, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, expectedScopes[tool.name] === 'health.read', tool.name);
  }
  const wire = await f.wireTools(client);
  assert.equal(wire.result.tools.length, 16);
  assert.deepEqual(new Set(wire.result.tools.map(tool => tool.name)), new Set(Object.keys(expectedScopes)));
  for (const tool of wire.result.tools) {
    const required = [{ type: 'oauth2', scopes: [expectedScopes[tool.name]] }];
    assert.deepEqual(tool.securitySchemes, required, tool.name + ' top-level permissions');
    assert.deepEqual(tool._meta?.securitySchemes, required, tool.name + ' compatibility permissions');
  }
  await mcp(client, 'boji_get_context');
  const saved = await mcp<SavedFood>(client, 'boji_record_food_library_item', { idempotency_key: 'api-food-create-01', item: sample });
  assert.equal(saved.persisted, true);
  assert.equal(saved.item.version, 1);
  const id = saved.item.id;
  assert.ok(id);
  const read = await f.json<{ item: FoodLibraryItem }>(await f.request('/api/v1/foods/' + id, undefined, f.readHeaders));
  assert.deepEqual(read.item, saved.item);
  assert.deepEqual(read.item.nutrients, sample.nutrients);
  assert.deepEqual(read.item.source_urls, sample.source_urls);
  assert.equal(read.item.evidence, sample.evidence);
  assert.equal(read.item.verified_at, sample.verified_at);
  const replay = await mcp<SavedFood>(client, 'boji_record_food_library_item', { idempotency_key: 'api-food-create-01', item: sample });
  assert.equal(replay.replayed, true);
  assert.equal(replay.item.id, id);
  // A same-name dish at another restaurant makes the restaurant filter discriminating.
  const other = await f.json<SavedFood>(await f.request('/api/v1/foods', {
    idempotency_key: 'api-food-other-restaurant', item: { ...sample, restaurant_name: '另一家食堂' },
  }, f.writeHeaders), 201);
  assert.notEqual(other.item.id, id);
  const restaurant = await f.json<FoodPage>(await f.request('/api/v1/foods?' + new URLSearchParams({ query: sample.name, restaurant_name: '好味', kind: 'dish' }), undefined, f.readHeaders));
  assert.equal(restaurant.total, 1);
  assert.deepEqual(restaurant.items.map(item => item.id), [id]);
  const alias = await mcp<FoodPage>(client, 'boji_search_food_library', { query: 'ＳＩＧＮＡＴＵＲＥ Chicken Rice', restaurant_name: '好味食堂' });
  assert.equal(alias.total, 1);
  assert.deepEqual(alias.items.map(item => item.id), [id]);
  const chineseAlias = await f.json<FoodPage>(await f.request('/api/v1/foods?' + new URLSearchParams({ query: '鸡肉便当', restaurant_name: '好味食堂' }), undefined, f.readHeaders));
  assert.deepEqual(chineseAlias.items.map(item => item.id), [id]);
  assert.equal((await mcp<FoodPage>(client, 'boji_search_food_library', { query: sample.name, restaurant_name: '不存在的餐厅' })).total, 0);

  const meal = { title: '库条目引用午餐', occurred_at: '2026-10-24T12:00:00+08:00', meal_type: 'lunch', items: [{
    name: saved.item.name, amount_g: saved.item.amount_g, consumed_fraction: 0.5, nutrients: saved.item.nutrients,
    evidence: 'database', confidence: 'medium', notes: '核对餐厅与少饭规格；实际吃了一半。', food_library_ref: { id, version: saved.item.version },
  }] };
  const recorded = await mcp<{ persisted: boolean; meal: Meal }>(client, 'boji_record_meal', { idempotency_key: 'api-meal-library-snapshot', meal });
  assert.equal(recorded.persisted, true);
  assert.deepEqual(recorded.meal.items[0]!.food_library_ref, { id, version: 1 });
  assert.deepEqual(recorded.meal.items[0]!.nutrients, saved.item.nutrients);
  assert.equal(recorded.meal.totals.energy_kcal, 280);
  assert.equal(recorded.meal.totals.sodium_mg, null);

  const correction = { ...sample, evidence: 'manual', notes: '人工核对菜单与份量，修正能量。', nutrients: { ...sample.nutrients, energy_kcal: 620 } };
  const edited = await f.json<SavedFood>(await f.request('/api/v1/foods/' + id, { expected_version: 1, idempotency_key: 'api-food-human-correction', item: correction }, f.writeHeaders, 'PUT'));
  assert.equal(edited.persisted, true);
  const reread = await mcp<{ item: FoodLibraryItem }>(client, 'boji_get_food_library_item', { id });
  assert.deepEqual(reread.item, edited.item);
  assert.equal(reread.item.version, 2);
  assert.equal(reread.item.nutrients.energy_kcal, 620);
  assert.equal(reread.item.evidence, 'manual');
  assert.deepEqual(reread.item.source_urls, sample.source_urls);
  const beforeConflict = f.ledger();
  const stale = await client.callTool({ name: 'boji_update_food_library_item', arguments: { id, expected_version: 1, idempotency_key: 'api-food-stale-mcp', item: sample } });
  assert.equal(stale.isError, true);
  assert.equal((stale.structuredContent as { error: { code: string } }).error.code, 'version_conflict');
  const staleRest = await f.json<{ error: { code: string; details: { current_version: number } } }>(await f.request('/api/v1/foods/' + id, {
    expected_version: 1, idempotency_key: 'api-food-stale-rest', item: sample,
  }, f.writeHeaders, 'PUT'), 409);
  assert.equal(staleRest.error.code, 'version_conflict');
  assert.equal(staleRest.error.details.current_version, 2);
  assert.deepEqual(f.ledger(), beforeConflict);
  const staleMeal = await client.callTool({ name: 'boji_record_meal', arguments: { idempotency_key: 'api-meal-stale-food-reference', meal } });
  assert.equal(staleMeal.isError, true);
  assert.equal((staleMeal.structuredContent as { error: { code: string } }).error.code, 'food_library_version_conflict');
  assert.deepEqual(f.ledger(), beforeConflict);

  const deleted = await mcp<SavedFood>(client, 'boji_delete_food_library_item', { id, expected_version: 2, idempotency_key: 'api-food-delete' });
  assert.equal(deleted.persisted, true);
  assert.equal(deleted.item.version, 3);
  assert.ok(deleted.item.archived_at);
  const searchArgs = { query: sample.name, restaurant_name: sample.restaurant_name };
  assert.equal((await mcp<FoodPage>(client, 'boji_search_food_library', searchArgs)).total, 0);
  const defaultSearch = await f.json<FoodPage>(await f.request('/api/v1/foods?' + new URLSearchParams(searchArgs), undefined, f.readHeaders));
  assert.equal(defaultSearch.total, 0);
  const archived = await f.json<FoodPage>(await f.request('/api/v1/foods?' + new URLSearchParams({ ...searchArgs, archived: 'true' }), undefined, f.readHeaders));
  assert.deepEqual(archived.items.map(item => item.id), [id]);
  const archivedExport = await f.json<ExportData>(await f.request('/api/v1/export', undefined, f.readHeaders));
  assert.deepEqual(archivedExport.food_library.find(item => item.id === id), deleted.item);

  const restored = await mcp<SavedFood>(client, 'boji_restore_food_library_item', { id, expected_version: 3, idempotency_key: 'api-food-restore' });
  assert.equal(restored.persisted, true);
  assert.equal(restored.item.version, 4);
  assert.equal(restored.item.archived_at, null);
  assert.deepEqual((await mcp<FoodPage>(client, 'boji_search_food_library', searchArgs)).items.map(item => item.id), [id]);
  const latest = await mcp<SavedFood>(client, 'boji_update_food_library_item', { id, expected_version: 4, idempotency_key: 'api-food-update-current',
    item: { ...correction, nutrients: { ...correction.nutrients, energy_kcal: 700 } } });
  assert.equal(latest.persisted, true);
  assert.equal(latest.item.version, 5);
  const history = await f.json<FoodHistory>(await f.request('/api/v1/foods/' + id + '/history', undefined, f.readHeaders));
  assert.deepEqual(history.items.map(({ version, operation, actor }) => ({ version, operation, actor })), [
    { version: 5, operation: 'update', actor: 'mcp' }, { version: 4, operation: 'restore', actor: 'mcp' },
    { version: 3, operation: 'delete', actor: 'mcp' }, { version: 2, operation: 'update', actor: 'web' }, { version: 1, operation: 'create', actor: 'mcp' },
  ]);
  assert.deepEqual(history.items[4]!.snapshot, saved.item);
  assert.deepEqual(history.items[0]!.snapshot, latest.item);
  const oldMeal = await mcp<{ meal: Meal }>(client, 'boji_get_meal', { id: recorded.meal.id });
  assert.deepEqual(oldMeal.meal, recorded.meal, 'library edits/archive/restore must leave the recorded meal snapshot intact');
  const restMeal = await f.json<{ meal: Meal }>(await f.request('/api/v1/meals/' + recorded.meal.id, undefined, f.readHeaders));
  assert.deepEqual(restMeal.meal, recorded.meal);
  const exported = await f.json<ExportData>(await f.request('/api/v1/export', undefined, f.readHeaders));
  assert.deepEqual(exported.food_library.find(item => item.id === id), latest.item);
  const exportedHistory = exported.food_library_history.filter(item => item.food_id === id).sort((a, b) => b.version - a.version)
    .map(({ food_id: _foodId, ...entry }) => entry);
  assert.deepEqual(exportedHistory, history.items);
  assert.deepEqual(exported.meals.find(item => item.id === recorded.meal.id), recorded.meal);
});

test('food-library REST requires a browser session and CSRF; source tokens cannot read the library', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const saved = await f.json<SavedFood>(await f.request('/api/v1/foods', { idempotency_key: 'api-security-create', item: sample }, f.writeHeaders), 201);
  const id = saved.item.id;
  const before = f.ledger();
  for (const path of ['/api/v1/foods', '/api/v1/foods/' + id, '/api/v1/foods/' + id + '/history', '/api/v1/export']) {
    const response = await f.request(path);
    assert.equal(response.status, 401, path + ': ' + await response.text());
  }
  for (const [path, method, body] of [
    ['/api/v1/foods', 'POST', { idempotency_key: 'api-no-csrf-create', item: { ...sample, name: '未授权新条目' } }],
    ['/api/v1/foods/' + id, 'PUT', { idempotency_key: 'api-no-csrf-update', expected_version: 1, item: { ...sample, notes: '禁止修正' } }],
    ['/api/v1/foods/' + id + '/delete', 'POST', { idempotency_key: 'api-no-csrf-delete', expected_version: 1 }],
    ['/api/v1/foods/' + id + '/restore', 'POST', { idempotency_key: 'api-no-csrf-restore', expected_version: 1 }],
  ] as const) {
    const unauthenticated = await f.request(path, body, {}, method);
    assert.equal(unauthenticated.status, 401, path + ': ' + await unauthenticated.text());
    const noCsrf = await f.request(path, body, f.readHeaders, method);
    assert.equal(noCsrf.status, 403, path + ': ' + await noCsrf.text());
    assert.deepEqual(f.ledger(), before, path + ' must not mutate data without session/CSRF');
  }
  const source = await f.json<{ token: string; source: { id: string } }>(await f.request('/api/v1/sources', {
    name: 'Food library boundary test', kind: 'health_auto_export',
  }, f.writeHeaders), 201);
  assert.ok(source.token);
  const sourceHeaders = { Authorization: 'Bearer ' + source.token };
  const ingest = await f.request('/ingest/v1/' + source.source.id, { data: { metrics: [] } }, sourceHeaders);
  assert.equal(ingest.status, 200, await ingest.text());
  for (const path of ['/api/v1/foods', '/api/v1/foods/' + id, '/api/v1/foods/' + id + '/history', '/api/v1/export']) {
    const response = await f.request(path, undefined, sourceHeaders);
    assert.equal(response.status, 401, path + ': ' + await response.text());
  }
  const sourceMcp = await f.request('/mcp', { jsonrpc: '2.0', id: 'source-food-read', method: 'tools/call',
    params: { name: 'boji_get_food_library_item', arguments: { id } } }, { ...sourceHeaders, Accept: 'application/json, text/event-stream' });
  assert.equal(sourceMcp.status, 401, await sourceMcp.text());
  assert.deepEqual(f.ledger(), before);
});

test('read-only OAuth MCP can search/get but all four library write tools fail without ledger side effects', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const writer = await f.connect();
  const active = await mcp<SavedFood>(writer, 'boji_record_food_library_item', { idempotency_key: 'api-readonly-active', item: sample });
  const archived = await mcp<SavedFood>(writer, 'boji_record_food_library_item', { idempotency_key: 'api-readonly-archive-create', item: { ...sample, name: '已归档牛肉饭' } });
  const deleted = await mcp<SavedFood>(writer, 'boji_delete_food_library_item', { id: archived.item.id, expected_version: 1, idempotency_key: 'api-readonly-archive-delete' });
  assert.ok(deleted.item.archived_at);
  const reader = await f.connect('health.read');
  const before = f.ledger();
  const found = await mcp<FoodPage>(reader, 'boji_search_food_library', { query: sample.aliases[0], restaurant_name: sample.restaurant_name });
  assert.equal(found.total, 1);
  assert.deepEqual(found.items.map(item => item.id), [active.item.id]);
  assert.deepEqual((await mcp<{ item: FoodLibraryItem }>(reader, 'boji_get_food_library_item', { id: active.item.id })).item, active.item);
  // Each attempted mutation has valid arguments and a target in a state where a writer could apply it.
  for (const [name, args] of [
    ['boji_record_food_library_item', { idempotency_key: 'api-readonly-denied-create', item: { ...sample, name: '只读禁止新增' } }],
    ['boji_update_food_library_item', { id: active.item.id, expected_version: 1, idempotency_key: 'api-readonly-denied-update', item: { ...sample, notes: '只读禁止修正' } }],
    ['boji_delete_food_library_item', { id: active.item.id, expected_version: 1, idempotency_key: 'api-readonly-denied-delete' }],
    ['boji_restore_food_library_item', { id: archived.item.id, expected_version: 2, idempotency_key: 'api-readonly-denied-restore' }],
  ] as const) {
    const refused = await reader.callTool({ name, arguments: args });
    assert.equal(refused.isError, true, name);
    const challenges = refused._meta?.['mcp/www_authenticate'];
    assert.ok(Array.isArray(challenges), name + ' must return an OAuth scope challenge');
    assert.equal(challenges.length, 1);
    assert.match(challenges[0], /error="insufficient_scope"/);
    assert.match(challenges[0], /scope="health.read health.write"/);
    assert.ok(challenges[0].includes(`resource_metadata="${f.base}/.well-known/oauth-protected-resource/mcp"`));
    assert.deepEqual(f.ledger(), before, name + ' must not change records, history, revision or idempotency state');
  }
  assert.deepEqual((await mcp<{ item: FoodLibraryItem }>(reader, 'boji_get_food_library_item', { id: active.item.id })).item, active.item);
  assert.deepEqual((await mcp<{ item: FoodLibraryItem }>(reader, 'boji_get_food_library_item', { id: archived.item.id })).item, deleted.item);
  assert.deepEqual(f.ledger(), before);
});
