import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createAuth } from '../src/auth.js';
import { requestWithHost } from './helpers/http.js';

const PASSWORD = 'test-only-Boji-secret-294!';
const REDIRECT = 'https://client.example/callback?connection=one';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
const epoch = () => Math.floor(Date.now() / 1000);
type ObjectBody = Record<string, unknown>;
type Browser = { cookie: string; csrf?: string };
type Client = { client_id: string; redirect_uris: string[]; scope: string };
type Tokens = { access_token: string; refresh_token: string; scope: string; token_type: string; expires_in: number };
type Consent = { request_id: string; csrf_token: string; response: Response; html: string };

async function fixture(t: TestContext, options: { file?: string; publicUrl?: string; publicUrlAliases?: string[]; password?: string } = {}) {
  const app = express();
  // Match the app's outer security headers: consent overrides must survive redirects.
  app.use((_req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const origin = options.publicUrl ?? base;
  const db = new DatabaseSync(options.file ?? ':memory:');
  const auth = createAuth(app, db, { publicUrl: origin, publicUrlAliases: options.publicUrlAliases, adminPassword: options.password ?? PASSWORD });
  app.get('/api/v1/private', auth.requireSession, (_req, res) => { res.json({ session: res.locals.session }); });
  app.post('/api/v1/private', auth.requireSession, auth.requireCsrf, (_req, res) => { res.json({ ok: true }); });
  app.all('/mcp', auth.requireMcp, (_req, res) => { res.json(res.locals.auth); });
  // This is the tool-specific scope gate the MCP integration must apply after requireMcp.
  app.post('/mcp-write', auth.requireMcp, (_req, res) => {
    res.status(res.locals.auth.scopes.includes('health.write') ? 200 : 403).json({ scopes: res.locals.auth.scopes });
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  };
  t.after(close);
  async function request(path: string, init: RequestInit = {}, browser?: Browser): Promise<Response> {
    const headers = new Headers(init.headers);
    if (options.publicUrl && !headers.has('Host')) headers.set('Host', new URL(origin).host);
    if (browser?.cookie) headers.set('Cookie', browser.cookie);
    const response = await requestWithHost(base + path, { ...init, headers });
    const cookie = response.headers.get('set-cookie');
    if (browser && cookie) browser.cookie = cookie.split(';')[0]!;
    return response;
  }
  const json = (path: string, body: ObjectBody, browser?: Browser, headers: Record<string, string> = {}) => request(path,
    { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, browser);
  const form = (path: string, body: Record<string, string>, browser?: Browser, headers: Record<string, string> = {}) => request(path,
    { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) }, browser);
  const login = async (browser: Browser = { cookie: '' }) => {
    const response = await json('/api/v1/login', { password: PASSWORD }, browser);
    assert.equal(response.status, 200, await response.clone().text());
    browser.csrf = (await response.json()).csrf_token;
    return browser;
  };
  const register = async (metadata: ObjectBody = {}): Promise<Client> => {
    const response = await json('/oauth/register', { client_name: 'Test client', redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', ...metadata });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const authorize = async (client: Client, pkce: string, browser: Browser, overrides: Record<string, string | undefined> = {}): Promise<Consent> => {
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, response_type: 'code',
      code_challenge: challenge(pkce), code_challenge_method: 'S256', resource: origin + '/mcp', scope: 'health.read health.write',
      state: 'opaque-state+&/123' });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) query.delete(key); else query.set(key, value);
    }
    const response = await request('/oauth/authorize?' + query, {}, browser);
    const html = await response.text();
    const hidden = (name: string) => html.match(new RegExp(`name="${name}" value="([^"<>]+)"`))?.[1] ?? '';
    return { request_id: hidden('request_id'), csrf_token: hidden('csrf_token'), response, html };
  };
  const consent = (flow: Consent, browser: Browser, values: Record<string, string> = {}) => form('/oauth/authorize',
    { request_id: flow.request_id, csrf_token: flow.csrf_token, decision: 'approve', password: PASSWORD, ...values }, browser);
  const code = async (client: Client, pkce: string, scope = 'health.read health.write', browser: Browser = { cookie: '' }): Promise<string> => {
    const flow = await authorize(client, pkce, browser, { scope });
    assert.equal(flow.response.status, 200, flow.html);
    const response = await consent(flow, browser);
    assert.equal(response.status, 303, await response.clone().text());
    return new URL(response.headers.get('location')!).searchParams.get('code')!;
  };
  const exchange = (client: Client, raw: string, pkce: string, extra: Record<string, string> = {}) => form('/oauth/token',
    { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, resource: origin + '/mcp',
      code: raw, code_verifier: pkce, ...extra });
  const grant = async (scope = 'health.read health.write') => {
    const client = await register();
    const pkce = randomBytes(32).toString('base64url');
    const raw = await code(client, pkce, scope);
    const response = await exchange(client, raw, pkce);
    assert.equal(response.status, 200, await response.clone().text());
    const tokens = await response.json() as Tokens;
    return { client, pkce, raw, tokens };
  };
  const refresh = (client: Client, token: string, extra: Record<string, string> = {}) => form('/oauth/token',
    { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token, resource: origin + '/mcp', ...extra });
  const mcp = (token: string, path = '/mcp') => request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return { app, db, base, origin, request, json, form, login, register, authorize, consent, code, exchange, grant, refresh, mcp, close };
}

async function error(response: Response, status: number, kind: string) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).error, kind);
}

test('rejects insecure PUBLIC_URL and missing/weak/malformed administrator secrets', () => {
  for (const publicUrl of ['http://example.com', 'http://localhost.evil.test', 'ftp://localhost', 'https://user:pw@example.com',
    'https://example.com/path', 'https://example.com?query=1', 'https://example.com#', 'https://example.com/../bad', 'https://*.example.com']) {
    const db = new DatabaseSync(':memory:');
    try { assert.throws(() => createAuth(express(), db, { publicUrl, adminPassword: PASSWORD }), /PUBLIC_URL/); }
    finally { db.close(); }
  }
  for (const adminPassword of ['', 'short', 'scrypt$wrong']) {
    const db = new DatabaseSync(':memory:');
    try { assert.throws(() => createAuth(express(), db, { publicUrl: 'http://localhost:3000', adminPassword }), /ADMIN_PASSWORD/); }
    finally { db.close(); }
  }
});

