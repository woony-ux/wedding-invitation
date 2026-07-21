const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = html.match(
  /\/\* ── 계좌 아코디언 · 복사 [\s\S]*?<\/script>/
);

assert.ok(scriptMatch, '계좌 복사 스크립트를 찾을 수 있어야 합니다.');
const accountScript = scriptMatch[0].replace(/<\/script>$/, '');

function createButton() {
  const classes = new Set();
  return {
    textContent: '복사',
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value)
    }
  };
}

function createContext({ writeText, execCommand }) {
  const modalCalls = [];
  const bodyChildren = [];
  const context = {
    navigator: writeText ? { clipboard: { writeText } } : {},
    document: {
      createElement: () => ({
        value: '',
        style: {},
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {}
      }),
      body: {
        appendChild: node => bodyChildren.push(node),
        removeChild: node => bodyChildren.splice(bodyChildren.indexOf(node), 1)
      },
      execCommand
    },
    setTimeout() {},
    showModal: (...args) => modalCalls.push(args)
  };
  vm.createContext(context);
  vm.runInContext(accountScript, context);
  return { context, modalCalls, bodyChildren };
}

test('최신 복사 방식이 성공하면 복사됨을 표시한다', async () => {
  const { context, modalCalls } = createContext({
    writeText: async () => {},
    execCommand: () => false
  });
  const button = createButton();

  await context.copyAcc(button, '123456789');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(button.textContent, '복사됨');
  assert.equal(button.classList.contains('copied'), true);
  assert.equal(modalCalls.length, 0);
});

test('최신 복사가 거부돼도 대체 복사가 성공하면 복사됨을 표시한다', async () => {
  const { context, modalCalls } = createContext({
    writeText: async () => { throw new Error('permission denied'); },
    execCommand: command => command === 'copy'
  });
  const button = createButton();

  await context.copyAcc(button, '123456789');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(button.textContent, '복사됨');
  assert.equal(button.classList.contains('copied'), true);
  assert.equal(modalCalls.length, 0);
});

test('최신 복사 기능이 없는 브라우저에서도 대체 복사를 사용한다', async () => {
  const { context, modalCalls } = createContext({
    writeText: null,
    execCommand: command => command === 'copy'
  });
  const button = createButton();

  await context.copyAcc(button, '123456789');

  assert.equal(button.textContent, '복사됨');
  assert.equal(button.classList.contains('copied'), true);
  assert.equal(modalCalls.length, 0);
});

test('모든 복사 방식이 실패하면 성공으로 표시하지 않고 직접 복사를 안내한다', async () => {
  const { context, modalCalls, bodyChildren } = createContext({
    writeText: async () => { throw new Error('permission denied'); },
    execCommand: () => false
  });
  const button = createButton();

  await context.copyAcc(button, '123456789');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(button.textContent, '다시 복사');
  assert.equal(button.classList.contains('copied'), false);
  assert.deepEqual(modalCalls, [[
    'icon-message',
    '계좌번호를 복사하지 못했어요',
    '123456789\n길게 눌러 직접 복사해 주세요.'
  ]]);
  assert.equal(bodyChildren.length, 0);
});
