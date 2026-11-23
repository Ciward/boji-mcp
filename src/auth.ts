import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, RequestHandler, Response } from 'express';
import { publicOrigins } from './config.js';

const SCOPES = ['health.read', 'health.write'];
const HOUR = 3_600;
const DAY = 24 * HOUR;
const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const loopback = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

/** Shared HTTP and tool-result challenge; all values come from validated server policy. */
export function mcpChallenge(resourceMetadata: string, requiredScopes: readonly string[], error?: 'invalid_token' | 'insufficient_scope'): string {
  const challenge = `Bearer resource_metadata="${resourceMetadata}", scope="${[...new Set(requiredScopes)].join(' ')}"`;
  // RFC 6750: an initial discovery request without credentials is not an invalid token.
  if (!error) return challenge;
  const description = error === 'insufficient_scope' ? 'Additional Boji health permission is required' : 'A valid Boji health connection is required';
  return `${challenge}, error="${error}", error_description="${description}"`;
}

type Fields = Record<string, unknown>;
type Client = { client_id: string; client_name: string; redirect_uris: string; scope: string; grant_types: string };
type Session = { token_hash: string; expires_at: number; authenticated: number; csrfToken: string };
type Pending = {
  request_hash: string; session_hash: string; client_id: string; redirect_uri: string;
  scope: string; resource: string; code_challenge: string; state: string | null; expires_at: number;
};
type Code = Omit<Pending, 'request_hash' | 'session_hash' | 'state'> & {
  code_hash: string; used_at: number | null; grant_id: string | null;
};
type Token = {
  token_hash: string; grant_id: string; client_id: string; scope: string; resource: string;
  expires_at: number; used_at?: number | null;
};
type Grant = { grant_id: string; client_id: string; scope: string; resource: string; expires_at: number; revoked_at: number | null };
class OAuthError extends Error {
  constructor(readonly error: string, message: string, readonly status = 400) { super(message); }
}
function field(input: Fields, key: string, required = true, limit = 2048): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    throw new OAuthError('invalid_request', `Invalid ${key}`);
  }
  return value;
}
function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OAuthError('invalid_request', 'Expected an object');
  return value as Fields;
}
function scopes(value: string): string[] {
  const result = value.split(' ');
  if (!result.length || result.some(scope => !SCOPES.includes(scope))) throw new OAuthError('invalid_scope', 'Unsupported scope');
  return [...new Set(result)];
}
function allowedScopes(value: string, allowed: string): string[] {
  const result = scopes(value);
  if (result.some(scope => !allowed.split(' ').includes(scope))) throw new OAuthError('invalid_scope', 'Scope exceeds the grant');
  return result;
}
function verifier(value: string): { salt: string; digest: string } | undefined {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(value);
  return match ? { salt: match[1]!, digest: match[2]! } : undefined;
}
function redirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OAuthError('invalid_redirect_uri', 'Invalid redirect URI'); }
  if (!/^https?:\/\//.test(value) || /[\s\\*]/.test(value) || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) || url.username || url.password || url.hash || value.includes('#') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) ||
      ['code', 'state', 'error', 'iss'].some(key => url.searchParams.has(key))) {
    throw new OAuthError('invalid_redirect_uri', 'Redirect must be HTTPS, or loopback HTTP, without credentials, fragments or wildcards');
  }
  return value; // Keep the registered spelling: OAuth redirect matching is exact.
}