test('discovery advertises PKCE, DCR, issuer responses and exact MCP resource; anonymous MCP is challenged', async t => {
  const f = await fixture(t);
  const metadata = await (await f.request('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.issuer, f.origin);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(metadata.registration_endpoint, f.origin + '/oauth/register');
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, false);
  const resource = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.deepEqual(resource, await (await f.request('/.well-known/oauth-protected-resource')).json());
  assert.equal(resource.resource, f.origin + '/mcp');
  assert.deepEqual(resource.scopes_supported, ['health.read', 'health.write']);
  const response = await f.request('/mcp?access_token=pretend');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate')!, new RegExp('resource_metadata="' + f.origin + '/.well-known/oauth-protected-resource/mcp"'));
  assert.match(response.headers.get('www-authenticate')!, /scope="health.read health.write"/);
  assert.doesNotMatch(response.headers.get('www-authenticate')!, /error(?:_description)?=/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/oauth/token', { method: 'OPTIONS' })).status, 204);
});

test('web login, hashed session, CSRF plus Origin checks, session rotation and logout over HTTP', async t => {
  const f = await fixture(t);
  await error(await f.request('/api/v1/session'), 401, 'unauthorized');
  await error(await f.json('/api/v1/login', { password: PASSWORD }, undefined, { Origin: 'https://evil.test' }), 403, 'invalid_origin');
  await error(await f.json('/api/v1/login', { password: 'wrong' }), 401, 'invalid_credentials');
  await error(await f.form('/api/v1/login', { password: PASSWORD }), 400, 'invalid_request');
  const browser: Browser = { cookie: '' };
  const response = await f.json('/api/v1/login', { password: PASSWORD }, browser);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Secure/);
  const payload = await response.json();
  assert.equal(payload.authenticated, true);
  browser.csrf = payload.csrf_token;
  const stored = f.db.prepare('SELECT * FROM auth_sessions').get()!;
  assert.equal(stored.token_hash, sha(browser.cookie.split('=')[1]!));
  assert.equal(stored.authenticated, 1);
  const read = await f.request('/api/v1/session', {}, browser);
  assert.deepEqual(await read.json(), payload);
  await error(await f.json('/api/v1/private', {}, browser), 403, 'invalid_csrf');
  await error(await f.json('/api/v1/private', {}, browser, { 'X-CSRF-Token': 'wrong' }), 403, 'invalid_csrf');
  await error(await f.json('/api/v1/private', {}, browser, { Origin: 'null', 'X-CSRF-Token': browser.csrf! }), 403, 'invalid_origin');
  await error(await f.json('/api/v1/private', {}, browser, { Origin: 'https://evil.test', 'X-CSRF-Token': browser.csrf! }), 403, 'invalid_origin');
  await error(await f.json('/api/v1/private', {}, browser, { 'Sec-Fetch-Site': 'cross-site', 'X-CSRF-Token': browser.csrf! }), 403, 'invalid_origin');
  await error(await f.request('/api/v1/private', { method: 'POST', headers: { 'X-CSRF-Token': browser.csrf! } }, browser), 403, 'invalid_origin');
  assert.equal((await f.json('/api/v1/private', {}, browser, { 'X-CSRF-Token': browser.csrf! })).status, 200);
  const old = { ...browser };
  await f.login(browser);
  assert.notEqual(browser.cookie, old.cookie);
  await error(await f.request('/api/v1/session', {}, old), 401, 'unauthorized');
  await error(await f.json('/api/v1/logout', {}, browser), 403, 'invalid_csrf');
  const revokedCookie = { ...browser };
  const logout = await f.json('/api/v1/logout', {}, browser, { 'X-CSRF-Token': browser.csrf! });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { authenticated: false });
  await error(await f.request('/api/v1/session', {}, revokedCookie), 401, 'unauthorized');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n, 0);
});

test('HTTPS uses host-only Secure cookies and accepts an explicit scrypt password verifier', async t => {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(PASSWORD, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  const f = await fixture(t, { publicUrl: 'https://legacy-boji.example.org', password: `scrypt$${salt}$${digest}` });
  const response = await f.json('/api/v1/login', { password: PASSWORD });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-boji_session=/); assert.match(cookie, /; Secure/); assert.doesNotMatch(cookie, /Domain=/);
  const bad = await f.json('/api/v1/login', { password: 'not-the-password' });
  assert.equal(bad.status, 401);
});

test('DCR accepts HTTPS and loopback callbacks, rejects wildcard/fragment/credentials and never fetches metadata', async t => {
  const f = await fixture(t);
  const redirects = ['https://client.example/callback', 'http://localhost:3456/cb', 'http://127.0.0.1:4567/cb', 'http://[::1]:4567/cb'];
  const client = await f.register({ redirect_uris: redirects, client_uri: 'http://169.254.169.254/latest/meta-data/' });
  assert.deepEqual(client.redirect_uris, redirects);
  for (const redirect of ['http://client.example/cb', 'http://localhost.evil/cb', '//client.example/cb', 'javascript:alert(1)',
    'https://client.example/*', 'https://*.example/cb', 'https://client.example/cb#fragment', 'https://client.example/cb#',
    'https://user:password@client.example/cb', 'https://client.example/cb?code=existing', 'https://client.example/\\evil', 'https://client.example;form-action/cb']) {
    await error(await f.json('/oauth/register', { redirect_uris: [redirect] }), 400, 'invalid_redirect_uri');
  }
  await error(await f.json('/oauth/register', { redirect_uris: [] }), 400, 'invalid_redirect_uri');
  await error(await f.json('/oauth/register', { redirect_uris: REDIRECT }), 400, 'invalid_redirect_uri');
});

test('DCR rejects unsupported authentication, grants and scopes', async t => {
  const f = await fixture(t);
  for (const metadata of [{ token_endpoint_auth_method: 'client_secret_basic' }, { grant_types: ['password'] },
    { grant_types: ['refresh_token'] }, { response_types: ['token'] }, { client_name: ['bad'] }]) {
    const response = await f.json('/oauth/register', { redirect_uris: [REDIRECT], ...metadata });
    assert.equal(response.status, 400);
  }
  await error(await f.json('/oauth/register', { redirect_uris: [REDIRECT], scope: 'admin' }), 400, 'invalid_scope');
  const response = await f.json('/oauth/register', { redirect_uris: [REDIRECT] });
  assert.deepEqual((await response.json()).grant_types, ['authorization_code']);
});

