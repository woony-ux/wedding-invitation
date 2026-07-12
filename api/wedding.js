const crypto = require('node:crypto');

const DATA_REPO = process.env.WEDDING_DATA_REPO || 'jeonghoon0126/wedding-invitation-data';
const GITHUB_TOKEN = process.env.GITHUB_DATA_TOKEN;
const LUCKY_TICKET_OPEN = new Date('2026-08-09T00:00:00+09:00');
const LUCKY_TICKET_CLOSE = new Date('2026-08-10T00:00:00+09:00');
const MAX_BODY_BYTES = 16 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = Math.max(
  process.env.NODE_ENV === 'test' ? 10 : 1000,
  Number(process.env.GITHUB_REQUEST_TIMEOUT_MS) || 8000
);
const pendingLuckyTickets = new Map();
const recentLuckyTickets = new Map();
const RECENT_TICKET_TTL_MS = 5 * 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  'https://junghoon-woonjin.kr',
  'https://woony-ux.github.io',
  'https://wedding-invitation-five-eta.vercel.app',
  'http://127.0.0.1:8765',
  'http://localhost:8765'
]);

async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  if (!isAllowedRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
    return;
  }

  try {
    assertConfigured();
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: 'wedding-invitation-api',
        status: 'configured',
        storageConfigured: true,
        storage: 'github-contents',
        luckyTicketWindow: {
          openAt: LUCKY_TICKET_OPEN.toISOString(),
          closeAt: LUCKY_TICKET_CLOSE.toISOString()
        }
      });
      return;
    }

    const payload = parsePayload(req);
    const action = sanitize(payload.action || inferAction(payload), 40);

    if (action === 'submit_solo_application') {
      sendJson(res, 200, await submitSoloApplication(payload));
      return;
    }

    if (action === 'issue_lucky_ticket') {
      const result = await issueLuckyTicket(payload);
      sendJson(res, result.ok ? 200 : (result.status || 409), result);
      return;
    }

    sendJson(res, 400, { ok: false, error: 'unsupported_action' });
  } catch (error) {
    const status = error.publicStatus || (error.expose ? 400 : 500);
    const exposeMessage = Boolean(error.publicStatus || error.expose);
    sendJson(res, status, {
      ok: false,
      error: exposeMessage ? error.message : 'server_error',
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {})
    });
  }
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb'
    }
  }
};
module.exports._test = {
  isWithinLuckyTicketWindow,
  issueLuckyTicket
};

function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Vary', 'Origin');
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function isAllowedRequest(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) return true;

  const referer = req.headers.referer || '';
  if (!origin && referer) {
    const refererOrigin = URLish(referer).origin;
    return ALLOWED_ORIGINS.has(refererOrigin);
  }

  return false;
}

function sendJson(res, status, value) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

function assertConfigured() {
  if (!GITHUB_TOKEN) {
    throw new Error('missing_github_token');
  }
  if (!/^[^/]+\/[^/]+$/.test(DATA_REPO)) {
    throw new Error('invalid_data_repo');
  }
}

function parsePayload(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;

  const text = String(req.body);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw publicError('payload_too_large');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw publicError('invalid_payload');
  }
}

function inferAction(payload) {
  if (payload && (payload.name || payload.intro || payload.gender || payload.side)) {
    return 'submit_solo_application';
  }
  return '';
}

async function submitSoloApplication(payload) {
  const application = validateApplication(payload);
  const receivedAt = new Date().toISOString();
  const path = `solo/${receivedAt.slice(0, 10)}/${application.applicationId}.json`;
  const existing = await getRepoFile(path);

  if (existing) {
    return {
      ok: true,
      duplicate: true,
      applicationId: application.applicationId
    };
  }

  try {
    await putRepoFile(path, {
      message: `Add solo application ${application.applicationId}`,
      content: toBase64(JSON.stringify({
        receivedAt,
        application
      }, null, 2))
    });
  } catch (error) {
    if (error.status === 422 && await getRepoFile(path)) {
      return {
        ok: true,
        duplicate: true,
        applicationId: application.applicationId
      };
    }
    throw error;
  }

  return {
    ok: true,
    duplicate: false,
    applicationId: application.applicationId
  };
}

