async () => {
  const root = document.scrollingElement;
  root.scrollTop = 0;
  await new Promise(resolve => setTimeout(resolve, 300));
  const maxScroll = Math.max(0, root.scrollHeight - innerHeight);
  const duration = 4500;
  const intervals = [];
  let start = 0;
  let last = 0;

  return new Promise(resolve => requestAnimationFrame(function step(now) {
    if (!start) {
      start = now;
      last = now;
    } else {
      intervals.push(now - last);
      last = now;
    }

    const progress = Math.min((now - start) / duration, 1);
    root.scrollTop = maxScroll * progress;
    if (progress < 1) {
      requestAnimationFrame(step);
      return;
    }

    const sorted = [...intervals].sort((a, b) => a - b);
    const percentile = value => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] || 0;
    resolve({
      frames: intervals.length,
      p50: Number(percentile(0.5).toFixed(2)),
      p95: Number(percentile(0.95).toFixed(2)),
      max: Number(Math.max(...intervals).toFixed(2)),
      over33: intervals.filter(value => value > 33).length,
      over50: intervals.filter(value => value > 50).length
    });
  }));
}
