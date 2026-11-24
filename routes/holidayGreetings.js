'use strict';
const express = require('express');
const { PREFIX, COOKIE, fail, equal, configFromEnv, csrf, cookieToken } = require('../holiday/security');
const { HolidayStore } = require('../holiday/store');
const { HolidayGoogle } = require('../holiday/google');
const { Greetings, version } = require('../holiday/greetings');

module.exports = function holidayGreetingsRoutes(ctx) {
  const router = express.Router();
  let config;
  try { config = ctx.holidayConfig === undefined ? configFromEnv() : ctx.holidayConfig; }
  catch { config = null; }
  const store = config ? (ctx.holidayStore || new HolidayStore(ctx.auditPool, config)) : null;
  const google = config ? (ctx.holidayGoogle || new HolidayGoogle(config)) : null;
  const greetings = config ? new Greetings(store, google) : null;
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const setCookie = (res, token) => res.cookie(COOKIE, token, {
    secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 14 * 86400000
  });
  router.use(PREFIX, (req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.removeHeader('Access-Control-Allow-Origin');
    if (!config) return next(fail('HOLIDAY_SETUP_REQUIRED', 503));
    // Same-origin proxy only. Never derive allowed origins/redirects from Host headers.
    if (req.get('origin') && req.get('origin') !== config.origin) return next(fail('ORIGIN_FORBIDDEN', 403));
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
      return next(fail('INVALID_FIELDS'));
    }
    next();
  });
  async function loadSession(req) {
    req.holidayToken = cookieToken(req);
    req.holidaySession = await store.session(req.holidayToken);
    if (!req.holidaySession) throw fail('OWNER_SESSION_REQUIRED', 401);
  }
  const session = (req, res, next) => loadSession(req).then(() => next(), next);
  const owner = (req, res, next) => loadSession(req).then(async () => {
    if (!req.holidaySession.owner_sub) throw fail('OWNER_SESSION_REQUIRED', 401);
    req.ownerSub = req.holidaySession.owner_sub;
    await store.owner(req.ownerSub);
    next();
  }).catch(next);
  const requireCsrf = (req, res, next) => {
    // Same-origin GET fetches may omit Origin. Their non-simple CSRF header is
    // still mandatory; state-changing POST/PUT/PATCH/DELETE require Origin too.
    if (((req.method !== 'GET' || req.get('origin')) && req.get('origin') !== config.origin) ||
        !equal(req.get('x-csrf-token'), csrf(req.holidayToken, config))) {
      return next(fail('CSRF_REJECTED', 403));
    }
    next();
  };
  function uuid(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw fail('INVALID_RECORD_ID');
    return value;
  }
  const p = path => `${PREFIX}${path}`;

  // Anonymous response contains only bootstrap/CSRF state, never private owner data.
  router.get(p('/session'), wrap(async (req, res) => {
    let token = cookieToken(req), current = await store.session(token);
    if (!current) { token = await store.createSession(); setCookie(res, token); }
    const own = current?.owner_sub ? await store.owner(current.owner_sub) : null;
    res.json({ authenticated: Boolean(own), googleConnected: Boolean(own?.connected),
      csrfToken: csrf(token, config), expiresAt: current?.expires_at || null });
  }));
  router.get(p('/oauth/google/start'), session, requireCsrf, wrap(async (req, res) => {
    const state = await store.start(req.holidayToken);
    res.json({ authorizationUrl: google.authorizationUrl(state) });
  }));
  router.get(p('/oauth/google/callback'), session, wrap(async (req, res) => {
    const proof = await store.consumeState(req.query.state, req.holidayToken);
    if (req.query.error) throw fail('GOOGLE_CONSENT_DENIED', 403);
    if (typeof req.query.code !== 'string' || req.query.code.length > 10000) throw fail('INVALID_AUTHORIZATION_CODE');
    const tokens = await google.exchange(req.query.code, proof.verifier);
    const identity = await google.verifyIdToken(tokens.id_token, proof.nonce);
    const token = await store.connectOwner(identity, tokens, req.holidayToken);
    setCookie(res, token);
    // Fixed destination, no token/code/query reflection and no user-controlled redirects.
    res.redirect(303, `${config.origin}/?holidayGreetings=connected`);
  }));
  router.post(p('/logout'), owner, requireCsrf, wrap(async (req, res) => {
    await store.logout(req.holidayToken);
    res.clearCookie(COOKIE, { secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    res.json({ success: true });
  }));
  router.post(p('/google/disconnect'), owner, requireCsrf, wrap(async (req, res) => {
    res.json(await store.disconnect(req.ownerSub, google));
  }));
  router.get(p('/contacts'), owner, wrap(async (req, res) => {
    const pageSize = req.query.pageSize === undefined ? 50 : Number(req.query.pageSize);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      (req.query.pageToken !== undefined && (typeof req.query.pageToken !== 'string' || req.query.pageToken.length > 4000)) ||
      (req.query.search !== undefined && (typeof req.query.search !== 'string' || req.query.search.length > 200))) {
      throw fail('INVALID_CONTACT_QUERY');
    }
    const token = await store.accessToken(req.ownerSub, google);
    res.json(await google.list(token, { pageSize, pageToken: req.query.pageToken, search: req.query.search || '' }));
  }));
  router.get(p('/preferences'), owner, wrap(async (req, res) => {
    res.json({ preferences: await store.preferences(req.ownerSub) });
  }));
  router.put(p('/preferences'), owner, requireCsrf, wrap(async (req, res) => {
    res.json(await greetings.savePreference(req.ownerSub, req.body));
  }));
  router.post(p('/batches'), owner, requireCsrf, wrap(async (req, res) => {
    res.status(201).json(await greetings.createBatch(req.ownerSub, req.body));
  }));
  router.get(p('/batches/current'), owner, wrap(async (req, res) => {
    res.json({ batch: await store.currentBatch(req.ownerSub) });
  }));
  router.get(p('/batches/:batchId'), owner, wrap(async (req, res) => {
    res.json(await store.batch(req.ownerSub, uuid(req.params.batchId)));
  }));
  router.patch(p('/batches/:batchId'), owner, requireCsrf, wrap(async (req, res) => {
    res.json(await greetings.patchBatch(req.ownerSub, uuid(req.params.batchId), req.body));
  }));
  router.patch(p('/batches/:batchId/drafts/:draftId'), owner, requireCsrf, wrap(async (req, res) => {
    res.json(await greetings.patchDraft(req.ownerSub, uuid(req.params.batchId), uuid(req.params.draftId), req.body));
  }));
  for (const [path, action] of [['opened', 'opened'], ['mark-sent', 'sent']]) {
    router.post(p(`/batches/:batchId/drafts/:draftId/${path}`), owner, requireCsrf, wrap(async (req, res) => {
      res.json(await greetings.patchDraft(req.ownerSub, uuid(req.params.batchId), uuid(req.params.draftId), req.body, action));
    }));
  }
  router.delete(p('/batches/:batchId'), owner, requireCsrf, wrap(async (req, res) => {
    await store.deleteBatch(req.ownerSub, uuid(req.params.batchId), version(req.body?.version));
    res.json({ success: true });
  }));
  router.use(PREFIX, (req, res) => res.status(404).json({ error: 'HOLIDAY_ENDPOINT_NOT_FOUND' }));
  router.use(PREFIX, (error, req, res, next) => {
    // Never expose provider bodies, SQL parameters, contacts, messages or token material.
    if (res.headersSent) return next(error);
    const schemaMissing = ['42P01', '42703'].includes(error.code);
    const safe = error.status && error.status >= 400 && error.status <= 599;
    res.status(schemaMissing ? 503 : safe ? error.status : 500)
      .json({ error: schemaMissing ? 'HOLIDAY_SCHEMA_REQUIRED' : safe ? error.code : 'HOLIDAY_REQUEST_FAILED' });
  });
  return router;
};
