const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.GITHUB_DATA_TOKEN = 'test-token';
process.env.WEDDING_DATA_REPO = 'owner/repo';
process.env.LUCKY_TICKET_FORCE_OPEN = 'true';
process.env.GITHUB_REQUEST_TIMEOUT_MS = '30';
process.env.SOLO_NOTIFICATION_URL = 'https://script.google.com/macros/s/test-notifier/exec';
process.env.SOLO_NOTIFICATION_SECRET = 'test-notification-secret';
process.env.SOLO_NOTIFICATION_TIMEOUT_MS = '30';
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
  synchronizeFirstFileReads = false,
  notificationStatus = 200,
  notificationStatuses = []
} = {}) {
  const files = new Map();
  const calls = [];
  const notifications = [];
  let disconnectedPut = false;
  let conflictedPut = false;
  let synchronizedFileReads = 0;
  const fileReadWaiters = [];

  return {
    files,
    calls,
    notifications,
    async fetch(url, options = {}) {
      const method = options.method || 'GET';
      const parsed = new URL(url);
      calls.push({ method, path: parsed.pathname, search: parsed.search });

      if (parsed.hostname === 'script.google.com') {
        notifications.push(JSON.parse(options.body));
        const currentNotificationStatus = notificationStatuses.length
          ? notificationStatuses.shift()
          : notificationStatus;
        return response(currentNotificationStatus, currentNotificationStatus === 200
          ? { ok: true, duplicate: false }
          : { ok: false, error: 'notification_failed' });
      }

      if (method === 'GET' && parsed.pathname.endsWith('/commits')) {
        const commits = [...files.values()].map(content => {
          const record = JSON.parse(content);
          return {
            commit: {
              author: { date: record.receivedAt },
              message: `Add solo application ${record.application.applicationId}`
            }
          };
        }).sort((left, right) => (
          Date.parse(right.commit.author.date) - Date.parse(left.commit.author.date)
        ));
        return response(200, commits);
      }

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

function soloApplication(overrides = {}) {
  return {
    action: 'submit_solo_application',
    id: 'solo-application-1',
    name: '홍길동',
    age: 31,
    gender: '남성',
    side: '신랑측',
    job: '개발자',
    mbti: 'ENFP',
    intro: '좋은 인연을 만나고 싶습니다.',
    contact: '010-1234-5678',
    alias: '길동',
    recipient: 'attacker@example.com',
    ...overrides
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

async function invoke({ method = 'POST', origin = PUBLIC_ORIGIN, body = {}, query = {}, target = handler } = {}) {
  const req = { method, headers: { origin, referer: `${origin}/` }, body, query };
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

test('로컬 화면은 로컬 API를 사용해 운영 데이터 변경 없이 검증한다', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const start = html.indexOf("const prefersReducedMotion = window.matchMedia");
  const end = html.indexOf('let luckyTicketRequestTimeoutMs', start);
  const context = vm.createContext({
    window: {
      location: { hostname: '127.0.0.1' },
      matchMedia: () => ({ matches: false })
    }
  });
  vm.runInContext(html.slice(start, end), context);
  assert.equal(vm.runInContext('WEDDING_API_ENDPOINT', context), '/api/wedding');
});

test('나는솔로 응답이 끊긴 뒤 같은 내용을 재시도하면 같은 신청 ID를 유지한다', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const start = html.indexOf("const SOLO_PENDING_APPLICATION_KEY = 'wedding-solo-pending-application';");
  const end = html.indexOf('function syncRadioLabels()', start);
  assert.ok(start > -1 && end > start);

  const values = new Map();
  let uuid = 0;
  const context = vm.createContext({
    JSON,
    Date,
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    window: { crypto: { randomUUID: () => `solo-id-${++uuid}` } }
  });
  vm.runInContext(html.slice(start, end), context);
  context.__draft = { name: '홍길동', age: 31, intro: '안녕하세요' };

  const first = vm.runInContext('getOrCreatePendingSoloApplication(__draft)', context);
  const retry = vm.runInContext('getOrCreatePendingSoloApplication(__draft)', context);
  assert.equal(first.id, 'solo-id-1');
  assert.equal(retry.id, first.id);

  vm.runInContext('clearPendingSoloApplication(__draft, "solo-id-1")', context);
  const afterSuccess = vm.runInContext('getOrCreatePendingSoloApplication(__draft)', context);
  assert.equal(afterSuccess.id, 'solo-id-2');
});

test('다른 브라우저에서도 서버에 저장된 나는솔로 공개 프로필을 카드에 표시한다', async () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const start = html.indexOf("const SOLO_APPLICATIONS_KEY = 'wedding-solo-applications';");
  const end = html.indexOf('function escapeHtml(value)', start);
  assert.ok(start > -1 && end > start);

  const values = new Map();
  const context = vm.createContext({
    JSON,
    WEDDING_API_ENDPOINT: 'https://example.test/api/wedding',
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    fetch: async () => response(200, {
      ok: true,
      profiles: [{
        alias: '영수', age: 31, job: '개발자', mbti: 'ENFP', gender: '남성', side: '신랑측',
        intro: '좋은 인연을 만나고 싶습니다.', tagline: '행복한 인연을 기다리는'
      }]
    }),
    renderSoloCards() {}
  });
  vm.runInContext(html.slice(start, end), context);

  await vm.runInContext('loadSoloProfiles()', context);
  const profiles = vm.runInContext('getSoloList()', context);
  assert.equal(profiles[0].alias, '영수');
  assert.equal(profiles[0].job, '개발자');
  assert.equal(profiles[0].name, undefined);
  assert.equal(profiles[0].contact, undefined);
});

test('서버 공개 목록이 비어 있으면 브라우저 임시 신청 대신 기본 카드만 표시한다', async () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const start = html.indexOf("const SOLO_APPLICATIONS_KEY = 'wedding-solo-applications';");
  const end = html.indexOf('function escapeHtml(value)', start);
  const values = new Map([[
    'wedding-solo-applications',
    JSON.stringify([{ alias: '로컬', age: 31, job: '개발자', intro: '임시 신청', gender: '남성', side: '신랑측' }])
  ]]);
  const context = vm.createContext({
    JSON,
    WEDDING_API_ENDPOINT: 'https://example.test/api/wedding',
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    fetch: async () => response(200, { ok: true, profiles: [] }),
    renderSoloCards() {}
  });
  vm.runInContext(html.slice(start, end), context);

  assert.equal(vm.runInContext('getSoloList()[0].alias', context), '로컬');
  assert.equal(await vm.runInContext('loadSoloProfiles()', context), true);
  assert.equal(vm.runInContext('getSoloList()[0].alias', context), '영식');
});

test('서버 공개 목록 조회가 실패하면 브라우저 임시 신청 카드를 유지한다', async () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const start = html.indexOf("const SOLO_APPLICATIONS_KEY = 'wedding-solo-applications';");
  const end = html.indexOf('function escapeHtml(value)', start);
  const values = new Map([[
    'wedding-solo-applications',
    JSON.stringify([{ alias: '로컬', age: 31, job: '개발자', intro: '임시 신청', gender: '남성', side: '신랑측' }])
  ]]);
  const context = vm.createContext({
    JSON,
    WEDDING_API_ENDPOINT: 'https://example.test/api/wedding',
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key)
    },
    fetch: async () => response(503, { ok: false }),
    renderSoloCards() {}
  });
  vm.runInContext(html.slice(start, end), context);

  assert.equal(await vm.runInContext('loadSoloProfiles()', context), false);
  assert.equal(vm.runInContext('getSoloList()[0].alias', context), '로컬');
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

test('나는솔로 공개 목록은 서버 저장 신청을 최신순으로 제한하고 개인정보를 제외한다', async () => {
  const ledger = createLedger();
  const firstApplication = {
    applicationId: 'solo-public-1', name: '홍길동', age: 31, gender: '남성', side: '신랑측',
    job: '개발자', mbti: 'ENFP', intro: '좋은 인연을 만나고 싶습니다.', contact: '010-1234-5678',
    alias: '영수', source: 'wedding-invitation', userAgent: 'private-agent'
  };
  const secondApplication = {
    ...firstApplication,
    applicationId: 'solo-public-2', name: '김개인', contact: '010-9876-5432', alias: '옥순', age: 29
  };
  ledger.files.set('solo/2026-06-14/solo-public-1.json', JSON.stringify({
    receivedAt: '2026-06-14T10:00:00.000Z', application: firstApplication
  }));
  ledger.files.set('solo/2026-07-14/solo-public-2.json', JSON.stringify({
    receivedAt: '2026-07-14T10:00:00.000Z', application: secondApplication
  }));
  ledger.files.set('solo/2026-07-15/solo-public-2.json', JSON.stringify({
    receivedAt: '2026-07-15T10:00:00.000Z',
    application: { ...secondApplication, alias: '옥순 최신' }
  }));
  global.fetch = ledger.fetch;

  const result = await invoke({
    method: 'GET',
    query: { action: 'list_solo_profiles' }
  });

  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.profiles.map(profile => profile.alias), ['옥순 최신', '영수']);
  assert.deepEqual(Object.keys(result.data.profiles[0]).sort(), [
    'age', 'alias', 'gender', 'intro', 'job', 'mbti', 'side', 'tagline'
  ]);
  assert.equal(JSON.stringify(result.data).includes('김개인'), false);
  assert.equal(JSON.stringify(result.data).includes('010-9876-5432'), false);
  assert.equal(JSON.stringify(result.data).includes('private-agent'), false);
  assert.match(result.headers['cache-control'], /^public, max-age=60/);
});

