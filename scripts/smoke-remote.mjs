// Health-data reads only, including when --read-only is supplied for production.
// OAuth registration, consent, refresh and cleanup affect only this script's client/session.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const expectedTools = new Map([
  ['boji_get_context', 'health.read'],
  ['boji_record_meal', 'health.write'],
  ['boji_get_meal', 'health.read'],
  ['boji_list_meals', 'health.read'],
  ['boji_update_meal', 'health.write'],
  ['boji_delete_meal', 'health.write'],
  ['boji_restore_meal', 'health.write'],
  ['boji_get_summary', 'health.read'],
  ['boji_get_source_status', 'health.read'],
  ['boji_get_trends', 'health.read'],
  ['boji_search_food_library', 'health.read'],
  ['boji_get_food_library_item', 'health.read'],
  ['boji_record_food_library_item', 'health.write'],
  ['boji_update_food_library_item', 'health.write'],
  ['boji_delete_food_library_item', 'health.write'],
  ['boji_restore_food_library_item', 'health.write'],
]);
const check = condition => { if (!condition) throw new Error('verification failed'); };
const scopeList = scope => typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean).sort() : [];
const expectedScopes = ['health.read', 'health.write'];
const jsonPost = (body, headers = {}) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const formPost = body => ({
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
});

let stage = 'arguments', client, cookie, csrf, clientId, base, get, result, exchangeBody;
const revokeTokens = new Set();
const cleanupFailures = [];
// Capture credentials before validation so malformed replies still permit best-effort revocation.
function rememberTokens(tokens) {
  for (const value of [tokens?.access_token, tokens?.refresh_token]) {
    if (typeof value === 'string' && value) revokeTokens.add(value);
  }
  return tokens;
}
function checkTokens(tokens, requestedScope) {
  check(typeof tokens?.access_token === 'string' && tokens.access_token.length > 0);
  check(typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0);
  check(tokens.token_type === 'Bearer' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0);
  check(isDeepStrictEqual(scopeList(tokens.scope), scopeList(requestedScope)));
}
async function cleanup(name, action) {
  try { await action(); } catch { cleanupFailures.push(name); }
}