test('password form displays scopes and redirect origin safely, binds consent to browser, rotates on login', async t => {
  const f = await fixture(t);
  const client = await f.register({ client_name: '<script>alert("XSS")</script> & fraud' });
  const pkce = randomBytes(32).toString('base64url');
  const browser: Browser = { cookie: '' };
  const flow = await f.authorize(client, pkce, browser);
  assert.equal(flow.response.status, 200);
  assert.match(flow.html, /health.read/); assert.match(flow.html, /health.write/); assert.match(flow.html, /https:\/\/client.example/);
  assert.match(flow.html, /&lt;script&gt;/); assert.doesNotMatch(flow.html, /<script>/);
  assert.match(flow.response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(flow.response.headers.get('referrer-policy'), 'same-origin');
  assert.ok(flow.request_id); assert.ok(flow.csrf_token);
  assert.equal((await f.request('/api/v1/session', {}, browser)).status, 401);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, 0);
  assert.equal((await f.consent(flow, { cookie: '' })).status, 403);
  await error(await f.consent(flow, browser, { csrf_token: 'wrong' }), 403, 'invalid_csrf');
  const rejectedOrigin = await f.form('/oauth/authorize', { request_id: flow.request_id, csrf_token: flow.csrf_token, decision: 'approve', password: PASSWORD }, browser, { Origin: 'https://evil.test' });
  assert.equal(rejectedOrigin.status, 403);
  const badPassword = await f.consent(flow, browser, { password: 'wrong' });
  assert.equal(badPassword.status, 401); assert.match(await badPassword.text(), /密码错误/);
  const old = { ...browser };
  const response = await f.consent(flow, browser);
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('location')!);
  assert.equal(target.origin, 'https://client.example');
  assert.equal(target.searchParams.get('connection'), 'one');
  assert.equal(target.searchParams.get('state'), 'opaque-state+&/123');
  assert.equal(target.searchParams.get('iss'), f.origin);
  assert.ok(target.searchParams.get('code'));
  assert.notEqual(browser.cookie, old.cookie);
  assert.equal((await f.request('/api/v1/session', {}, browser)).status, 200);
  assert.equal((await f.request('/api/v1/session', {}, old)).status, 401);
  assert.equal((await f.consent(flow, old)).status, 403);
});

test('logged-in consent is explicit, deny returns state and issuer, and pending requests cannot be replayed', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const browser = await f.login();
  const flow = await f.authorize(client, 'x'.repeat(43), browser);
  assert.doesNotMatch(flow.html, /type="password"/);
  await error(await f.consent(flow, browser, { decision: 'anything' }), 400, 'invalid_request');
  const response = await f.consent(flow, browser, { decision: 'deny' });
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get('location')!);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.equal(target.searchParams.get('iss'), f.origin);
  assert.equal(target.searchParams.get('code'), null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, 0);
  await error(await f.consent(flow, browser), 400, 'invalid_request');
});

test('pending consent cannot be stolen by a different browser or used after expiry/logout', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const first: Browser = { cookie: '' }, second: Browser = { cookie: '' };
  const a = await f.authorize(client, 'a'.repeat(43), first);
  const b = await f.authorize(client, 'b'.repeat(43), second);
  await error(await f.consent(a, second, { csrf_token: b.csrf_token }), 400, 'invalid_request');
  f.db.prepare('UPDATE auth_pending SET expires_at = ? WHERE request_hash = ?').run(epoch() - 1, sha(a.request_id));
  await error(await f.consent(a, first), 400, 'invalid_request');
  const logged = await f.login();
  const c = await f.authorize(client, 'c'.repeat(43), logged);
  await f.json('/api/v1/logout', {}, logged, { 'X-CSRF-Token': logged.csrf! });
  assert.equal((await f.consent(c, logged)).status, 403);
});