test('나는솔로 공개 목록 원장 조회 장애는 개인정보 없는 재시도 오류로 응답한다', async () => {
  global.fetch = async () => response(503, { message: 'private upstream detail' });

  const result = await invoke({
    method: 'GET',
    query: { action: 'list_solo_profiles' }
  });

  assert.equal(result.status, 503);
  assert.deepEqual(result.data, { ok: false, error: 'profile_list_unavailable' });
  assert.equal(JSON.stringify(result.data).includes('private upstream detail'), false);
});

test('나는솔로 공개 목록의 개별 신청 조회 장애도 빈 목록으로 숨기지 않는다', async () => {
  global.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/commits')) {
      return response(200, [{
        commit: {
          author: { date: '2026-07-14T10:00:00.000Z' },
          message: 'Add solo application solo-public-1'
        }
      }]);
    }
    if (parsed.pathname.includes('/contents/')) {
      return response(503, { message: 'private contents failure' });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  };

  const result = await invoke({
    method: 'GET',
    query: { action: 'list_solo_profiles' }
  });

  assert.equal(result.status, 503);
  assert.deepEqual(result.data, { ok: false, error: 'profile_list_unavailable' });
});

test('허용하지 않은 출처는 GitHub 호출 전에 거절한다', async () => {
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return response(500, {}); };
  const result = await invoke({ origin: 'https://example.com', body: { action: 'issue_lucky_ticket', deviceId: 'blocked' } });
  assert.equal(result.status, 403);
  assert.equal(fetchCalls, 0);
});

