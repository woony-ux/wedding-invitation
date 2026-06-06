const crypto = require('node:crypto');

const DATA_REPO = process.env.WEDDING_DATA_REPO || 'jeonghoon0126/wedding-invitation-data';
const GITHUB_TOKEN = process.env.GITHUB_DATA_TOKEN;
const LUCKY_TICKET_OPEN = new Date('2026-08-09T00:00:00+09:00');
const LUCKY_TICKET_CLOSE = new Date('2026-08-10T00:00:00+09:00');
const MAX_BODY_BYTES = 16 * 1024;

const ALLOWED_ORIGINS = new Set([
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

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  if (!isAllowedRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'origin_not_allowed' });
    return;
  }

  try {
    assertConfigured();
    const payload = parsePayload(req);
    const action = sanitize(payload.action || inferAction(payload), 40);

    if (action === 'submit_solo_application') {
      sendJson(res, 200, await submitSoloApplication(payload));
      return;
    }

    if (action === 'issue_lucky_ticket') {
      const result = await issueLuckyTicket(payload);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    sendJson(res, 400, { ok: false, error: 'unsupported_action' });
  } catch (error) {
    const status = error.expose ? 400 : 500;
    sendJson(res, status, {
      ok: false,
      error: error.expose ? error.message : 'server_error'
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

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

async function issueLuckyTicket(payload) {
  if (!isLuckyTicketOpen(new Date())) {
    return {
      ok: false,
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
  const ticketPath = `tickets/by-device/${deviceHash}.json`;
  const existing = await getTicketFile(ticketPath) || await findTicketIssue(deviceHash);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      number: existing.number,
      ticketId: String(existing.ticketId || existing.issueNumber)
    };
  }

  const issuedAt = new Date().toISOString();
  const source = sanitize(payload.source || 'wedding-invitation', 40);
  const userAgent = sanitize(payload.userAgent, 240);
  const created = await github('/issues', {
    method: 'POST',
    body: {
      title: '추첨권 발급 대기',
      labels: ['lucky-ticket'],
      body: buildTicketBody({
        ticketNumber: 'pending',
        deviceHash,
        issuedAt,
        source,
        userAgent
      })
    }
  });

  if (created.number > 9999) {
    throw new Error('ticket_sold_out');
  }

  const ticketNumber = `WJ-${String(created.number).padStart(4, '0')}`;
  const ticket = {
    number: ticketNumber,
    ticketId: String(created.number),
    deviceHash,
    issuedAt,
    source,
    userAgent
  };

  await github(`/issues/${created.number}`, {
    method: 'PATCH',
    body: {
      title: `추첨권 ${ticketNumber}`,
      body: buildTicketBody({
        ticketNumber,
        deviceHash,
        issuedAt,
        source,
        userAgent
      })
    }
  });

  try {
    await putRepoFile(ticketPath, {
      message: `Add lucky ticket ${ticketNumber}`,
      content: toBase64(JSON.stringify(ticket, null, 2))
    });
  } catch (error) {
    if (error.status === 422) {
      const duplicated = await getTicketFile(ticketPath);
      if (duplicated) {
        await github(`/issues/${created.number}`, {
          method: 'PATCH',
          body: {
            title: `중복 추첨권 요청 ${ticketNumber}`,
            state: 'closed',
            body: [
              buildTicketBody({
                ticketNumber,
                deviceHash,
                issuedAt,
                source,
                userAgent
              }),
              '',
              `duplicate_of: ${duplicated.number}`
            ].join('\n')
          }
        });
        return {
          ok: true,
          duplicate: true,
          number: duplicated.number,
          ticketId: duplicated.ticketId
        };
      }
    }
    throw error;
  }

  return {
    ok: true,
    duplicate: false,
    number: ticket.number,
    ticketId: ticket.ticketId,
    issuedAt
  };
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

async function findTicketIssue(deviceHash) {
  for (let page = 1; page <= 100; page += 1) {
    const issues = await github(`/issues?state=all&labels=lucky-ticket&per_page=100&page=${page}`);
    if (!issues.length) return null;

    const found = issues.find(issue => String(issue.body || '').includes(`device_hash: ${deviceHash}`));
    if (found) {
      return {
        issueNumber: found.number,
        ticketId: String(found.number),
        number: extractTicketNumber(found) || `WJ-${String(found.number).padStart(4, '0')}`
      };
    }
  }
  return null;
}

async function getTicketFile(path) {
  const file = await getRepoFile(path);
  if (!file || !file.content) return null;

  try {
    const ticket = JSON.parse(fromBase64(file.content));
    if (ticket && /^WJ-\d{4}$/.test(ticket.number || '') && ticket.ticketId) {
      return ticket;
    }
  } catch {
    return null;
  }
  return null;
}

function extractTicketNumber(issue) {
  const titleMatch = String(issue.title || '').match(/WJ-\d{4}/);
  if (titleMatch) return titleMatch[0];
  const bodyMatch = String(issue.body || '').match(/ticket_number: (WJ-\d{4})/);
  return bodyMatch ? bodyMatch[1] : null;
}

function buildTicketBody({ ticketNumber, deviceHash, issuedAt, source, userAgent }) {
  return [
    `ticket_number: ${ticketNumber}`,
    `device_hash: ${deviceHash}`,
    `issued_at: ${issuedAt}`,
    `source: ${source}`,
    `user_agent: ${userAgent}`
  ].join('\n');
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
  const response = await fetch(`https://api.github.com/repos/${DATA_REPO}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wedding-invitation-api'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`github_${response.status}`);
    error.status = response.status;
    error.detail = text.slice(0, 500);
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

function isLuckyTicketOpen(now) {
  if (process.env.LUCKY_TICKET_FORCE_OPEN === 'true') return true;
  return now >= LUCKY_TICKET_OPEN && now < LUCKY_TICKET_CLOSE;
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

function URLish(value) {
  try {
    return new URL(value || 'https://invalid.local');
  } catch {
    return new URL('https://invalid.local');
  }
}
