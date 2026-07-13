const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

function createAppsScriptContext({ quota = 100 } = {}) {
  const properties = new Map([['SOLO_NOTIFICATION_SECRET', 'a'.repeat(32)]]);
  const emails = [];
  const scriptProperties = {
    getProperty(key) { return properties.get(key) || null; },
    setProperty(key, value) { properties.set(key, String(value)); },
    deleteProperty(key) { properties.delete(key); }
  };
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    MailApp: {
      getRemainingDailyQuota: () => quota,
      sendEmail(message) { emails.push(message); }
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest(_algorithm, value) {
        return [...crypto.createHash('sha256').update(String(value)).digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      },
      getUuid: () => 'generated-id'
    }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../apps-script/Code.js'), 'utf8'), context);
  return {
    emails,
    notify(payload) {
      context.__payload = payload;
      return vm.runInContext('notifySoloApplication_(__payload)', context);
    }
  };
}

function notification(overrides = {}) {
  return {
    notificationSecret: 'a'.repeat(32),
    receivedAt: '2026-06-14T12:34:56.000Z',
    application: {
      applicationId: 'solo-1',
      name: '홍길동',
      age: 31,
      gender: '남성',
      side: '신랑측',
      job: '개발자',
      mbti: 'ENFP',
      intro: '좋은 인연을 만나고 싶습니다.',
      contact: '010-1234-5678',
      alias: '길동',
      source: 'wedding-invitation',
      userAgent: 'test'
    },
    ...overrides
  };
}

test('나는솔로 알림은 인증 비밀값이 다르면 발송하지 않는다', () => {
  const app = createAppsScriptContext();
  assert.throws(
    () => app.notify(notification({ notificationSecret: 'wrong-secret' })),
    /unauthorized_notification/
  );
  assert.equal(app.emails.length, 0);
});

test('나는솔로 알림은 고정 수신자로 한 번만 발송하고 신청 내용을 포함한다', () => {
  const app = createAppsScriptContext();
  const first = app.notify(notification());
  const second = app.notify(notification());

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(app.emails.length, 1);
  assert.equal(app.emails[0].to, 'kham0126@gmail.com');
  assert.match(app.emails[0].subject, /나는 SOLO/);
  assert.match(app.emails[0].body, /홍길동/);
  assert.match(app.emails[0].body, /010-1234-5678/);
});

test('메일 일일 한도가 없으면 발송 완료로 기록하지 않는다', () => {
  const app = createAppsScriptContext({ quota: 0 });
  assert.throws(() => app.notify(notification()), /mail_quota_exhausted/);
  assert.equal(app.emails.length, 0);
});