test('opening the bare authorization URL in a browser explains how to connect without creating an authorization', async t => {
  const f = await fixture(t);
  const response = await f.request('/oauth/authorize', { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type')!, /^text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /请从客户端发起授权/);
  assert.match(html, /重新连接/);
  assert.ok(html.includes(f.origin + '/mcp'));
  assert.ok(!html.includes('<form'));
  for (const table of ['auth_clients', 'auth_sessions', 'auth_pending', 'auth_codes', 'auth_grants', 'auth_access_tokens', 'auth_refresh_tokens']) {
    assert.equal((f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
  }
  for (const accept of [undefined, '*/*', 'application/json', 'application/json, text/html;q=0.5']) {
    const rejected = await f.request('/oauth/authorize', { headers: accept ? { Accept: accept } : {} });
    assert.equal(rejected.status, 400);
    assert.match(rejected.headers.get('content-type')!, /^application\/json/);
    assert.deepEqual(await rejected.json(), { error: 'invalid_request', error_description: 'Invalid client_id' });
  }
});

test('authorization validation rejects bad resource/scope/PKCE/redirect and duplicate parameters without redirecting', async t => {
  const f = await fixture(t);
  const client = await f.register({ scope: 'health.read' });
  const invalidRequests: Record<string, string>[] = [{ resource: f.origin }, { resource: f.origin + '/mcp/' }, { scope: 'health.write' }, { scope: 'unknown' },
    { code_challenge_method: 'plain' }, { code_challenge: 'short' }, { response_type: 'token' },
    { redirect_uri: 'https://evil.test/callback' }, { redirect_uri: REDIRECT + '&extra=true' }, { client_id: 'https://evil.test/client.json' }];
  for (const values of invalidRequests) {
    const flow = await f.authorize(client, 'k'.repeat(43), { cookie: '' }, { scope: 'health.read', ...values });
    assert.ok(flow.response.status === 400 || flow.response.status === 401, flow.html);
    assert.equal(flow.response.headers.get('location'), null);
    assert.equal(flow.request_id, '');
  }
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', resource: f.origin + '/mcp',
    code_challenge: challenge('k'.repeat(43)), code_challenge_method: 'S256', scope: 'health.read' });
  query.append('resource', 'https://evil.test/mcp');
  await error(await f.request('/oauth/authorize?' + query), 400, 'invalid_request');
  query.delete('resource');
  await error(await f.request('/oauth/authorize?' + query), 400, 'invalid_request');
});

test('authorization-code token exchange stores only hashes and sessions cannot substitute for Bearer', async t => {
  const f = await fixture(t);
  const { client, tokens, raw } = await f.grant('health.read');
  assert.equal(tokens.token_type, 'Bearer'); assert.equal(tokens.expires_in, 3600); assert.equal(tokens.scope, 'health.read');
  assert.match(tokens.access_token, /^[A-Za-z0-9_-]{43}$/); assert.match(tokens.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  const access = f.db.prepare('SELECT * FROM auth_access_tokens').get()!;
  const refresh = f.db.prepare('SELECT * FROM auth_refresh_tokens').get()!;
  assert.equal(access.token_hash, sha(tokens.access_token)); assert.equal(refresh.token_hash, sha(tokens.refresh_token));
  assert.equal(access.resource, f.origin + '/mcp'); assert.equal(Number(refresh.expires_at) - epoch(), 30 * 86400);
  assert.equal(f.db.prepare('SELECT code_hash FROM auth_codes').get()!.code_hash, sha(raw));
  for (const table of ['auth_settings', 'auth_clients', 'auth_sessions', 'auth_pending', 'auth_codes', 'auth_grants', 'auth_access_tokens', 'auth_refresh_tokens']) {
    const dump = JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all());
    for (const secret of [PASSWORD, tokens.access_token, tokens.refresh_token, raw]) assert.ok(!dump.includes(secret), table);
  }
  const response = await f.mcp(tokens.access_token);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { scopes: ['health.read'], clientId: client.client_id });
  assert.equal((await f.mcp(tokens.access_token, '/mcp-write')).status, 403);
  await error(await f.mcp(tokens.refresh_token), 401, 'invalid_token');
  await error(await f.request('/api/v1/session', { headers: { Authorization: `Bearer ${tokens.access_token}` } }), 401, 'unauthorized');
  const browser = await f.login();
  await error(await f.request('/mcp', {}, browser), 401, 'invalid_token');
});

test('code/client/redirect/resource/PKCE/scope bindings reject negatives without consuming a valid code', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const other = await f.register();
  const pkce = randomBytes(32).toString('base64url');
  const raw = await f.code(client, pkce, 'health.read');
  await error(await f.exchange(other, raw, pkce), 400, 'invalid_grant');
  await error(await f.exchange(client, raw, 'wrong'.repeat(10)), 400, 'invalid_grant');
  await error(await f.exchange(client, raw, 'short'), 400, 'invalid_grant');
  await error(await f.exchange(client, raw, pkce, { redirect_uri: REDIRECT + '&x=1' }), 400, 'invalid_grant');
  await error(await f.exchange(client, raw, pkce, { resource: f.origin + '/mcp/' }), 400, 'invalid_target');
  await error(await f.exchange(client, raw, pkce, { scope: 'health.read health.write' }), 400, 'invalid_scope');
  await error(await f.exchange(client, raw, pkce, { client_secret: 'fake-secret' }), 401, 'invalid_client');
  const response = await f.exchange(client, raw, pkce);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const tokens = await response.json() as Tokens;
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
  await error(await f.exchange(client, raw, pkce), 400, 'invalid_grant');
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  await error(await f.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
});

test('expired codes, sessions and access tokens are rejected; stored audience and scope are checked', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const pkce = 's'.repeat(43), raw = await f.code(client, pkce);
  f.db.prepare('UPDATE auth_codes SET expires_at = ? WHERE code_hash = ?').run(epoch() - 1, sha(raw));
  await error(await f.exchange(client, raw, pkce), 400, 'invalid_grant');
  const { tokens } = await f.grant();
  const tokenHash = sha(tokens.access_token);
  f.db.prepare('UPDATE auth_access_tokens SET resource = ? WHERE token_hash = ?').run('https://elsewhere.test/mcp', tokenHash);
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  f.db.prepare('UPDATE auth_access_tokens SET resource = ?, scope = ? WHERE token_hash = ?').run(f.origin + '/mcp', 'admin', tokenHash);
  await error(await f.mcp(tokens.access_token), 403, 'insufficient_scope');
  f.db.prepare('UPDATE auth_access_tokens SET scope = ?, expires_at = ? WHERE token_hash = ?').run('health.read', epoch() - 1, tokenHash);
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  const browser = await f.login();
  f.db.prepare('UPDATE auth_sessions SET expires_at = ?').run(epoch() - 1);
  await error(await f.request('/api/v1/session', {}, browser), 401, 'unauthorized');
});

