async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const failures = [];
  const originalPostWeddingApi = window.postWeddingApi;
  const originalFetch = window.fetch;
  const originalConsoleError = console.error;
  const originalSetItem = Storage.prototype.setItem;
  const originalTimeout = typeof luckyTicketRequestTimeoutMs === 'number'
    ? luckyTicketRequestTimeoutMs
    : null;
  const originalTicket = localStorage.getItem(LUCKY_TICKET_KEY);
  const originalDevice = localStorage.getItem(LUCKY_DEVICE_KEY);

  const expireCookie = name => {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  };
  const clearTicket = () => {
    removeLuckyStorage(LUCKY_TICKET_KEY);
    renderLuckyTicket(null);
  };
  const displayedNumber = () => {
    const digits = Array.from(document.querySelectorAll('#ticket-number .ticket-reel-digit--current'))
      .map(element => element.textContent).join('');
    return `WJ-${digits}`;
  };
  const restore = () => {
    window.postWeddingApi = originalPostWeddingApi;
    window.fetch = originalFetch;
    console.error = originalConsoleError;
    Storage.prototype.setItem = originalSetItem;
    if (originalTimeout !== null) luckyTicketRequestTimeoutMs = originalTimeout;
    if (originalTicket === null) localStorage.removeItem(LUCKY_TICKET_KEY);
    else localStorage.setItem(LUCKY_TICKET_KEY, originalTicket);
    if (originalDevice === null) localStorage.removeItem(LUCKY_DEVICE_KEY);
    else localStorage.setItem(LUCKY_DEVICE_KEY, originalDevice);
    expireCookie(LUCKY_TICKET_KEY);
    expireCookie(LUCKY_DEVICE_KEY);
    renderLuckyTicket(getLuckyTicket());
    if (typeof closeModal === 'function') closeModal();
  };

  console.error = () => {};
  const deviceSeededOnLoad = Boolean(localStorage.getItem(LUCKY_DEVICE_KEY));
  if (!deviceSeededOnLoad) failures.push('device id was not seeded when the page loaded');

  clearTicket();
  window.postWeddingApi = async () => {
    const error = new Error('ticket_not_open');
    error.status = 200;
    throw error;
  };
  await issueLuckyTicket();
  if (document.querySelector('#modal-title').textContent !== '8월 9일 당일에 추첨권을 받을 수 있어요') {
    failures.push('server closed response did not show the wedding-day message');
  }

  clearTicket();
  let requestCount = 0;
  window.postWeddingApi = async () => {
    requestCount += 1;
    await sleep(80);
    return {
      ok: true,
      number: 'WJ-0123',
      ticketId: '123',
      issuedAt: '2026-08-09T05:30:00.000Z'
    };
  };
  await Promise.all([issueLuckyTicket(), issueLuckyTicket()]);
  const issuedNumber = displayedNumber();
  const savedNumber = getLuckyTicket() && getLuckyTicket().number;
  if (requestCount !== 1) failures.push(`rapid click requests: ${requestCount}`);
  if (issuedNumber !== 'WJ-0123' || savedNumber !== 'WJ-0123') {
    failures.push(`issued number was not persisted: ${issuedNumber}/${savedNumber}`);
  }
  if (document.querySelector('#ticket-button').disabled) failures.push('button stayed disabled after success');

  // The server is the date authority; a successful ticket must survive a client-clock mismatch.
  const otherTabTicket = {
    number: 'WJ-0456',
    ticketId: '456',
    issuedAt: '2026-07-13T06:00:00.000Z',
    source: 'endpoint'
  };
  localStorage.setItem(LUCKY_TICKET_KEY, JSON.stringify(otherTabTicket));
  window.dispatchEvent(new StorageEvent('storage', {
    key: LUCKY_TICKET_KEY,
    newValue: JSON.stringify(otherTabTicket),
    storageArea: localStorage
  }));
  await sleep(30);
  const syncedNumber = displayedNumber();
  if (syncedNumber !== 'WJ-0456') failures.push(`other tab ticket was not rendered: ${syncedNumber}`);

  clearTicket();
  window.postWeddingApi = async () => ({
    ok: true,
    number: 'WJ-0789',
    ticketId: '789',
    issuedAt: '2026-08-09T06:30:00.000Z'
  });
  Storage.prototype.setItem = function blockedStorage() { throw new Error('storage blocked'); };
  await issueLuckyTicket();
  Storage.prototype.setItem = originalSetItem;
  const fallbackNumber = getLuckyTicket() && getLuckyTicket().number;
  if (displayedNumber() !== 'WJ-0789' || fallbackNumber !== 'WJ-0789') {
    failures.push('storage failure lost the issued ticket');
  }

  clearTicket();
  if (originalTimeout === null) {
    failures.push('ticket request timeout is missing');
  } else {
    luckyTicketRequestTimeoutMs = 40;
    window.postWeddingApi = originalPostWeddingApi;
    window.fetch = (_url, options = {}) => new Promise((resolve, reject) => {
      if (!options.signal) return;
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    const timeoutStartedAt = performance.now();
    await issueLuckyTicket();
    const timeoutDuration = performance.now() - timeoutStartedAt;
    if (timeoutDuration > 1000) failures.push(`timeout recovery took ${Math.round(timeoutDuration)}ms`);
    if (document.querySelector('#ticket-button').disabled) failures.push('button stayed disabled after timeout');
    if (document.querySelector('#modal-title').textContent !== '접속이 몰리고 있어요') {
      failures.push('timeout did not show the retry message');
    }
  }

  clearTicket();
  const unissuedMachine = document.querySelector('#ticket-number');
  const unissuedNumber = displayedNumber();
  if (unissuedNumber !== 'WJ-0000') failures.push(`unissued number looked final: ${unissuedNumber}`);
  if (unissuedMachine.getAttribute('aria-live') !== 'off') failures.push('unissued spinner remained aria-live');

  const report = {
    deviceSeededOnLoad,
    requestCount,
    issuedNumber,
    savedNumber,
    syncedNumber,
    fallbackNumber,
    unissuedNumber,
    failures
  };
  restore();
  if (failures.length) throw new Error(JSON.stringify(report));
  return report;
}