test('신규 나는솔로 신청은 원장 저장 뒤 고정 수신자 알림을 한 번 요청한다', async () => {
  const ledger = createLedger();
  global.fetch = ledger.fetch;

  const result = await invoke({ body: soloApplication() });

  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.duplicate, false);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.notifications.length, 1);
  assert.equal(ledger.notifications[0].action, 'notify_solo_application');
  assert.equal(ledger.notifications[0].notificationSecret, 'test-notification-secret');
  assert.equal(ledger.notifications[0].application.applicationId, 'solo-application-1');
  assert.equal(ledger.notifications[0].application.recipient, undefined);
});

test('같은 나는솔로 신청 ID를 다시 보내면 저장은 늘리지 않고 멱등 알림을 재확인한다', async () => {
  const ledger = createLedger();
  global.fetch = ledger.fetch;

  const first = await invoke({ body: soloApplication() });
  const second = await invoke({ body: soloApplication() });

  assert.equal(first.data.duplicate, false);
  assert.equal(second.data.duplicate, true);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.notifications.length, 2);
});

test('메일 서버가 실패해도 저장된 나는솔로 신청은 성공으로 응답한다', async () => {
  const ledger = createLedger({ notificationStatus: 503 });
  global.fetch = ledger.fetch;

  const result = await invoke({ body: soloApplication() });

  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.duplicate, false);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.notifications.length, 1);
});

test('첫 메일 요청 실패 뒤 같은 신청을 재전송하면 저장 원본으로 알림을 복구한다', async () => {
  const ledger = createLedger({ notificationStatuses: [503, 200] });
  global.fetch = ledger.fetch;

  const first = await invoke({ body: soloApplication() });
  const second = await invoke({
    body: soloApplication({ name: '변조된 이름', recipient: 'attacker@example.com' })
  });

  assert.equal(first.data.duplicate, false);
  assert.equal(second.data.duplicate, true);
  assert.equal(ledger.files.size, 1);
  assert.equal(ledger.notifications.length, 2);
  assert.equal(ledger.notifications[1].application.name, '홍길동');
  assert.equal(ledger.notifications[1].application.recipient, undefined);
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