test('refresh rotates, downscopes irreversibly, invalidates prior access and detects reuse of the family', async t => {
  const f = await fixture(t);
  const { client, tokens } = await f.grant();
  await error(await f.refresh(client, tokens.refresh_token, { resource: f.origin + '/other' }), 400, 'invalid_target');
  await error(await f.refresh(client, tokens.refresh_token, { scope: 'admin' }), 400, 'invalid_scope');
  const other = await f.register();
  await error(await f.refresh(other, tokens.refresh_token), 400, 'invalid_grant');
  const response = await f.refresh(client, tokens.refresh_token, { scope: 'health.read' });
  assert.equal(response.status, 200);
  const rotated = await response.json() as Tokens;
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal(rotated.scope, 'health.read');
  assert.equal(f.db.prepare('SELECT count(DISTINCT expires_at) AS n FROM auth_refresh_tokens').get()!.n, 1);
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  assert.equal((await f.mcp(rotated.access_token)).status, 200);
  await error(await f.refresh(client, rotated.refresh_token, { scope: 'health.read health.write' }), 400, 'invalid_scope');
  await error(await f.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
  await error(await f.mcp(rotated.access_token), 401, 'invalid_token');
  await error(await f.refresh(client, rotated.refresh_token), 400, 'invalid_grant');
});

test('refresh expiry is enforced and a client without a refresh grant receives no refresh token', async t => {
  const f = await fixture(t);
  const { client, tokens } = await f.grant();
  f.db.prepare('UPDATE auth_refresh_tokens SET expires_at = ?').run(epoch() - 1);
  await error(await f.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
  const short = await f.register({ grant_types: ['authorization_code'] });
  const raw = await f.code(short, 'k'.repeat(43));
  const response = await f.exchange(short, raw, 'k'.repeat(43));
  assert.equal(response.status, 200); assert.equal((await response.json()).refresh_token, undefined);
  await error(await f.refresh(short, 'fake'), 400, 'unauthorized_client');
});

test('revocation is idempotent, client-bound and revokes the full access/refresh grant', async t => {
  const f = await fixture(t);
  const { client, tokens } = await f.grant();
  const other = await f.register();
  assert.equal((await f.form('/oauth/revoke', { client_id: other.client_id, token: tokens.refresh_token })).status, 200);
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
  for (const token of [tokens.access_token, tokens.refresh_token, 'unknown-token']) {
    assert.equal((await f.form('/oauth/revoke', { client_id: client.client_id, token })).status, 200);
  }
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  await error(await f.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
});

test('persistent per-peer limits reject login and registration floods despite spoofed X-Forwarded-For', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.json('/api/v1/login', { password: 'wrong' }, undefined, { 'X-Forwarded-For': `10.0.0.${i}` })).status, 401);
  const limited = await f.json('/api/v1/login', { password: PASSWORD });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  for (let i = 0; i < 20; i++) assert.equal((await f.json('/oauth/register', { redirect_uris: [REDIRECT] }, undefined, { 'X-Forwarded-For': `10.1.0.${i}` })).status, 201);
  assert.equal((await f.json('/oauth/register', { redirect_uris: [REDIRECT] })).status, 429);
  f.db.prepare('UPDATE auth_rate_limits SET reset_at = ?').run(epoch() - 1);
  assert.equal((await f.json('/api/v1/login', { password: PASSWORD })).status, 200);
});

test('clients, sessions, tokens and used-refresh detection survive a real SQLite close/reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boji-auth-'));
  const file = join(dir, 'auth.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await fixture(t, { file, publicUrl: 'http://localhost:3000' });
  const browser = await first.login();
  const { client, tokens } = await first.grant();
  const rotated = await (await first.refresh(client, tokens.refresh_token)).json() as Tokens;
  const verifierBefore = first.db.prepare('SELECT password_verifier FROM auth_settings').get()!.password_verifier;
  await first.close();
  const second = await fixture(t, { file, publicUrl: 'http://localhost:3000' });
  assert.equal(second.db.prepare('SELECT password_verifier FROM auth_settings').get()!.password_verifier, verifierBefore);
  assert.equal(second.db.prepare('SELECT count(*) AS n FROM auth_clients').get()!.n, 1);
  assert.equal((await second.request('/api/v1/session', {}, browser)).status, 200);
  assert.equal((await second.mcp(rotated.access_token)).status, 200);
  await error(await second.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
  await error(await second.mcp(rotated.access_token), 401, 'invalid_token');
  await second.close();
});

test('password changes invalidate previous sessions/grants while preserving registered clients', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boji-auth-config-'));
  const file = join(dir, 'auth.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = await fixture(t, { file, publicUrl: 'http://localhost:3000' });
  const browser = await first.login();
  const { tokens } = await first.grant();
  await first.close();
  const second = await fixture(t, { file, publicUrl: 'http://localhost:3000', password: 'a-new-long-password-6789!' });
  await error(await second.request('/api/v1/session', {}, browser), 401, 'unauthorized');
  await error(await second.mcp(tokens.access_token), 401, 'invalid_token');
  assert.equal(second.db.prepare('SELECT count(*) AS n FROM auth_clients').get()!.n, 1);
  const secondBrowser: Browser = { cookie: '' };
  assert.equal((await second.json('/api/v1/login', { password: 'a-new-long-password-6789!' }, secondBrowser)).status, 200);
  await second.close();
  // An explicit password reset still revokes sessions even when the public origin also changes.
  const third = await fixture(t, { file, publicUrl: 'https://boji.example.org', password: 'another-new-password-7890!' });
  assert.equal(third.db.prepare('SELECT count(*) AS n FROM auth_sessions').get()!.n, 0);
  assert.equal(third.db.prepare('SELECT count(*) AS n FROM auth_clients').get()!.n, 1);
  await third.close();
});