async function issueLuckyTicket(payload, now = new Date()) {
  if (!isLuckyTicketOpen(now)) {
    return {
      ok: false,
      status: 200,
      error: 'ticket_not_open',
      openAt: LUCKY_TICKET_OPEN.toISOString(),
      closeAt: LUCKY_TICKET_CLOSE.toISOString()
    };
  }

  const deviceId = sanitize(payload.deviceId, 160);
  if (!deviceId) {
    throw publicError('missing_device_id');
  }

  const deviceHash = sha256(deviceId);
  const cached = getRecentLuckyTicket(deviceHash);
  if (cached) return { ...cached, duplicate: true };
  if (pendingLuckyTickets.has(deviceHash)) {
    const ticket = await pendingLuckyTickets.get(deviceHash);
    return { ...ticket, duplicate: true };
  }

  const request = issueLuckyTicketForDevice(payload, deviceHash, now);
  pendingLuckyTickets.set(deviceHash, request);
  try {
    const ticket = await request;
    setRecentLuckyTicket(deviceHash, ticket);
    return ticket;
  } finally {
    if (pendingLuckyTickets.get(deviceHash) === request) pendingLuckyTickets.delete(deviceHash);
  }
}

function getRecentLuckyTicket(deviceHash) {
  const cached = recentLuckyTickets.get(deviceHash);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt >= RECENT_TICKET_TTL_MS) {
    recentLuckyTickets.delete(deviceHash);
    return null;
  }
  return cached.ticket;
}

function setRecentLuckyTicket(deviceHash, ticket) {
  if (recentLuckyTickets.size >= 1000) {
    recentLuckyTickets.delete(recentLuckyTickets.keys().next().value);
  }
  recentLuckyTickets.set(deviceHash, { cachedAt: Date.now(), ticket });
}

async function issueLuckyTicketForDevice(payload, deviceHash, now) {
  try {
    const issuedAt = now.toISOString();
    const source = sanitize(payload.source || 'wedding-invitation', 40);
    const userAgent = sanitize(payload.userAgent, 240);
    for (let probe = 0; probe < 9999; probe += 1) {
      const number = candidateTicketNumber(deviceHash, probe);
      const ticketPath = `tickets/by-number/${number}.json`;
      const indexed = await getTicketFile(ticketPath);
      if (indexed) {
        if (indexed.deviceHash === deviceHash) {
          return { ...indexed, ok: true, duplicate: true };
        }
        continue;
      }

      const ticket = {
        ok: true,
        duplicate: false,
        number,
        ticketId: number.slice(3),
        deviceHash,
        source,
        userAgent,
        issuedAt
      };
      const result = await claimTicketPath(ticketPath, ticket);
      if (result.status === 'collision') continue;
      return {
        ...result.ticket,
        ok: true,
        duplicate: result.status === 'duplicate'
      };
    }
    throw publicServiceError('ticket_sold_out', 503);
  } catch (error) {
    if (isTemporaryGitHubError(error)) {
      throw publicServiceError('ticket_busy', 503, error.retryAfterSeconds);
    }
    throw error;
  }
}

async function claimTicketPath(path, ticket) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await putRepoFile(path, {
        message: `Add lucky ticket ${ticket.number}`,
        content: toBase64(JSON.stringify(ticket, null, 2))
      });
      return { status: 'claimed', ticket };
    } catch (error) {
      const existing = await getTicketFile(path);
      if (existing) {
        return existing.deviceHash === ticket.deviceHash
          ? { status: 'duplicate', ticket: existing }
          : { status: 'collision', ticket: existing };
      }
      if (error.status === 403 || error.status === 429 || error.retryAfterSeconds) throw error;
      if (!isTemporaryGitHubError(error) && error.status !== 422) throw error;
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
  throw new Error('ticket_index_failed');
}

