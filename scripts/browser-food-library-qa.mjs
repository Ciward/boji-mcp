// Usage: BOJI_FOOD_QA_ISOLATED=1 node scripts/browser-food-library-qa.mjs http://127.0.0.1:18789 /tmp/isolated-auth.json
// The credential file must contain { password, isolated: true }. This script writes test records.
import { chromium, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [baseArgument, credential] = process.argv.slice(2);
if (!baseArgument || !credential || process.env.BOJI_FOOD_QA_ISOLATED !== '1') throw new Error('Provide an explicitly isolated localhost test server and credential file; set BOJI_FOOD_QA_ISOLATED=1.');
const target = new URL(baseArgument);
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.port || ['8787', '80', '443'].includes(target.port) || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Refusing writes outside an isolated localhost origin on a non-production port.');
const { password, isolated } = JSON.parse(readFileSync(credential, 'utf8'));
if (!password || isolated !== true) throw new Error('Credential file must explicitly declare isolated:true.');
const base = target.origin;
const output = process.env.BOJI_FOOD_QA_OUTPUT || '/tmp/boji-food-library-qa';
mkdirSync(output, { recursive: true });
const launch = { headless: true };
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
else if (process.platform === 'darwin') launch.executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/New_York' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const suffix = randomUUID().slice(0, 8);
const name = `QA常用菜-${suffix}`, alias = `QA别名-${suffix}`, restaurant = `QA餐厅-${suffix}`;
const nav = () => page.getByRole('navigation', { name: '主导航' });
const dialog = () => page.getByRole('dialog');
const save = () => dialog().getByRole('button', { name: '保存条目', exact: true }).click();
const login = async () => {
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '打开我的日记' }).click();
  await expect(page.getByRole('heading', { name: '饮食日记', exact: true }).or(page.getByRole('heading', { name: '食物库', exact: true }))).toBeVisible();
};
let csrf;
const mutation = async (method, path, payload) => {
  const result = await page.request.fetch(base + '/api/v1' + path, { method, headers: { 'X-CSRF-Token': csrf, Origin: base }, data: { idempotency_key: randomUUID(), ...payload } });
  if (!result.ok()) throw new Error(`QA setup ${method} ${path}: ${result.status()} ${await result.text()}`);
  return result.json();
};
const getFood = async (id) => (await (await page.request.get(`${base}/api/v1/foods/${id}`)).json()).item;
const input = (food) => Object.fromEntries(['kind', 'name', 'aliases', 'restaurant_name', 'variant', 'serving_label', 'amount_g', 'nutrients', 'confidence', 'evidence', 'notes', 'source_urls', 'verified_at'].map((key) => [key, food[key]]));
async function noOverflow() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (await dialog().count()) expect(await dialog().evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
try {
  await page.goto(base);
  await login();
  csrf = (await (await page.request.get(base + '/api/v1/session')).json()).csrf_token;
  await nav().getByRole('button', { name: '食物库', exact: true }).click();
  await page.getByRole('button', { name: '新增条目' }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByLabel('类型', { exact: true }).last().selectOption('dish');
  await page.locator('#food-aliases-edit').fill(alias);
  await page.locator('#food-restaurant-edit').fill(restaurant);
  await page.getByLabel('参考份量', { exact: true }).fill('1碗');
  await page.getByLabel('能量 kcal', { exact: true }).fill('0');
  await page.getByLabel('来源类型').selectOption('restaurant_menu');
  await save();
  await expect(page.getByRole('alert')).toContainText('至少需要一个');
  await page.getByLabel('来源链接').fill('https://user:secret@example.com/menu');
  await save();
  await expect(page.getByRole('alert')).toContainText('无凭证');
  await page.getByLabel('来源链接').fill('https://example.com/menu');
  await page.getByLabel('核实时间', { exact: false }).fill('2026-10-24T12:30:15');
  // Persist the first save but lose its response: retry must reuse the exact idempotency key.
  let lostPayload, replayPayload;
  await page.route('**/api/v1/foods', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    lostPayload = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'QA：保存回执丢失，请重试' } }) });
    await page.unroute('**/api/v1/foods');
  });
  await save();
  await expect(page.getByRole('alert')).toContainText('保存回执丢失');
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(name);
  await dialog().getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '继续编辑食物库草稿' }).click();
  const replayRequest = page.waitForRequest((request) => request.url() === base + '/api/v1/foods' && request.method() === 'POST');
  await save();
  replayPayload = (await replayRequest).postDataJSON();
  expect(replayPayload).toEqual(lostPayload);
  await expect(dialog()).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const list = await (await page.request.get(base + '/api/v1/foods?query=' + encodeURIComponent(name))).json();
  expect(list.items).toHaveLength(1);
  let food = list.items[0];
  expect(food.nutrients.energy_kcal).toBe(0);
  expect(food.nutrients.protein_g).toBeNull();
  expect(food.amount_g).toBeNull();
  expect(food.verified_at).toBe('2026-10-24T04:30:15.000Z'); // Personal timezone, not browser timezone.
  // A duplicate is a correctable input error, not a stale-version conflict.
  await page.getByRole('button', { name: '新增条目' }).click();
  await page.getByLabel('名称', { exact: true }).fill(name);
  await dialog().locator('#food-kind-edit').selectOption('dish');
  await dialog().locator('#food-restaurant-edit').fill(restaurant);
  await page.getByLabel('参考份量', { exact: true }).fill('1碗');
  await save();
  await expect(page.getByRole('alert')).toContainText('同一餐厅');
  await expect(dialog().getByRole('button', { name: '保存条目', exact: true })).toBeEnabled();
  await page.getByLabel('名称', { exact: true }).fill(name + '-修改名称');
  await expect(dialog().getByRole('button', { name: '保存条目', exact: true })).toBeEnabled();
  await dialog().getByRole('button', { name: '放弃草稿', exact: true }).click();
  await dialog().getByRole('button', { name: '确认放弃', exact: true }).click();
  await page.getByLabel('名称、别名或餐厅').fill(alias);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.locator('#food-restaurant').fill(restaurant);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.locator('#food-kind').selectOption('dish');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('我的草稿修改');
  const concurrent = await mutation('PUT', '/foods/' + food.id, { expected_version: food.version, item: { ...input(food), name: `并行修改-${suffix}`, notes: '另一入口修改' } });
  await save();
  await expect(page.getByText('条目已被其他操作更新')).toBeVisible();
  await expect(page.getByLabel('备注', { exact: true })).toHaveValue('我的草稿修改');
  await expect(dialog().getByRole('button', { name: '保存条目', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '加载最新版', exact: true }).click();
  await expect(dialog().getByText('另一入口修改', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /保留草稿，合并到版本/ }).click();
  await expect(dialog().getByRole('button', { name: '保存条目', exact: true })).toBeEnabled();
  await dialog().locator('#food-variant-edit').fill('QA确认的合并版本');
  await save();
  await expect(dialog()).toHaveCount(0);
  food = await getFood(food.id);
  expect(food.version).toBe(concurrent.item.version + 1);
  expect(food.notes).toBe('我的草稿修改');
  expect(food.name).toBe(`并行修改-${suffix}`);
  expect(food.variant).toBe('QA确认的合并版本');
  expect(food.verified_at).toBe('2026-10-24T04:30:15.000Z');
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(dialog().getByText(/版本 3/)).toBeVisible();
  await dialog().getByRole('button', { name: '收起面板' }).click();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await dialog().getByRole('button', { name: '确认归档' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  expect((await getFood(food.id)).archived_at).not.toBeNull();
  await page.getByLabel('显示已归档').check();
  await expect(page.getByRole('heading', { name: concurrent.item.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await dialog().getByRole('button', { name: '确认恢复' }).click();
  await expect(dialog()).toHaveCount(0);
  expect((await getFood(food.id)).archived_at).toBeNull();
  await page.getByLabel('显示已归档').uncheck();
  // Real pagination: seed unique, isolated records through the same API contract.
  for (let index = 0; index < 21; index++) await mutation('POST', '/foods', { item: { ...input(food), name: `${name}-分页-${String(index).padStart(2, '0')}` } });
  await page.getByLabel('名称、别名或餐厅').fill(alias);
  await page.getByRole('button', { name: '刷新所有数据' }).click();
  await expect(page.locator('.food-card')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.food-card')).toHaveCount(2);
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.locator('.food-card')).toHaveCount(20);
  await page.screenshot({ path: output + '/desktop-food-library.png', fullPage: true });
  // UI draft must survive a 401 and remount of the modal, then clear on deliberate logout.
  await page.getByRole('button', { name: '新增条目' }).click();
  await page.getByLabel('名称', { exact: true }).fill('会话过期保留草稿');
  await page.route('**/api/v1/foods', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'QA会话过期' } }) });
    await page.unroute('**/api/v1/foods');
  });
  await save();
  await expect(page.getByLabel('访问密码')).toBeVisible();
  await expect(dialog()).toHaveCount(0);
  await login();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('会话过期保留草稿');
  await dialog().getByRole('button', { name: '收起', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: output + '/mobile-food-library.png', fullPage: true });
  await page.getByRole('button', { name: '继续编辑食物库草稿' }).click();
  await noOverflow();
  await page.screenshot({ path: output + '/mobile-food-editor.png', fullPage: true });
  await dialog().getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '退出登录', exact: true }).filter({ visible: true }).click();
  await dialog().getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeVisible();
  await login();
  await page.getByRole('navigation', { name: '移动导航' }).getByRole('button', { name: '食物库', exact: true }).click();
  await expect(page.getByText('有一份未保存的食物库草稿')).toHaveCount(0);
  await page.getByRole('button', { name: '新增条目' }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('');
  await noOverflow();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ create: true, duplicate_is_correctable: true, search_alias_restaurant_kind: true, pagination: true, unknown_null_zero: true, source_validation: true, personal_timezone: true, idempotent_lost_receipt_retry: true, conflict_draft_merge: true, history: true, archive_restore: true, session_expiry_draft: true, logout_clears_draft: true, mobile_390_no_overflow: true, screenshots: output, page_errors: errors }));
} finally {
  try {
    let current = await (await page.request.get(base + '/api/v1/session')).json();
    if (!current.authenticated) {
      await page.request.post(base + '/api/v1/login', { headers: { Origin: base }, data: { password } });
      current = await (await page.request.get(base + '/api/v1/session')).json();
    }
    if (current.authenticated) {
      csrf = current.csrf_token;
      for (const archived of [false, true]) {
        const remaining = await (await page.request.get(`${base}/api/v1/foods?query=${encodeURIComponent(suffix)}&archived=${archived}&limit=50&offset=0`)).json();
        for (const item of remaining.items) if (!item.archived_at) await mutation('POST', `/foods/${item.id}/delete`, { expected_version: item.version });
      }
    }
  } catch (cleanupError) { console.error('Isolated QA cleanup was incomplete:', cleanupError.message); }
  await browser.close();
}