test('public URL migration preserves existing sessions, pending consent, codes and grants with explicit aliases', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'boji-auth-domain-'));
  const file = join(dir, 'auth.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldOrigin = 'https://legacy-boji.example.org', newOrigin = 'https://boji.example.org';
  const first = await fixture(t, { file, publicUrl: oldOrigin });
  const browser = await first.login();
  const { client, tokens } = await first.grant();
  const pendingVerifier = 'p'.repeat(43), codeVerifier = 'c'.repeat(43);
  const pending = await first.authorize(client, pendingVerifier, browser);
  assert.equal(pending.response.status, 200);
  const unexchanged = await first.code(client, codeVerifier);
  const tables = ['auth_clients', 'auth_sessions', 'auth_pending', 'auth_codes', 'auth_grants', 'auth_access_tokens', 'auth_refresh_tokens'];
  const snapshots = tables.map(table => first.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const passwordVerifier = first.db.prepare('SELECT password_verifier FROM auth_settings').get()!.password_verifier;
  await first.close();

  const unchanged = new DatabaseSync(file);
  try {
    assert.throws(() => createAuth(express(), unchanged, { publicUrl: newOrigin, adminPassword: PASSWORD }), /previous issuer.*ALIASES/);
    assert.equal(unchanged.prepare('SELECT issuer FROM auth_settings').get()!.issuer, oldOrigin);
    for (const [index, table] of tables.entries()) assert.deepEqual(unchanged.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), snapshots[index]);
  } finally { unchanged.close(); }
  const second = await fixture(t, { file, publicUrl: newOrigin, publicUrlAliases: [oldOrigin] });
  for (const [index, table] of tables.entries()) {
    assert.deepEqual(second.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), snapshots[index], table);
  }
  assert.equal(second.db.prepare('SELECT password_verifier FROM auth_settings').get()!.password_verifier, passwordVerifier);
  const oldHeaders = { Host: new URL(oldOrigin).host, Origin: oldOrigin };
  assert.equal((await second.request('/api/v1/session', { headers: oldHeaders }, browser)).status, 200);
  assert.equal((await second.json('/api/v1/private', {}, browser, { ...oldHeaders, 'X-CSRF-Token': browser.csrf! })).status, 200);
  await error(await second.json('/api/v1/private', {}, browser, { Origin: oldOrigin, 'X-CSRF-Token': browser.csrf! }), 403, 'invalid_origin');
  assert.equal((await second.mcp(tokens.access_token)).status, 200);

  for (const origin of [oldOrigin, newOrigin]) {
    const headers = { Host: new URL(origin).host };
    const metadata = await (await second.request('/.well-known/oauth-authorization-server', { headers })).json();
    assert.equal(metadata.issuer, origin);
    assert.equal(metadata.token_endpoint, origin + '/oauth/token');
    const resource = await (await second.request('/.well-known/oauth-protected-resource/mcp', { headers })).json();
    assert.equal(resource.resource, origin + '/mcp');
    assert.deepEqual(resource.authorization_servers, [origin]);
    const unauthorized = await second.request('/mcp', { headers });
    assert.match(unauthorized.headers.get('www-authenticate')!, new RegExp(origin.replaceAll('.', '\\.') + '/\\.well-known/oauth-protected-resource/mcp'));
  }
  const approved = await second.form('/oauth/authorize', { request_id: pending.request_id, csrf_token: pending.csrf_token, decision: 'approve' }, browser, oldHeaders);
  assert.equal(approved.status, 303);
  const callback = new URL(approved.headers.get('location')!);
  assert.equal(callback.searchParams.get('iss'), oldOrigin);
  assert.equal((await second.exchange(client, callback.searchParams.get('code')!, pendingVerifier, { resource: oldOrigin + '/mcp' })).status, 200);
  assert.equal((await second.exchange(client, unexchanged, codeVerifier, { resource: oldOrigin + '/mcp' })).status, 200);

  // Aliases do not permit retargeting a previously granted resource or consuming its refresh token.
  await error(await second.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
  const refreshed = await second.refresh(client, tokens.refresh_token, { resource: oldOrigin + '/mcp' });
  assert.equal(refreshed.status, 200);
  const renewed = await refreshed.json() as Tokens;
  assert.equal((await second.mcp(renewed.access_token)).status, 200);
  assert.equal(second.db.prepare('SELECT resource FROM auth_access_tokens WHERE token_hash = ?').get(sha(renewed.access_token))!.resource, oldOrigin + '/mcp');
  const mixedOrigin = await second.authorize(client, 'm'.repeat(43), { cookie: '' }, { resource: oldOrigin + '/mcp' });
  assert.equal(mixedOrigin.response.status, 400);
  const newGrant = await second.grant();
  assert.equal(second.db.prepare('SELECT resource FROM auth_access_tokens WHERE token_hash = ?').get(sha(newGrant.tokens.access_token))!.resource, newOrigin + '/mcp');
  await error(await second.refresh(client, renewed.refresh_token, { resource: 'https://evil.test/mcp' }), 400, 'invalid_target');
  await second.close();

  // Removing an alias disables its resources without destroying retained authorization records.
  const third = await fixture(t, { file, publicUrl: newOrigin });
  assert.ok(Number(third.db.prepare('SELECT count(*) AS n FROM auth_grants WHERE resource = ?').get(oldOrigin + '/mcp')!.n) > 0);
  await error(await third.mcp(renewed.access_token), 401, 'invalid_token');
  assert.equal((await third.mcp(newGrant.tokens.access_token)).status, 200);
  await third.close();
});

test('invalid public origin aliases fail before changing stored authorization data', async t => {
  const f = await fixture(t, { publicUrl: 'https://boji.example.org' });
  const { tokens } = await f.grant();
  for (const alias of ['https://*.example.com', 'https://user:pw@example.com', 'https://example.com/path', 'http://localhost:3000']) {
    assert.throws(() => createAuth(express(), f.db, { publicUrl: f.origin, publicUrlAliases: [alias], adminPassword: PASSWORD }), /PUBLIC_URL/);
    assert.equal((await f.mcp(tokens.access_token)).status, 200);
  }
});

test('concurrent consent/code/refresh requests cannot create independent replayable grants', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const browser: Browser = { cookie: '' };
  const pkce = 'z'.repeat(43);
  const flow = await f.authorize(client, pkce, browser);
  const cookie = browser.cookie;
  const responses = await Promise.all([f.consent(flow, { cookie }), f.consent(flow, { cookie })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 400]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, 1);
  const raw = new URL(responses.find(response => response.status === 303)!.headers.get('location')!).searchParams.get('code')!;
  const exchange = await Promise.all([f.exchange(client, raw, pkce), f.exchange(client, raw, pkce)]);
  assert.deepEqual(exchange.map(response => response.status).sort(), [200, 400]);
  const issued = await exchange.find(response => response.status === 200)!.json() as Tokens;
  await error(await f.mcp(issued.access_token), 401, 'invalid_token');
  const { client: fresh, tokens } = await f.grant();
  const refreshed = await Promise.all([f.refresh(fresh, tokens.refresh_token), f.refresh(fresh, tokens.refresh_token)]);
  assert.deepEqual(refreshed.map(response => response.status).sort(), [200, 400]);
  const rotated = await refreshed.find(response => response.status === 200)!.json() as Tokens;
  await error(await f.mcp(rotated.access_token), 401, 'invalid_token');
});