function validateApplication(payload) {
  const applicationId = sanitize(payload.id || payload.applicationId || crypto.randomUUID(), 80);
  const name = sanitize(payload.name, 20);
  const age = Number(payload.age);
  const gender = sanitize(payload.gender, 10);
  const side = sanitize(payload.side, 10);
  const job = sanitize(payload.job, 30);
  const mbti = sanitize(String(payload.mbti || '').toUpperCase(), 4);
  const intro = sanitize(payload.intro, 160);
  const contact = sanitize(payload.contact, 40);
  const alias = sanitize(payload.alias, 20);
  const source = sanitize(payload.source || 'wedding-invitation', 40);
  const userAgent = sanitize(payload.userAgent, 240);

  if (!applicationId || !name || !Number.isInteger(age) || age < 20 || age > 55 || !job || !intro) {
    throw publicError('missing_required_fields');
  }
  if (gender !== '남성' && gender !== '여성') {
    throw publicError('invalid_gender');
  }
  if (side !== '신랑측' && side !== '신부측') {
    throw publicError('invalid_side');
  }
  if (mbti && !/^[A-Z]{4}$/.test(mbti)) {
    throw publicError('invalid_mbti');
  }

  return {
    applicationId,
    name,
    age,
    gender,
    side,
    job,
    mbti,
    intro,
    contact,
    alias,
    source,
    userAgent
  };
}

async function getTicketFile(path) {
  const file = await getRepoFile(path);
  if (!file || !file.content) return null;

  try {
    const ticket = JSON.parse(fromBase64(file.content));
    if (ticket
        && /^WJ-\d{4}$/.test(ticket.number || '')
        && /^\d+$/.test(String(ticket.ticketId || ''))
        && /^[a-f0-9]{64}$/.test(ticket.deviceHash || '')
        && ticket.issuedAt) {
      return ticket;
    }
  } catch {}
  return null;
}

function candidateTicketNumber(deviceHash, probe) {
  const base = Number.parseInt(deviceHash.slice(0, 8), 16) % 9999;
  const value = ((base + probe) % 9999) + 1;
  return `WJ-${String(value).padStart(4, '0')}`;
}

async function getRepoFile(path) {
  try {
    return await github(`/contents/${encodeURIComponentPath(path)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function putRepoFile(path, body) {
  return github(`/contents/${encodeURIComponentPath(path)}`, {
    method: 'PUT',
    body
  });
}

async function github(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${DATA_REPO}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'wedding-invitation-api'
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`github_${response.status}`);
      error.status = response.status;
      error.temporary = response.status === 409 || response.status === 429 || response.status >= 500;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
      error.detail = text.slice(0, 500);
      throw error;
    }

    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (cause) {
      const error = new Error('github_response_error');
      error.status = 503;
      error.temporary = true;
      error.cause = cause;
      throw error;
    }
  } catch (cause) {
    if (cause && cause.status) throw cause;
    const error = new Error(cause && cause.name === 'AbortError' ? 'github_timeout' : 'github_network_error');
    error.status = 503;
    error.temporary = true;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isLuckyTicketOpen(now) {
  if (process.env.LUCKY_TICKET_FORCE_OPEN === 'true') return true;
  return isWithinLuckyTicketWindow(now);
}

function isWithinLuckyTicketWindow(now) {
  return now >= LUCKY_TICKET_OPEN && now < LUCKY_TICKET_CLOSE;
}

function isTemporaryGitHubError(error) {
  return Boolean(error && (
    error.temporary
    || error.status === 403
    || error.status === 409
    || error.status === 422
    || error.status === 429
    || error.status >= 500
  ));
}

function sanitize(value, maxLength) {
  let text = String(value || '').trim().slice(0, maxLength);
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return text;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function toBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function fromBase64(value) {
  return Buffer.from(String(value).replace(/\s/g, ''), 'base64').toString('utf8');
}

function encodeURIComponentPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function publicError(message) {
  const error = new Error(message);
  error.expose = true;
  return error;
}

function publicServiceError(message, status, retryAfterSeconds) {
  const error = new Error(message);
  error.publicStatus = status;
  if (retryAfterSeconds) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function URLish(value) {
  try {
    return new URL(value || 'https://invalid.local');
  } catch {
    return new URL('https://invalid.local');
  }
}
