async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const scrollRoot = document.documentElement;
  const previousScrollBehavior = scrollRoot.style.scrollBehavior;
  scrollRoot.style.scrollBehavior = 'auto';
  const waitFor = async (predicate, timeoutMs = 4000) => {
    const startedAt = performance.now();
    while (!predicate() && performance.now() - startedAt < timeoutMs) await sleep(50);
    return predicate();
  };
  const parseColor = value => {
    const match = String(value).match(/rgba?\(([^)]+)\)/i);
    if (!match) throw new Error(`Unsupported color: ${value}`);
    const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1];
  };
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (!alpha) return [0, 0, 0, 0];
    return [
      (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
      (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
      (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
      alpha
    ];
  };
  const luminance = color => {
    const channels = color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (foreground, background) => {
    const paintedForeground = over(foreground, background);
    const foregroundLuminance = luminance(paintedForeground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  };
  const effectiveBackground = element => {
    const chain = [];
    for (let node = element; node instanceof Element; node = node.parentElement) chain.push(node);
    let color = [255, 255, 255, 1];
    chain.reverse().forEach(node => {
      color = over(parseColor(getComputedStyle(node).backgroundColor), color);
    });
    return color;
  };
  const exactText = (container, text) => Array.from(container.querySelectorAll('*'))
    .find(element => element.textContent.trim() === text);
  const failures = [];
  const ratios = {};
  const checkContrast = (name, element, backgroundOverride, property = 'color') => {
    if (!element) {
      failures.push(`${name}: element missing`);
      return;
    }
    const foreground = parseColor(getComputedStyle(element)[property]);
    const background = backgroundOverride || effectiveBackground(element);
    const ratio = contrast(foreground, background);
    ratios[name] = Number(ratio.toFixed(2));
    if (ratio < 4.5) failures.push(`${name}: ${ratio.toFixed(2)}:1`);
  };

  const contrastTargets = [
    ['party body', '.party-text'],
    ['party emphasis', '.party-text strong'],
    ['raffle kicker', '.lucky-kicker'],
    ['raffle copy', '.lucky-copy'],
    ['prize name', '.prize-name'],
    ['prize note', '.prize-note'],
    ['prize count', '.prize-count'],
    ['ticket label', '.ticket-label'],
    ['ticket help', '.ticket-help'],
    ['profile logo', '.s-show-logo'],
    ['profile brand', '.s-brand'],
    ['profile number', '.s-avatar'],
    ['profile tagline', '.s-tagline'],
    ['profile name', '.s-name'],
    ['profile info', '.s-info'],
    ['profile mbti', '.s-mbti'],
    ['profile intro', '.s-intro'],
    ['profile section copy', '.solo-sub'],
    ['profile section emphasis', '.solo-sub strong'],
    ['carousel toggle', '#solo-carousel-toggle'],
    ['footer names', '.ft-names'],
    ['footer date', '.ft-date'],
    ['footer contact label', '.ft-contact-title'],
    ['footer call', '.btn-call'],
    ['footer hosts', '.ft-hosts'],
    ['footer signoff', '.ft-copy']
  ];
  contrastTargets.forEach(([name, selector]) => checkContrast(name, document.querySelector(selector)));

  const currentTicketDigit = document.querySelector('.ticket-reel-digit--current');
  checkContrast('ticket digit', currentTicketDigit, [255, 255, 255, 1]);

  const map = document.querySelector('.map-box');
  checkContrast('map station label', exactText(map, '청담역'), [255, 255, 255, 1], 'fill');
  checkContrast('map venue label', exactText(map, '드레스 가든'), [255, 255, 255, 1], 'fill');
  checkContrast('map walking label', exactText(map, '도보 1분'), parseColor('rgb(198, 161, 91)'), 'fill');

  window.scrollTo(0, 0);
  await sleep(350);
  const spinnerBefore = luckySpinStep;
  await sleep(650);
  const offscreenSpinnerUpdates = luckySpinStep - spinnerBefore;
  if (offscreenSpinnerUpdates !== 0) failures.push(`offscreen spinner updates: ${offscreenSpinnerUpdates}`);

  const carouselBefore = soloCarouselIndex;
  const carouselLeftBefore = document.querySelector('#solo-cards').scrollLeft;
  await sleep(2800);
  const offscreenCarouselMoves = soloCarouselIndex - carouselBefore;
  const offscreenCarouselPixels = document.querySelector('#solo-cards').scrollLeft - carouselLeftBefore;
  if (offscreenCarouselMoves !== 0 || offscreenCarouselPixels !== 0) {
    failures.push(`offscreen carousel moved: index ${offscreenCarouselMoves}, pixels ${Math.round(offscreenCarouselPixels)}`);
  }

  const grainAnimation = getComputedStyle(document.querySelector('.film-grain')).animationName;
  if (grainAnimation !== 'none') failures.push(`film grain animation: ${grainAnimation}`);

  const galleryImages = Array.from(document.querySelectorAll('.gallery-item img'));
  const synchronousDecode = galleryImages.filter(image => image.decoding !== 'async');
  if (synchronousDecode.length) failures.push(`non-async gallery decode: ${synchronousDecode.length}`);

  document.querySelector('#ticket-card').scrollIntoView({ block: 'center' });
  await sleep(350);
  const visibleSpinnerBefore = luckySpinStep;
  await sleep(500);
  const visibleSpinnerUpdates = luckySpinStep - visibleSpinnerBefore;
  if (visibleSpinnerUpdates === 0) failures.push('visible spinner did not run');
  window.scrollTo(0, 0);
  await sleep(350);
  if (luckySpinTimer !== null || document.querySelector('#ticket-number').classList.contains('is-spinning')) {
    failures.push('spinner did not stop after leaving viewport');
  }

  document.querySelector('#solo-cards').scrollIntoView({ block: 'center' });
  await sleep(350);
  const visibleCarouselStarted = await waitFor(() => soloCarouselTimer !== null);
  const visibleCarouselBefore = soloCarouselIndex;
  await sleep(2800);
  const visibleCarouselMoves = soloCarouselIndex - visibleCarouselBefore;
  if (!visibleCarouselStarted || visibleCarouselMoves === 0) failures.push('visible carousel did not run');
  window.scrollTo(0, 0);
  await sleep(350);
  if (soloCarouselTimer !== null) failures.push('carousel did not stop after leaving viewport');

  const report = {
    ratios,
    offscreenSpinnerUpdates,
    offscreenCarouselMoves,
    offscreenCarouselPixels: Math.round(offscreenCarouselPixels),
    grainAnimation,
    gridImages: galleryImages.length,
    visibleSpinnerUpdates,
    visibleCarouselMoves,
    failures
  };
  scrollRoot.style.scrollBehavior = previousScrollBehavior;
  if (failures.length) throw new Error(JSON.stringify(report));
  return report;
}
