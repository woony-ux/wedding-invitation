const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.GITHUB_DATA_TOKEN = 'test-token';
process.env.WEDDING_DATA_REPO = 'owner/repo';
process.env.LUCKY_TICKET_FORCE_OPEN = 'true';
process.env.GITHUB_REQUEST_TIMEOUT_MS = '30';
process.env.NODE_ENV = 'test';

const handler = require('../api/wedding');
const PUBLIC_ORIGIN = 'https://junghoon-woonjin.kr';

function response(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function createLedger({
  disconnectFirstPutBodyAfterPersist = false,
  conflictFirstPut = false,
  synchronizeFirstFileReads = false
} = {}) {
  const files = new Map();
  const calls = [];
  let disconnectedPut = false;
  let conflictedPut = false;
  let synchronizedFileReads = 0;
  const fileReadWaiters = [];

  return {
    files,
    calls,
    async fetch(url, options = {}) {
      const method = options.method || 'GET';
      const parsed = new URL(url);
      calls.push({ method, path: parsed.pathname, search: parsed.search });

      if (method === 'GET' && parsed.pathname.includes('/contents/')) {
        const path = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
        if (synchronizeFirstFileReads && !files.has(path) && synchronizedFileReads < 2) {
          synchronizedFileReads += 1;
          if (synchronizedFileReads === 2) {
            fileReadWaiters.splice(0).forEach(resolve => resolve());
          } else {
            await new Promise(resolve => fileReadWaiters.push(resolve));
          }
        }
        if (!files.has(path)) return response(404, {});
        return response(200, { content: Buffer.from(files.get(path), 'utf8').toString('base64') });
      }

      if (method === 'PUT' && parsed.pathname.includes('/contents/')) {
        const path = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
        if (conflictFirstPut && !conflictedPut) {
          conflictedPut = true;
          return response(409, { message: 'branch conflict' });
        }
        if (files.has(path)) return response(422, { message: 'already exists' });
        const payload = JSON.parse(options.body);
        files.set(path, Buffer.from(payload.content, 'base64').toString('utf8'));
        if (disconnectFirstPutBodyAfterPersist && !disconnectedPut) {
          disconnectedPut = true;
          return {
            ok: true,
            status: 201,
            headers: new Headers(),
            async json() { throw new TypeError('stream disconnected'); }
          };
        }
        return response(201, {});
      }
      throw new Error(`Unexpected GitHub request: ${method} ${parsed.pathname}${parsed.search}`);
    }
  };
}

function createNodeResponse() {
  return {
    statusCode: 200,
    headers: new Map(),
    body: '',
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); return this; },
    end(value = '') { this.body = String(value); }
  };
}

async function invoke({ method = 'POST', origin = PUBLIC_ORIGIN, body = {}, target = handler } = {}) {
  const req = { method, headers: { origin, referer: `${origin}/` }, body };
  const res = createNodeResponse();
  await target(req, res);
  return {
    status: res.statusCode,
    headers: Object.fromEntries(res.headers),
    data: res.body ? JSON.parse(res.body) : null
  };
}

function freshHandler() {
  const modulePath = require.resolve('../api/wedding');
  delete require.cache[modulePath];
  return require('../api/wedding');
}

function findCollidingDeviceIds() {
  const seen = new Map();
  for (let index = 0; index < 2000; index += 1) {
    const deviceId = `collision-device-${index}`;
    const hash = crypto.createHash('sha256').update(deviceId).digest('hex');
    const firstNumber = (Number.parseInt(hash.slice(0, 8), 16) % 9999) + 1;
    if (seen.has(firstNumber)) return [seen.get(firstNumber), deviceId];
    seen.set(firstNumber, deviceId);
  }
  throw new Error('test fixture could not find a ticket-number collision');
}

test('공개 HTTP 주소는 경로와 쿼리를 보존해 HTTPS로 즉시 전환한다', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const redirectScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(script => script.includes("secureUrl.protocol = 'https:'"));
  assert.ok(redirectScript);

  const redirects = [];
  vm.runInNewContext(redirectScript, {
    URL,
    window: {
      location: {
        protocol: 'http:',
        hostname: 'junghoon-woonjin.kr',
        href: 'http://junghoon-woonjin.kr/path?guest=1#ticket',
        replace(value) { redirects.push(value); }
      }
    }
  });
  assert.deepEqual(redirects, ['https://junghoon-woonjin.kr/path?guest=1#ticket']);
});