test('token endpoint rejects missing/duplicate parameters, unsupported grants and malformed requests', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const pkce = 'k'.repeat(43), raw = await f.code(client, pkce);
  const body = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: REDIRECT,
    resource: f.origin + '/mcp', code: raw, code_verifier: pkce };
  for (const key of Object.keys(body)) {
    const missing: Record<string, string> = { ...body };
    delete missing[key];
    const response = await f.form('/oauth/token', missing);
    assert.equal(response.status, 400, key);
    assert.equal(response.headers.get('location'), null);
  }
  await error(await f.form('/oauth/token', { ...body, grant_type: 'password' }), 400, 'unsupported_grant_type');
  await error(await f.form('/oauth/token', { ...body, client_id: 'unknown' }), 401, 'invalid_client');
  await error(await f.json('/oauth/token', body), 400, 'invalid_request');
  const repeated = new URLSearchParams(body); repeated.append('code_verifier', 'x'.repeat(43));
  await error(await f.request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: repeated }), 400, 'invalid_request');
  await error(await f.form('/oauth/token', body, undefined, { Authorization: 'Basic fake' }), 401, 'invalid_client');
  assert.equal((await f.exchange(client, raw, pkce)).status, 200);
});

test('grant expiration, client deletion, grant/token scope mismatch and wrong client binding reject MCP access', async t => {
  const f = await fixture(t);
  const { client, tokens } = await f.grant('health.read');
  const tokenHash = sha(tokens.access_token);
  f.db.prepare('UPDATE auth_access_tokens SET scope = ? WHERE token_hash = ?').run('health.write', tokenHash);
  await error(await f.mcp(tokens.access_token), 403, 'insufficient_scope');
  f.db.prepare('UPDATE auth_access_tokens SET scope = ? WHERE token_hash = ?').run('health.read', tokenHash);
  f.db.prepare('UPDATE auth_grants SET client_id = ?').run('other-client');
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  f.db.prepare('UPDATE auth_grants SET client_id = ?, expires_at = ?').run(client.client_id, epoch() - 1);
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  await error(await f.refresh(client, tokens.refresh_token), 400, 'invalid_grant');
  f.db.prepare('UPDATE auth_grants SET expires_at = ?').run(epoch() + 3600);
  f.db.prepare('DELETE FROM auth_clients WHERE client_id = ?').run(client.client_id);
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
});

test('anonymous consent cannot mint tokens without a password; expired/malformed cookies fail closed', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const browser: Browser = { cookie: '' };
  const flow = await f.authorize(client, 'x'.repeat(43), browser);
  const attempt = await f.form('/oauth/authorize', { request_id: flow.request_id, csrf_token: flow.csrf_token, decision: 'approve' }, browser);
  assert.equal(attempt.status, 401);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, 0);
  for (const cookie of ['boji_session=%broken', browser.cookie + '; ' + browser.cookie, 'boji_session=' + 'a'.repeat(43)]) {
    assert.equal((await f.request('/api/v1/session', {}, { cookie })).status, 401);
  }
  f.db.prepare('UPDATE auth_sessions SET expires_at = ?').run(epoch() - 1);
  await error(await f.consent(flow, browser), 403, 'invalid_csrf');
});

test('the consent password form shares persistent login throttling with API login', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const browser: Browser = { cookie: '' };
  const flow = await f.authorize(client, 'x'.repeat(43), browser);
  for (let i = 0; i < 10; i++) assert.equal((await f.consent(flow, browser, { password: 'wrong' })).status, 401);
  assert.equal((await f.consent(flow, browser)).status, 429);
  assert.equal((await f.json('/api/v1/login', { password: PASSWORD })).status, 429);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, 0);
});


test('real Chromium form login preserves Origin and permits only the registered cross-origin callback', async t => {
  const { chromium } = await import('@playwright/test');
  const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() :
    process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ?
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined;
  if (!executablePath) { t.skip('Install Playwright Chromium to run real browser OAuth coverage'); return; }
  const f = await fixture(t);
  const callback = createServer((_req, res) => { res.end('OAuth callback received'); });
  await new Promise<void>(resolve => callback.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => callback.close(error => error ? reject(error) : resolve())));
  const address = callback.address();
  assert.ok(address && typeof address === 'object');
  const redirect = `http://127.0.0.1:${address.port}/callback`;
  const client = await f.register({ redirect_uris: [redirect] });
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const pkce = randomBytes(32).toString('base64url');
  await page.goto(f.base + '/oauth/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
    response_type: 'code', resource: f.origin + '/mcp', scope: 'health.read', state: 'browser-state',
    code_challenge: challenge(pkce), code_challenge_method: 'S256' }));
  // Simulate an embedded browser losing its session after rendering the form.
  await browser.contexts()[0]!.clearCookies();
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.getByRole('button', { name: '登录并同意授权' }).click();
  await page.getByRole('heading', { name: '授权页面已失效' }).waitFor();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, 0);
  await page.getByRole('link', { name: '重新打开授权页面' }).click();
  await page.locator('input[name=password]').fill(PASSWORD);
  const post = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/oauth/authorize');
  await page.getByRole('button', { name: '登录并同意授权' }).click();
  assert.equal((await post).headers().origin, f.origin);
  await page.waitForURL(url => url.origin === new URL(redirect).origin, { timeout: 5000 });
  const target = new URL(page.url());
  assert.equal(target.searchParams.get('state'), 'browser-state');
  assert.equal(target.searchParams.get('iss'), f.origin);
  assert.ok(target.searchParams.get('code'));
  assert.equal((await f.exchange(client, target.searchParams.get('code')!, pkce)).status, 200);
  assert.equal(await page.locator('body').textContent(), 'OAuth callback received');
  await browser.close();
});


test('omitted authorization scope offers registered permissions, while explicit read-only consent stays read-only', async t => {
  const f = await fixture(t);
  for (const registeredScope of ['health.read health.write', 'health.read']) {
    const client = await f.register({ scope: registeredScope });
    const pkce = randomBytes(32).toString('base64url');
    const browser: Browser = { cookie: '' };
    const flow = await f.authorize(client, pkce, browser, { scope: undefined });
    assert.equal(flow.response.status, 200, flow.html);
    assert.match(flow.html, new RegExp('请求权限：' + registeredScope));
    const approved = await f.consent(flow, browser);
    assert.equal(approved.status, 303);
    const raw = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const response = await f.exchange(client, raw, pkce);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scope, registeredScope);
  }
  const { tokens } = await f.grant('health.read');
  assert.equal(tokens.scope, 'health.read');
  assert.equal((await f.mcp(tokens.access_token)).status, 200);
  assert.equal((await f.mcp(tokens.access_token, '/mcp-write')).status, 403);
});