/** Mount before protected business routes, after express.json / express.urlencoded. */
export function createAuth(app: Express, db: DatabaseSync, config: { publicUrl: string; publicUrlAliases?: readonly string[]; adminPassword: string }): {
  requireSession: RequestHandler; requireCsrf: RequestHandler; requireMcp: RequestHandler;
} {
  const origins = publicOrigins(config.publicUrl, config.publicUrlAliases);
  const issuer = origins[0]!;
  const resources = new Set(origins.map(origin => `${origin}/mcp`));
  const originsByHost = new Map(origins.map(origin => [new URL(origin).host, origin]));
  // Direct loopback/internal requests retain canonical discovery. Untrusted Host values
  // never become issuers; createApp additionally rejects hosts outside its explicit policy.
  const requestIssuer = (req: Request) => originsByHost.get(req.headers.host ?? '') ?? issuer;
  const requestResource = (req: Request) => `${requestIssuer(req)}/mcp`;
  const requestMetadata = (req: Request) => `${requestIssuer(req)}/.well-known/oauth-protected-resource/mcp`;
  const secure = new URL(issuer).protocol === 'https:';
  const cookieName = secure ? '__Host-boji_session' : 'boji_session';
  const password = config.adminPassword;
  const suppliedVerifier = typeof password === 'string' ? verifier(password) : undefined;
  if (typeof password !== 'string' || (!suppliedVerifier && (password.startsWith('scrypt$') || Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 1024))) {
    throw new Error('ADMIN_PASSWORD must be a secret of 16–1024 bytes or scrypt$<32 hex salt>$<128 hex digest>');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_settings (id INTEGER PRIMARY KEY CHECK(id = 1), issuer TEXT NOT NULL, password_verifier TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_clients (
      client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
      scope TEXT NOT NULL, grant_types TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, authenticated INTEGER NOT NULL CHECK(authenticated IN (0,1)), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_pending (
      request_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
      code_challenge TEXT NOT NULL, state TEXT, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      scope TEXT NOT NULL, resource TEXT NOT NULL, code_challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used_at INTEGER, grant_id TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_grants (
      grant_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_access_tokens (
      token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
      scope TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
      token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
      scope TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_rate_limits (key_hash TEXT PRIMARY KEY, reset_at INTEGER NOT NULL, attempts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS auth_access_grant ON auth_access_tokens(grant_id);
    CREATE INDEX IF NOT EXISTS auth_refresh_grant ON auth_refresh_tokens(grant_id);
    CREATE INDEX IF NOT EXISTS auth_pending_session ON auth_pending(session_hash);
  `);
  function transaction<T>(fn: () => T): T {
    db.exec('SAVEPOINT boji_auth');
    try { const result = fn(); db.exec('RELEASE boji_auth'); return result; }
    catch (error) { db.exec('ROLLBACK TO boji_auth; RELEASE boji_auth'); throw error; }
  }
  const previous = db.prepare('SELECT issuer, password_verifier FROM auth_settings WHERE id = 1').get() as
    { issuer: string; password_verifier: string } | undefined;
  const salt = suppliedVerifier?.salt ?? (previous && verifier(previous.password_verifier)?.salt) ?? randomBytes(16).toString('hex');
  const digest = suppliedVerifier?.digest ?? scryptSync(password, Buffer.from(salt, 'hex'), 64, SCRYPT).toString('hex');
  const encodedPassword = `scrypt$${salt}$${digest}`;
  if (previous && equal(previous.password_verifier, encodedPassword) && !origins.includes(previous.issuer)) {
    throw new Error('BOJI_PUBLIC_URL migration requires the previous issuer in BOJI_PUBLIC_URL_ALIASES; authorization data was preserved');
  }
  transaction(() => {
    if (previous && !equal(previous.password_verifier, encodedPassword)) {
      for (const table of ['auth_pending', 'auth_sessions', 'auth_codes', 'auth_access_tokens', 'auth_refresh_tokens', 'auth_grants']) {
        db.exec(`DELETE FROM ${table}`);
      }
    }
    db.prepare('INSERT OR REPLACE INTO auth_settings VALUES (1, ?, ?)').run(issuer, encodedPassword);
  });
  async function validPassword(value: unknown): Promise<boolean> {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || !value.length) return false;
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(value, Buffer.from(salt, 'hex'), 64, SCRYPT, (error, key) => error ? reject(error) : resolve(key));
    });
    return equal(actual.toString('hex'), digest);
  }
  const noStore = (res: Response) => res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  function fail(res: Response, error: string, description: string, status = 400): void {
    noStore(res).status(status).json({ error, error_description: description });
  }
  function endpoint(handler: (req: Request, res: Response) => void | Promise<void>): RequestHandler {
    return async (req, res, next) => {
      noStore(res);
      try { await handler(req, res); }
      catch (error) {
        if (error instanceof OAuthError) {
          console.info(JSON.stringify({ event: 'boji.auth', action: 'oauth_rejected', endpoint: req.path, error: error.error, status: error.status }));
          if (req.path === '/oauth/authorize' && req.method === 'POST' &&
              ['invalid_csrf', 'invalid_request'].includes(error.error) && req.accepts(['json', 'html']) === 'html') {
            consentRecovery(req, res, error);
          } else fail(res, error.error, error.message, error.status);
        }
        else next(error);
      }
    };
  }
  // Persistent limits apply to the immediate peer, never to untrusted forwarded headers.
  // No timers are needed; obsolete transient state is collected on incoming auth requests.
  let lastCleanup = 0;
  function rate(req: Request, res: Response, kind: string, limit: number, seconds: number, total: number): boolean {
    const timestamp = now();
    if (lastCleanup + 60 <= timestamp) {
      db.prepare('DELETE FROM auth_rate_limits WHERE reset_at <= ?').run(timestamp);
      db.prepare('DELETE FROM auth_pending WHERE expires_at <= ? OR session_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE expires_at > ?)').run(timestamp, timestamp);
      db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(timestamp);
      db.prepare('DELETE FROM auth_access_tokens WHERE expires_at <= ?').run(timestamp);
      db.prepare('DELETE FROM auth_refresh_tokens WHERE expires_at <= ?').run(timestamp);
      db.prepare('DELETE FROM auth_codes WHERE (used_at IS NULL AND expires_at <= ?) OR (used_at IS NOT NULL AND grant_id NOT IN (SELECT grant_id FROM auth_grants WHERE expires_at > ?))').run(timestamp, timestamp);
      db.prepare('DELETE FROM auth_grants WHERE expires_at <= ?').run(timestamp);
      lastCleanup = timestamp;
    }
    for (const [key, max] of [[`${kind}:global`, total], [`${kind}:${req.socket.remoteAddress ?? 'unknown'}`, limit]] as const) {
      const row = db.prepare(`INSERT INTO auth_rate_limits VALUES (?, ?, 1)
        ON CONFLICT(key_hash) DO UPDATE SET
          attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
          reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
        RETURNING attempts, reset_at`).get(hash(key), timestamp + seconds, timestamp, timestamp) as { attempts: number; reset_at: number };
      if (row.attempts > max) {
        res.set('Retry-After', String(Math.max(1, row.reset_at - timestamp)));
        fail(res, 'temporarily_unavailable', 'Too many attempts; try again later', 429);
        return false;
      }
    }
    return true;
  }
  function sameOrigin(req: Request, res: Response): boolean {
    if (req.get('Origin') !== requestIssuer(req) || ['cross-site', 'none'].includes(req.get('Sec-Fetch-Site') ?? '')) {
      fail(res, 'invalid_origin', 'A same-origin browser request is required', 403);
      return false;
    }
    return true;
  }
  function readSession(req: Request): Session | undefined {
    const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) return undefined;
    const raw = cookies[0]!.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const row = db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(hash(raw), now()) as Omit<Session, 'csrfToken'> | undefined;
    return row ? { ...row, csrfToken: hash(`boji-csrf:${raw}`) } : undefined;
  }
  function dropSession(session: Session): void {
    db.prepare('DELETE FROM auth_pending WHERE session_hash = ?').run(session.token_hash);
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(session.token_hash);
  }
  function setSession(res: Response, authenticated: boolean): Session {
    const raw = random();
    const ttl = authenticated ? 12 * HOUR : 600;
    const session: Session = { token_hash: hash(raw), authenticated: authenticated ? 1 : 0, expires_at: now() + ttl, csrfToken: hash(`boji-csrf:${raw}`) };
    db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(session.token_hash, session.authenticated, session.expires_at);
    res.cookie(cookieName, raw, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ttl * 1000 });
    return session;
  }
  function exposeSession(res: Response, session: Session): void {
    res.locals.session = { id: session.token_hash, csrfToken: session.csrfToken, expiresAt: session.expires_at };
  }
  const requireSession: RequestHandler = (req, res, next) => {
    noStore(res);
    const session = readSession(req);
    if (!session?.authenticated) { res.status(401).json({ authenticated: false, error: 'unauthorized' }); return; }
    exposeSession(res, session);
    next();
  };
  const requireCsrf: RequestHandler = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    const session = readSession(req);
    if (!session?.authenticated) { fail(res, 'unauthorized', 'A web session is required', 401); return; }
    if (!sameOrigin(req, res)) return;
    if (!equal(req.get('X-CSRF-Token') ?? '', session.csrfToken)) { fail(res, 'invalid_csrf', 'Invalid CSRF token', 403); return; }
    exposeSession(res, session);
    next();
  };
  const requireMcp: RequestHandler = (req, res, next) => {
    noStore(res);
    const challenge = (status: number, error: 'invalid_token' | 'insufficient_scope', reason: string) => {
      console.info(JSON.stringify({ event: 'boji.auth', action: 'mcp_rejected', error, reason, status }));
      res.set('WWW-Authenticate', mcpChallenge(requestMetadata(req), SCOPES, reason === 'missing_bearer' ? undefined : error));
      fail(res, error, status === 401 ? 'A valid MCP access token is required' : 'Invalid MCP scopes', status);
    };
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.get('Authorization') ?? '');
    const token = match && db.prepare('SELECT * FROM auth_access_tokens WHERE token_hash = ?').get(hash(match[1]!)) as Token | undefined;
    const grant = token && db.prepare('SELECT * FROM auth_grants WHERE grant_id = ?').get(token.grant_id) as Grant | undefined;
    const client = token && getClient(token.client_id);
    if (!token || !grant || !client) {
      const reason = !req.get('Authorization') ? 'missing_bearer' : !match ? 'malformed_bearer' : !token ? 'unknown_access_token' : 'unknown_grant_or_client';
      challenge(401, 'invalid_token', reason); return;
    }
    const timestamp = now();
    const reason = grant.revoked_at !== null ? 'grant_revoked' : grant.expires_at <= timestamp ? 'grant_expired' : token.expires_at <= timestamp ? 'access_token_expired' :
      !resources.has(token.resource) || grant.resource !== token.resource || token.client_id !== grant.client_id ? 'binding_mismatch' : undefined;
    if (reason) { challenge(401, 'invalid_token', reason); return; }
    let granted: string[];
    try { granted = allowedScopes(token.scope, grant.scope); allowedScopes(token.scope, client.scope); }
    catch { challenge(403, 'insufficient_scope', 'scope_binding_mismatch'); return; }
    res.locals.auth = { scopes: granted, clientId: token.client_id };
    next();
  };
  function getClient(id: string): Client | undefined {
    return db.prepare('SELECT * FROM auth_clients WHERE client_id = ?').get(id) as Client | undefined;
  }
  function clientFrom(body: Fields, req?: Request): Client {
    const id = field(body, 'client_id', true, 128)!;
    const client = getClient(id);
    if (!client || req?.get('Authorization') || body.client_secret !== undefined || body.client_assertion !== undefined) {
      throw new OAuthError('invalid_client', 'Unknown client or unsupported client authentication', 401);
    }
    return client;
  }
  function checkResource(body: Fields): string {
    const resource = field(body, 'resource')!;
    if (!resources.has(resource)) throw new OAuthError('invalid_target', 'Resource must exactly match a configured MCP endpoint');
    return resource;
  }
  function revoke(grantId: string): void {
    db.prepare('UPDATE auth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE grant_id = ?').run(now(), grantId);
  }
  function issue(grant: Grant, scope: string, refresh: boolean): Fields {
    const access = random();
    const expiry = Math.min(now() + HOUR, grant.expires_at);
    db.prepare('INSERT INTO auth_access_tokens VALUES (?, ?, ?, ?, ?, ?)').run(hash(access), grant.grant_id, grant.client_id, scope, grant.resource, expiry);
    const result: Fields = { access_token: access, token_type: 'Bearer', expires_in: expiry - now(), scope };
    if (refresh) {
      const raw = random();
      db.prepare('INSERT INTO auth_refresh_tokens VALUES (?, ?, ?, ?, ?, ?, NULL)').run(hash(raw), grant.grant_id, grant.client_id, scope, grant.resource, grant.expires_at);
      result.refresh_token = raw;
    }
    return result;
  }

  app.get('/api/v1/session', requireSession, (_req, res) => {
    res.json({ authenticated: true, csrf_token: res.locals.session.csrfToken });
  });
  app.post('/api/v1/login', endpoint(async (req, res) => {
    if (!sameOrigin(req, res)) return;
    if (!req.is('application/json')) throw new OAuthError('invalid_request', 'Login requires JSON');
    if (!rate(req, res, 'login', 10, 900, 60)) return;
    if (!await validPassword(fields(req.body).password)) { fail(res, 'invalid_credentials', 'Invalid password', 401); return; }
    const session = transaction(() => {
      const old = readSession(req);
      if (old) dropSession(old);
      return setSession(res, true);
    });
    res.json({ authenticated: true, csrf_token: session.csrfToken });
  }));
  app.post('/api/v1/logout', requireSession, requireCsrf, (req, res) => {
    const session = readSession(req)!;
    transaction(() => dropSession(session));
    res.clearCookie(cookieName, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    res.json({ authenticated: false });
  });

  const metadata = (issuer: string) => ({
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false,
  });
  // These endpoints use explicit protocol credentials and never a browser cookie.
  const cors: RequestHandler = (_req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    next();
  };
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.options(path, cors, (_req, res) => { res.sendStatus(204); });
    app.use(path, cors);
  }
  app.get('/.well-known/oauth-authorization-server', (req, res) => { res.json(metadata(requestIssuer(req))); });
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    res.json({ resource: requestResource(req), authorization_servers: [requestIssuer(req)], scopes_supported: SCOPES, bearer_methods_supported: ['header'] });
  });
  app.post('/oauth/register', endpoint((req, res) => {
    if (!rate(req, res, 'register', 20, HOUR, 100)) return;
    if (!req.is('application/json')) throw new OAuthError('invalid_client_metadata', 'Registration requires JSON');
    const body = fields(req.body);
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 10 ||
        body.redirect_uris.some(uri => typeof uri !== 'string' || uri.length > 2048)) {
      throw new OAuthError('invalid_redirect_uri', 'Provide 1–10 redirect URIs');
    }
    const redirects = [...new Set((body.redirect_uris as string[]).map(redirectUri))];
    const grants = body.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.length > 2 ||
        grants.some(grant => grant !== 'authorization_code' && grant !== 'refresh_token') ||
        (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code')) ||
        (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none')) {
      throw new OAuthError('invalid_client_metadata', 'Only public authorization-code clients with optional refresh tokens are supported');
    }
    const clientName = field(body, 'client_name', false, 128) ?? '未命名客户端';
    const scope = scopes(field(body, 'scope', false) ?? SCOPES.join(' ')).join(' ');
    const clientId = random();
    const issuedAt = now();
    db.prepare('INSERT INTO auth_clients VALUES (?, ?, ?, ?, ?, ?)').run(clientId, clientName, JSON.stringify(redirects), scope, JSON.stringify(grants), issuedAt);
    res.status(201).json({ client_id: clientId, client_id_issued_at: issuedAt, client_name: clientName,
      redirect_uris: redirects, scope, grant_types: grants, response_types: ['code'], token_endpoint_auth_method: 'none' });
  }));

  function authorizationParameters(req: Request, query: Fields) {
    const client = clientFrom(query);
    const redirect = field(query, 'redirect_uri')!;
    if (!(JSON.parse(client.redirect_uris) as string[]).includes(redirect)) throw new OAuthError('invalid_request', 'Redirect URI is not registered');
    if (field(query, 'response_type') !== 'code') throw new OAuthError('unsupported_response_type', 'Only code is supported');
    const resource = checkResource(query);
    if (resource !== requestResource(req)) throw new OAuthError('invalid_target', 'Authorization resource must match this origin');
    const scope = allowedScopes(field(query, 'scope', false) ?? client.scope, client.scope).join(' ');
    const challenge = field(query, 'code_challenge', true, 128)!;
    if (field(query, 'code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new OAuthError('invalid_request', 'PKCE S256 is required');
    }
    const state = field(query, 'state', false) ?? null;
    return { client, redirect, resource, scope, challenge, state };
  }
  function authorizationUrl(pending: Pick<Pending, 'client_id' | 'redirect_uri' | 'resource' | 'scope' | 'code_challenge' | 'state'>): string {
    const query = new URLSearchParams({ client_id: pending.client_id, redirect_uri: pending.redirect_uri,
      response_type: 'code', resource: pending.resource, scope: pending.scope,
      code_challenge: pending.code_challenge, code_challenge_method: 'S256' });
    if (pending.state !== null) query.set('state', pending.state);
    return `/oauth/authorize?${query}`;
  }
  function consentRecovery(req: Request, res: Response, error: OAuthError): void {
    let retry: string | undefined;
    try {
      // Old forms have no action query. A retained pending request can still supply it.
      let query = fields(req.query);
      if (Object.keys(query).length === 0) {
        const id = field(fields(req.body), 'request_id', true, 128)!;
        const pending = db.prepare('SELECT * FROM auth_pending WHERE request_hash = ?').get(hash(id)) as Pending | undefined;
        if (pending) query = Object.fromEntries(new URL(authorizationUrl(pending), requestIssuer(req)).searchParams);
      }
      const params = authorizationParameters(req, query);
      retry = authorizationUrl({ client_id: params.client.client_id, redirect_uri: params.redirect,
        resource: params.resource, scope: params.scope, code_challenge: params.challenge, state: params.state });
    } catch (failure) { if (!(failure instanceof OAuthError)) throw failure; }
    // This response never consumes consent, accepts a password, or grants access.
    res.set({ 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.status(error.status).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>重新授权 Boji</title>
      <main><h1>授权页面已失效</h1><p>浏览器会话可能已过期、被其他登录替换，或未能保存 Cookie。本次提交没有完成授权。</p>
      ${retry ? `<p><a href="${escapeHtml(retry)}">重新打开授权页面</a></p><p>请在新页面核对权限并重新确认授权。</p>` : '<p>请关闭此窗口，回到客户端重新点击「连接」或「重新连接」。</p>'}
      <p>如果反复出现，请允许浏览器保存本站 Cookie，并从客户端重新发起连接。</p></main></html>`);
  }

  function consentPage(res: Response, pending: Pending, client: Client, requestId: string, session: Session, message = ''): void {
    // Chromium checks the form's redirect chain against form-action too. Permit only
    // the registered callback origin; hostname validation prevents CSP injection.
    res.set({ 'Content-Security-Policy': `default-src 'none'; form-action 'self' ${new URL(pending.redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    const hidden = (key: string, value: string) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`;
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Boji 授权</title>
      <main><h1>授权访问 Boji 健康数据</h1><p>客户端：${escapeHtml(client.client_name)}</p>
      <p>注册名称由客户端提供，请核对回调地址。</p><p>回调来源：<strong>${escapeHtml(new URL(pending.redirect_uri).origin)}</strong></p>
      <p>完整回调：${escapeHtml(pending.redirect_uri)}</p><p>资源：${escapeHtml(pending.resource)}</p>
      <p>请求权限：${escapeHtml(pending.scope)}</p><ul>${pending.scope.split(' ').map(scope => `<li>${scope === 'health.read' ? 'health.read：读取健康记录与汇总' : 'health.write：新增、修改、删除和恢复健康记录'}</li>`).join('')}</ul>
      ${message ? `<p role="alert">${escapeHtml(message)}</p>` : ''}
      <form method="post" action="${escapeHtml(authorizationUrl(pending))}">${hidden('request_id', requestId)}${hidden('csrf_token', session.csrfToken)}
      ${session.authenticated ? '<p>已通过管理员身份验证。</p>' : '<label>管理员密码 <input type="password" name="password" autocomplete="current-password" maxlength="1024" required></label>'}
      <button name="decision" value="approve" type="submit">${session.authenticated ? '同意授权' : '登录并同意授权'}</button>
      <button name="decision" value="deny" type="submit" formnovalidate>拒绝</button></form></main></html>`);
  }
  app.get('/oauth/authorize', endpoint((req, res) => {
    if (!rate(req, res, 'authorize', 60, 60, 600)) return;
    const query = fields(req.query);
    if (Object.keys(query).length === 0 && req.accepts(['json', 'html']) === 'html') {
      res.status(400).type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Boji 连接说明</title>
        <main><h1>请从客户端发起授权</h1>
        <p>这个页面需要客户端生成的完整授权链接，直接打开此地址无法连接。</p>
        <p>请回到 ChatGPT 或其他 MCP 客户端，点击「连接」或「重新连接」，再打开生成的授权页面。</p>
        <p>添加 Boji 服务时，MCP 地址填写：<code>${escapeHtml(requestResource(req))}</code></p>
        <p><a href="/">打开 Boji 网页面板</a></p></main></html>`);
      return;
    }
    const { client, redirect, resource, scope, challenge, state } = authorizationParameters(req, query);
    const existing = readSession(req);
    // Never show a ten-minute form backed by a session with only seconds left.
    // A near-expiry authenticated session must log in again, not gain an extension.
    let session = existing;
    if (session && !session.authenticated) {
      // Keep anonymous tabs on the same CSRF binding; only refresh the short TTL.
      session.expires_at = now() + 600;
      db.prepare('UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?').run(session.expires_at, session.token_hash);
      const raw = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))!.slice(cookieName.length + 1);
      res.cookie(cookieName, raw, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 600_000 });
    } else if (!session || session.expires_at < now() + 600) session = setSession(res, false);
    const requestId = random();
    const pending: Pending = { request_hash: hash(requestId), session_hash: session.token_hash, client_id: client.client_id,
      redirect_uri: redirect, scope, resource, code_challenge: challenge, state, expires_at: Math.min(now() + 600, session.expires_at) };
    db.prepare('INSERT INTO auth_pending VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(pending.request_hash, pending.session_hash,
      pending.client_id, redirect, scope, resource, challenge, state, pending.expires_at);
    consentPage(res, pending, client, requestId, session);
  }));
  app.post('/oauth/authorize', endpoint(async (req, res) => {
    if (!sameOrigin(req, res)) return;
    if (!req.is('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Consent requires a form');
    const body = fields(req.body);
    const session = readSession(req);
    if (!session || !equal(field(body, 'csrf_token')!, session.csrfToken)) throw new OAuthError('invalid_csrf', 'Invalid browser session or CSRF token', 403);
    const requestId = field(body, 'request_id', true, 128)!;
    const pending = db.prepare('SELECT * FROM auth_pending WHERE request_hash = ?').get(hash(requestId)) as Pending | undefined;
    if (!pending || pending.expires_at <= now() || pending.session_hash !== session.token_hash) throw new OAuthError('invalid_request', 'Authorization request expired or belongs to another browser');
    const client = getClient(pending.client_id);
    if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(pending.redirect_uri) || pending.resource !== requestResource(req)) throw new OAuthError('invalid_request', 'Client registration or authorization origin changed');
    allowedScopes(pending.scope, client.scope);
    const decision = field(body, 'decision');
    if (decision !== 'approve' && decision !== 'deny') throw new OAuthError('invalid_request', 'Explicit consent is required');
    if (decision === 'approve' && !session.authenticated) {
      if (!rate(req, res, 'login', 10, 900, 60)) return;
      if (!await validPassword(body.password)) { res.status(401); consentPage(res, pending, client, requestId, session, '密码错误，请重试。'); return; }
    }
    // Recheck inside the transaction after the asynchronous password KDF, so parallel
    // submits, logout and expiration cannot reuse a pending consent or revive a session.
    const target = transaction(() => {
      const liveSession = readSession(req);
      if (!liveSession || liveSession.token_hash !== session.token_hash || pending.expires_at <= now()) throw new OAuthError('invalid_request', 'Authorization session expired');
      const consumed = db.prepare('DELETE FROM auth_pending WHERE request_hash = ? AND session_hash = ?').run(pending.request_hash, session.token_hash);
      if (consumed.changes !== 1) throw new OAuthError('invalid_request', 'Authorization request already used');
      const url = new URL(pending.redirect_uri);
      if (pending.state !== null) url.searchParams.set('state', pending.state);
      url.searchParams.set('iss', pending.resource.slice(0, -'/mcp'.length));
      if (decision === 'deny') { url.searchParams.set('error', 'access_denied'); return url; }
      if (!session.authenticated) { dropSession(session); setSession(res, true); }
      const code = random();
      db.prepare('INSERT INTO auth_codes VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(hash(code), client.client_id,
        pending.redirect_uri, pending.scope, pending.resource, pending.code_challenge, now() + 300);
      url.searchParams.set('code', code);
      return url;
    });
    res.redirect(303, target.href);
  }));

  app.post('/oauth/token', endpoint((req, res) => {
    if (!req.is('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Token exchange requires a form');
    const body = fields(req.body);
    const client = clientFrom(body, req);
    const resource = checkResource(body);
    const type = field(body, 'grant_type');
    if (type !== 'authorization_code' && type !== 'refresh_token') throw new OAuthError('unsupported_grant_type', 'Unsupported grant type');
    if (!(JSON.parse(client.grant_types) as string[]).includes(type)) throw new OAuthError('unauthorized_client', 'Client is not registered for this grant');
    const scopeRequested = field(body, 'scope', false);
    if (type === 'authorization_code') {
      const raw = field(body, 'code', true, 128)!;
      const redirect = field(body, 'redirect_uri')!;
      const pkce = field(body, 'code_verifier', true, 128)!;
      const code = db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(hash(raw)) as Code | undefined;
      if (!code || code.expires_at <= now() || code.client_id !== client.client_id || code.redirect_uri !== redirect ||
          !(JSON.parse(client.redirect_uris) as string[]).includes(redirect) || code.resource !== resource ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(pkce) || !equal(createHash('sha256').update(pkce).digest('base64url'), code.code_challenge)) {
        throw new OAuthError('invalid_grant', 'Invalid authorization code or PKCE binding');
      }
      const granted = allowedScopes(code.scope, client.scope).join(' ');
      if (scopeRequested !== undefined && scopes(scopeRequested).sort().join(' ') !== scopes(granted).sort().join(' ')) throw new OAuthError('invalid_scope', 'Code scope cannot be changed');
      if (code.used_at !== null) { if (code.grant_id) revoke(code.grant_id); throw new OAuthError('invalid_grant', 'Authorization code was already used'); }
      const tokens = transaction(() => {
        const grant: Grant = { grant_id: random(), client_id: client.client_id, scope: granted, resource,
          expires_at: now() + ((JSON.parse(client.grant_types) as string[]).includes('refresh_token') ? 30 * DAY : HOUR), revoked_at: null };
        const consumed = db.prepare('UPDATE auth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ? AND used_at IS NULL').run(now(), grant.grant_id, code.code_hash);
        if (consumed.changes !== 1) throw new OAuthError('invalid_grant', 'Authorization code was already used');
        db.prepare('INSERT INTO auth_grants VALUES (?, ?, ?, ?, ?, NULL)').run(grant.grant_id, client.client_id, granted, resource, grant.expires_at);
        return issue(grant, granted, (JSON.parse(client.grant_types) as string[]).includes('refresh_token'));
      });
      console.info(JSON.stringify({ event: 'boji.auth', action: 'token_issued', grant_type: type, scope: tokens.scope, expires_in: tokens.expires_in }));
      res.json(tokens);
    } else {
      const token = db.prepare('SELECT * FROM auth_refresh_tokens WHERE token_hash = ?').get(hash(field(body, 'refresh_token', true, 128)!)) as Token | undefined;
      const grant = token && db.prepare('SELECT * FROM auth_grants WHERE grant_id = ?').get(token.grant_id) as Grant | undefined;
      if (!token || !grant || token.expires_at <= now() || grant.expires_at <= now() || grant.revoked_at !== null ||
          token.client_id !== client.client_id || grant.client_id !== client.client_id || token.resource !== resource || grant.resource !== resource) {
        throw new OAuthError('invalid_grant', 'Invalid refresh token');
      }
      if (token.used_at !== null) { revoke(grant.grant_id); throw new OAuthError('invalid_grant', 'Refresh token reuse; grant revoked'); }
      allowedScopes(token.scope, grant.scope);
      const scope = allowedScopes(scopeRequested ?? token.scope, token.scope).join(' ');
      allowedScopes(scope, client.scope);
      const tokens = transaction(() => {
        const consumed = db.prepare('UPDATE auth_refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(now(), token.token_hash);
        if (consumed.changes !== 1) throw new OAuthError('invalid_grant', 'Refresh token was already used');
        db.prepare('DELETE FROM auth_access_tokens WHERE grant_id = ?').run(grant.grant_id);
        return issue(grant, scope, true);
      });
      console.info(JSON.stringify({ event: 'boji.auth', action: 'token_issued', grant_type: type, scope: tokens.scope, expires_in: tokens.expires_in }));
      res.json(tokens);
    }
  }));
  app.post('/oauth/revoke', endpoint((req, res) => {
    if (!req.is('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Revocation requires a form');
    const body = fields(req.body);
    const client = clientFrom(body, req);
    const tokenHash = hash(field(body, 'token', true, 128)!);
    const token = (db.prepare('SELECT * FROM auth_access_tokens WHERE token_hash = ?').get(tokenHash) ??
      db.prepare('SELECT * FROM auth_refresh_tokens WHERE token_hash = ?').get(tokenHash)) as Token | undefined;
    if (token?.client_id === client.client_id) revoke(token.grant_id);
    res.status(200).json({});
  }));
  return { requireSession, requireCsrf, requireMcp };
}