test('공개 청첩장 도메인의 사전 요청을 허용한다', async () => {
  const result = await invoke({ method: 'OPTIONS' });
  assert.equal(result.status, 204);
  assert.equal(result.headers['access-control-allow-origin'], PUBLIC_ORIGIN);
  assert.equal(result.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');

  const insecureOrigin = await invoke({
    origin: 'http://junghoon-woonjin.kr',
    body: { action: 'issue_lucky_ticket', deviceId: 'insecure-origin' }
  });
  assert.equal(insecureOrigin.status, 403);
  assert.equal(insecureOrigin.headers['access-control-allow-origin'], undefined);
});

test('공개 청첩장에서 API 설정 상태를 데이터 생성 없이 확인한다', async () => {
  const result = await invoke({ method: 'GET' });
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.status, 'configured');
  assert.equal(result.data.storageConfigured, true);
  assert.equal(result.data.storage, 'github-contents');
  assert.equal(result.data.luckyTicketWindow.openAt, '2026-08-08T15:00:00.000Z');
});

test('허용하지 않은 출처는 GitHub 호출 전에 거절한다', async () => {
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return response(500, {}); };
  const result = await invoke({ origin: 'https://example.com', body: { action: 'issue_lucky_ticket', deviceId: 'blocked' } });
  assert.equal(result.status, 403);
  assert.equal(fetchCalls, 0);
});

test('발급 시간 경계를 한국시간 기준으로 정확히 판정한다', () => {
  const { isWithinLuckyTicketWindow } = handler._test;
  assert.equal(isWithinLuckyTicketWindow(new Date('2026-08-08T14:59:59.999Z')), false);
  assert.equal(isWithinLuckyTicketWindow(new Date('2026-08-08T15:00:00.000Z')), true);
  assert.equal(isWithinLuckyTicketWindow(new Date('2026-08-09T14:59:59.999Z')), true);
  assert.equal(isWithinLuckyTicketWindow(new Date('2026-08-09T15:00:00.000Z')), false);
});

test('발급 시간 밖에서는 GitHub에 쓰지 않는다', async () => {
  const previousForceOpen = process.env.LUCKY_TICKET_FORCE_OPEN;
  process.env.LUCKY_TICKET_FORCE_OPEN = 'false';
  try {
    const result = await handler._test.issueLuckyTicket(
      { deviceId: 'too-early' },
      new Date('2026-08-08T14:59:59.999Z')
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 200);
    assert.equal(result.error, 'ticket_not_open');
  } finally {
    process.env.LUCKY_TICKET_FORCE_OPEN = previousForceOpen;
  }
});

test('기기 식별자가 없으면 공개 오류로 거절한다', async () => {
  const result = await invoke({ body: { action: 'issue_lucky_ticket' } });
  assert.equal(result.status, 400);
  assert.equal(result.data.error, 'missing_device_id');
});

test('신규 추첨권은 번호별 원장에 한 번 써서 발급한다', async () => {
  const ledger = createLedger();
  global.fetch = ledger.fetch;
  const result = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'device-one' } });
  assert.equal(result.status, 200);
  assert.match(result.data.number, /^WJ-\d{4}$/);
  assert.notEqual(result.data.number, 'WJ-0000');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(ledger.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(ledger.files.size, 1);
  const stored = JSON.parse([...ledger.files.values()][0]);
  assert.equal(stored.number, result.data.number);
  assert.equal(stored.ticketId, result.data.number.slice(3));
  assert.match([...ledger.files.keys()][0], new RegExp(`tickets/by-number/${result.data.number}\\.json$`));
});

test('같은 기기의 순차 요청은 기존 번호를 반환한다', async () => {
  const ledger = createLedger();
  global.fetch = ledger.fetch;
  const first = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'same-device' } });
  const second = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'same-device' } });
  assert.equal(first.data.number, second.data.number);
  assert.equal(second.data.duplicate, true);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.calls.filter(call => call.method === 'PUT').length, 1);
});

test('같은 기기의 동시 요청 20개를 한 번호로 합친다', async () => {
  const ledger = createLedger();
  global.fetch = ledger.fetch;
  const results = await Promise.all(Array.from({ length: 20 }, () => invoke({
    body: { action: 'issue_lucky_ticket', deviceId: 'concurrent-device' }
  })));
  assert.equal(new Set(results.map(result => result.data.number)).size, 1);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.calls.filter(call => call.method === 'PUT').length, 1);
});