test('authentication diagnostics distinguish expiry and revocation without exposing credentials', async t => {
  const events: string[] = [];
  t.mock.method(console, 'info', (line: string) => { events.push(line); });
  const f = await fixture(t);
  await f.request('/mcp');
  const { client, pkce, raw, tokens } = await f.grant('health.read');
  f.db.prepare('UPDATE auth_access_tokens SET expires_at = ?').run(epoch() - 1);
  const expired = await f.mcp(tokens.access_token);
  await error(expired, 401, 'invalid_token');
  assert.match(expired.headers.get('www-authenticate')!, /error="invalid_token"/);
  assert.match(expired.headers.get('www-authenticate')!, /error_description="[^"]+"/);
  f.db.prepare('UPDATE auth_grants SET revoked_at = ?').run(epoch());
  await error(await f.mcp(tokens.access_token), 401, 'invalid_token');
  await error(await f.form('/oauth/token', { grant_type: 'unsupported-sensitive-value', client_id: client.client_id, resource: f.origin + '/mcp' }), 400, 'unsupported_grant_type');
  const logs = events.join('\n');
  for (const sensitive of [PASSWORD, client.client_id, pkce, raw, tokens.access_token, tokens.refresh_token, 'unsupported-sensitive-value']) {
    assert.ok(!logs.includes(sensitive), 'auth logs must omit credentials and request payloads');
  }
  const parsed = events.map(line => JSON.parse(line));
  assert.ok(parsed.some(event => event.reason === 'missing_bearer'));
  assert.ok(parsed.some(event => event.reason === 'access_token_expired'));
  assert.ok(parsed.some(event => event.reason === 'grant_revoked'));
  assert.ok(parsed.some(event => event.action === 'oauth_rejected' && event.error === 'unsupported_grant_type'));
});

test('new consent never relies on a nearly expired browser session or silently extends login', async t => {
  const f = await fixture(t);
  const client = await f.register();
  for (const authenticated of [false, true]) {
    const browser = authenticated ? await f.login() : { cookie: '' };
    if (!authenticated) await f.authorize(client, 'x'.repeat(43), browser);
    const oldCookie = browser.cookie;
    f.db.prepare('UPDATE auth_sessions SET expires_at = ?').run(epoch() + 5);
    const flow = await f.authorize(client, 'x'.repeat(43), browser);
    if (authenticated) assert.notEqual(browser.cookie, oldCookie);
    else assert.equal(browser.cookie, oldCookie);
    assert.match(flow.html, /name="password"/);
    const pending = f.db.prepare('SELECT * FROM auth_pending WHERE request_hash = ?').get(sha(flow.request_id))!;
    const session = f.db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(pending.session_hash)!;
    assert.ok(Number(session.expires_at) >= Number(pending.expires_at));
    assert.equal((await f.consent(flow, browser)).status, 303);
  }
});

test('HTML consent recovers missing, expired and replaced cookies without approving the stale POST', async t => {
  const f = await fixture(t);
  const client = await f.register();
  for (const scenario of ['missing', 'expired', 'replaced', 'cleaned']) {
    const browser: Browser = { cookie: '' };
    const pkce = randomBytes(32).toString('base64url');
    const flow = await f.authorize(client, pkce, browser, { scope: 'health.read' });
    const action = flow.html.match(/action="([^"]+)"/)![1]!.replaceAll('&amp;', '&');
    if (scenario === 'missing') browser.cookie = '';
    if (scenario === 'expired') f.db.prepare('UPDATE auth_sessions SET expires_at = ?').run(epoch() - 1);
    if (scenario === 'replaced') await f.login(browser);
    if (scenario === 'cleaned') { f.db.exec('DELETE FROM auth_pending; DELETE FROM auth_sessions'); }
    const before = f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n;
    const rejected = await f.form(action, { request_id: flow.request_id, csrf_token: flow.csrf_token,
      password: PASSWORD, decision: 'approve' }, browser, { Accept: 'text/html' });
    assert.equal(rejected.status, 403);
    assert.match(rejected.headers.get('cache-control')!, /no-store/);
    assert.equal(rejected.headers.get('referrer-policy'), 'no-referrer');
    const html = await rejected.text();
    assert.match(html, /重新打开授权页面/);
    assert.ok(!html.includes(PASSWORD));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_codes').get()!.n, before);
    const retry = html.match(/href="([^"]+)"/)![1]!.replaceAll('&amp;', '&');
    assert.equal(retry, action);
    const reopened = await f.request(retry, {}, browser);
    assert.equal(reopened.status, 200);
    const page = await reopened.text();
    const approved = await f.form(retry, { request_id: page.match(/name="request_id" value="([^"]+)"/)![1]!,
      csrf_token: page.match(/name="csrf_token" value="([^"]+)"/)![1]!, password: PASSWORD, decision: 'approve' }, browser);
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get('location')!);
    assert.equal(callback.searchParams.get('state'), 'opaque-state+&/123');
    const tokens = await f.exchange(client, callback.searchParams.get('code')!, pkce);
    assert.equal(tokens.status, 200);
    assert.equal((await tokens.json()).scope, 'health.read');
  }
});

test('consent recovery supports old forms, rejects tampered restart parameters and gives fallback after cleanup', async t => {
  const f = await fixture(t);
  const client = await f.register();
  const flow = await f.authorize(client, 'x'.repeat(43), { cookie: '' });
  const body = { request_id: flow.request_id, csrf_token: flow.csrf_token, decision: 'approve' };
  const old = await f.form('/oauth/authorize', body, undefined, { Accept: 'text/html' });
  assert.match(await old.text(), /重新打开授权页面/);
  const action = flow.html.match(/action="([^"]+)"/)![1]!.replaceAll('&amp;', '&');
  const tampered = new URL(action, f.origin);
  tampered.searchParams.set('redirect_uri', 'https://evil.test/');
  const bad = await f.form(tampered.pathname + tampered.search, body, undefined, { Accept: 'text/html' });
  assert.ok(!(await bad.text()).includes('href='));
  f.db.exec('DELETE FROM auth_pending');
  const gone = await f.form('/oauth/authorize', body, undefined, { Accept: 'text/html' });
  assert.match(await gone.text(), /回到客户端重新点击/);
});