try {
  const args = process.argv.slice(2);
  check(args.every(arg => !arg.startsWith('--') || arg === '--read-only'));
  const positional = args.filter(arg => arg !== '--read-only');
  check(positional.length >= 1 && positional.length <= 2);
  const url = new URL(positional[0]);
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password);
  check(url.pathname === '/' && !url.search && !url.hash);
  base = url.origin;
  const resource = base + '/mcp';
  // Never print the environment file or errors that might embed its contents/path.
  stage = 'credential';
  const env = readFileSync(positional[1] ?? '.env', 'utf8');
  const password = env.match(/^BOJI_ADMIN_PASSWORD=(.+)$/m)?.[1]?.trim();
  check(password);
  const boundedFetch = (input, options = {}) => fetch(input, {
    ...options, redirect: 'manual',
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  get = (path, options = {}) => boundedFetch(base + path, options);

  stage = 'health';
  const health = await get('/healthz');
  check(health.ok);
  stage = 'anonymous_mcp';
  const denied = await get('/mcp', jsonPost({}));
  check(denied.status === 401);
  const challenge = denied.headers.get('www-authenticate');
  check(challenge && /^Bearer\s/i.test(challenge));
  const requestedScope = challenge.match(/(?:^|[,\s])scope="([^"]+)"/i)?.[1];
  check(isDeepStrictEqual(scopeList(requestedScope), expectedScopes));
  stage = 'anonymous_api';
  const deniedWeb = await get('/api/v1/meals');
  check(deniedWeb.status === 401);

  stage = 'login';
  const login = await get('/api/v1/login', jsonPost({ password }, { Origin: base }));
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  check(login.ok && cookie);
  const loginCsrf = (await login.json()).csrf_token;
  check(typeof loginCsrf === 'string' && loginCsrf.length > 0);
  csrf = loginCsrf;
  stage = 'registration';
  const reg = await get('/oauth/register', jsonPost({
    client_name: 'Boji deployment verification', redirect_uris: ['https://client.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', scope: requestedScope,
  }));
  check(reg.ok);
  clientId = (await reg.json()).client_id;
  check(typeof clientId === 'string' && clientId.length > 0);
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(24).toString('base64url');
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: 'https://client.example/callback', response_type: 'code',
    scope: requestedScope, resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state,
  });
  stage = 'consent';
  const consent = await get('/oauth/authorize?' + q, { headers: { Cookie: cookie } });
  check(consent.ok);
  const request = (await consent.text()).match(/name="request_id" value="([^"]+)"/)?.[1];
  check(request);
  const approved = await get('/oauth/authorize', {
    ...formPost({ request_id: request, csrf_token: csrf, decision: 'approve' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: base },
  });
  check(approved.status === 303);
  const redirect = new URL(approved.headers.get('location'));
  check(redirect.origin + redirect.pathname === 'https://client.example/callback');
  check(redirect.searchParams.get('iss') === base && redirect.searchParams.get('state') === state);
  const code = redirect.searchParams.get('code');
  check(code && !redirect.searchParams.has('error'));
  stage = 'code_exchange';
  exchangeBody = {
    client_id: clientId, grant_type: 'authorization_code', code,
    redirect_uri: 'https://client.example/callback', code_verifier: verifier, resource,
  };
  const issued = await get('/oauth/token', formPost(exchangeBody));
  const token = rememberTokens(await issued.json());
  check(issued.ok);
  checkTokens(token, requestedScope);

  stage = 'refresh_rotation';
  // Rotate explicitly without expiring tokens or altering the production database.
  const refreshed = await get('/oauth/token', formPost({
    client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token,
    resource, scope: requestedScope,
  }));
  const renewed = rememberTokens(await refreshed.json());
  check(refreshed.ok);
  checkTokens(renewed, requestedScope);
  check(renewed.refresh_token !== token.refresh_token && renewed.access_token !== token.access_token);
  // Do not replay the consumed refresh token: reuse correctly revokes this entire grant.

  stage = 'mcp_connect';
  client = new Client({ name: 'Boji release verification', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { Authorization: 'Bearer ' + renewed.access_token } }, fetch: boundedFetch,
  });
  await client.connect(transport);
  stage = 'wire_tools';
  // SDK schemas may strip extensions; inspect the actual tools/list network JSON too.
  const listed = await get('/mcp', jsonPost({ jsonrpc: '2.0', id: 'permissions', method: 'tools/list' }, {
    Authorization: 'Bearer ' + renewed.access_token, Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': transport.protocolVersion,
    ...(transport.sessionId ? { 'Mcp-Session-Id': transport.sessionId } : {}),
  }));
  check(listed.ok);
  const wire = await listed.json();
  check(wire.jsonrpc === '2.0' && wire.id === 'permissions' && !wire.error);
  const wireTools = wire.result?.tools;
  check(Array.isArray(wireTools) && wireTools.length === expectedTools.size);
  check(new Set(wireTools.map(tool => tool.name)).size === expectedTools.size);
  for (const tool of wireTools) {
    const scope = expectedTools.get(tool.name);
    check(scope);
    const required = [{ type: 'oauth2', scopes: [scope] }];
    check(isDeepStrictEqual(tool.securitySchemes, required));
    check(isDeepStrictEqual(tool._meta?.securitySchemes, required));
    check(tool.annotations?.readOnlyHint === (scope === 'health.read'));
  }
  stage = 'sdk_tools';
  const tools = await client.listTools();
  check(tools.tools.length === expectedTools.size);
  check(isDeepStrictEqual(tools.tools.map(tool => tool.name).sort(), [...expectedTools.keys()].sort()));
  stage = 'sdk_context';
  const ctx = await client.callTool({ name: 'boji_get_context', arguments: {} });
  check(!ctx.isError && typeof ctx.structuredContent?.timezone === 'string');
  stage = 'sdk_list';
  const meals = await client.callTool({ name: 'boji_list_meals', arguments: { limit: 1 } });
  check(!meals.isError && Number.isSafeInteger(meals.structuredContent?.total) && meals.structuredContent.total >= 0);
  check(Array.isArray(meals.structuredContent.items) && meals.structuredContent.items.length <= 1);
  stage = 'sdk_food_library';
  const foods = await client.callTool({ name: 'boji_search_food_library', arguments: { limit: 1 } });
  check(!foods.isError && Array.isArray(foods.structuredContent?.items));
  result = {
    food_library_search: true, health: true, anonymous_api: deniedWeb.status, anonymous_mcp: denied.status,
    oauth_code_exchange: true, refresh_rotation: true, authorization_scopes_verified: true,
    wire_security_schemes: true, mcp_tools: tools.tools.length, context: true,
    total_meals: meals.structuredContent.total, read_only: true,
  };
} catch {
  // SDK/HTTP exceptions can contain response bodies or credentials. Report only a fixed stage.
  result = { ok: false, stage, read_only: true };
  process.exitCode = 1;
} finally {
  if (client) await cleanup('mcp_close', () => client.close());
  if (exchangeBody && !revokeTokens.size) await cleanup('grant_recovery', async () => {
    // A lost exchange response may hide an issued grant. Reusing this script's code
    // revokes its consumed grant; if the first request never arrived, obtain handles to revoke.
    const recovered = await get('/oauth/token', formPost(exchangeBody));
    const body = rememberTokens(await recovered.json());
    check((recovered.ok && revokeTokens.size > 0) || (recovered.status === 400 && body.error === 'invalid_grant'));
  });
  if (clientId && revokeTokens.size) {
    await cleanup('grant_revoke', async () => {
      // New refresh token first; older tokens remain fallback handles for the same grant.
      let revoked = false;
      for (const token of [...revokeTokens].reverse()) {
        try {
          const response = await get('/oauth/revoke', formPost({ client_id: clientId, token }));
          if (response.ok) { revoked = true; break; }
        } catch { /* Continue cleanup with another token from this script's grant. */ }
      }
      check(revoked);
    });
  }
  if (cookie) await cleanup('logout', async () => {
    // Recover CSRF if login succeeded but its JSON body failed to arrive/validate.
    if (!csrf) {
      const session = await get('/api/v1/session', { headers: { Cookie: cookie } });
      check(session.ok);
      csrf = (await session.json()).csrf_token;
      check(typeof csrf === 'string' && csrf.length > 0);
    }
    const logout = await get('/api/v1/logout', jsonPost({}, { Cookie: cookie, Origin: base, 'X-CSRF-Token': csrf }));
    check(logout.ok);
  });
  if (cleanupFailures.length) process.exitCode = 1;
}
console.log(JSON.stringify({ ...result, ok: process.exitCode !== 1, cleanup: cleanupFailures.length ? 'failed' : 'complete', cleanup_failures: cleanupFailures }));