test('서로 다른 기기 75개를 쓰기 제한 안에서 중복 없이 발급한다', async () => {
  const ledger = createLedger();
  global.fetch = ledger.fetch;
  const results = await Promise.all(Array.from({ length: 75 }, (_, index) => invoke({
    body: { action: 'issue_lucky_ticket', deviceId: `guest-${index}` }
  })));
  assert.equal(results.filter(result => result.status === 200).length, 75);
  assert.equal(new Set(results.map(result => result.data.number)).size, 75);
  assert.equal(ledger.files.size, 75);
  assert.ok(ledger.calls.filter(call => call.method === 'PUT').length >= 75);
  assert.equal(ledger.calls.some(call => call.method === 'POST' || call.method === 'PATCH'), false);
});

test('서로 다른 서버 인스턴스의 같은 기기 동시 요청도 영구 원장 한 번호로 수렴한다', async () => {
  const ledger = createLedger({ synchronizeFirstFileReads: true });
  global.fetch = ledger.fetch;
  const firstHandler = freshHandler();
  const secondHandler = freshHandler();
  const results = await Promise.all([
    invoke({ target: firstHandler, body: { action: 'issue_lucky_ticket', deviceId: 'multi-instance-device' } }),
    invoke({ target: secondHandler, body: { action: 'issue_lucky_ticket', deviceId: 'multi-instance-device' } })
  ]);
  assert.equal(results.every(result => result.status === 200), true);
  assert.equal(new Set(results.map(result => result.data.number)).size, 1);
  assert.equal(ledger.files.size, 1);
});

test('서로 다른 기기가 첫 번호에서 충돌해도 다음 번호로 각각 발급한다', async () => {
  const ledger = createLedger({ synchronizeFirstFileReads: true });
  global.fetch = ledger.fetch;
  const [firstDevice, secondDevice] = findCollidingDeviceIds();
  const results = await Promise.all([
    invoke({ target: freshHandler(), body: { action: 'issue_lucky_ticket', deviceId: firstDevice } }),
    invoke({ target: freshHandler(), body: { action: 'issue_lucky_ticket', deviceId: secondDevice } })
  ]);
  assert.equal(results.every(result => result.status === 200), true);
  assert.equal(new Set(results.map(result => result.data.number)).size, 2);
  assert.equal(ledger.files.size, 2);
});

test('GitHub 발급 한도 응답은 재시도 시간을 포함해 안내한다', async () => {
  global.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'GET') return response(200, []);
    return response(429, { message: 'rate limited' }, { 'Retry-After': '60' });
  };
  const result = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'rate-limited-device' } });
  assert.equal(result.status, 503);
  assert.equal(result.data.error, 'ticket_busy');
  assert.equal(result.data.retryAfterSeconds, 60);
});

test('GitHub가 응답하지 않으면 제한시간 뒤 재시도 가능한 오류를 반환한다', async () => {
  global.fetch = (_url, options = {}) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const startedAt = Date.now();
  const result = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'timeout-device' } });
  assert.equal(result.status, 503);
  assert.equal(result.data.error, 'ticket_busy');
  assert.ok(Date.now() - startedAt < 500);
});

test('GitHub 성공 응답 본문이 끊겨도 재시도 가능한 오류를 반환한다', async () => {
  global.fetch = async (url, options = {}) => {
    if ((options.method || 'GET') === 'GET') return response(404, {});
    return {
      ok: true,
      status: 201,
      headers: new Headers(),
      async json() { throw new TypeError('stream disconnected'); }
    };
  };
  const result = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'stream-error-device' } });
  assert.equal(result.status, 503);
  assert.equal(result.data.error, 'ticket_busy');
});

test('원장 201 응답 본문이 끊겨도 같은 요청에서 이미 만든 번호를 복구한다', async () => {
  const ledger = createLedger({ disconnectFirstPutBodyAfterPersist: true });
  global.fetch = ledger.fetch;
  const result = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'recover-device' } });
  assert.equal(result.status, 200);
  assert.match(result.data.number, /^WJ-\d{4}$/);
  assert.equal(ledger.files.size, 1);
  assert.equal(result.data.duplicate, true);
});

test('원장 branch 충돌 뒤 파일이 없으면 같은 번호 쓰기를 재시도한다', async () => {
  const ledger = createLedger({ conflictFirstPut: true });
  global.fetch = ledger.fetch;
  const result = await invoke({ body: { action: 'issue_lucky_ticket', deviceId: 'branch-conflict-device' } });
  assert.equal(result.status, 200);
  assert.match(result.data.number, /^WJ-\d{4}$/);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.calls.filter(call => call.method === 'PUT').length, 2);
});
