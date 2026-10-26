import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { validatePng } from './poster-files.mjs';

// One shared deadline for all pages: the next half-hour batch is never held up
// by an unbounded deployment wait. Environment overrides may only shorten it.
const bounded = (name, fallback, min) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(Math.min(value, fallback)) : fallback;
};
export async function waitPublicPosters(pages) {
  const budget = bounded('POSTER_WAIT_MS', 360000, 1);
  const interval = bounded('POSTER_POLL_MS', 15000, 1);
  const timeout = bounded('POSTER_REQUEST_TIMEOUT_MS', 10000, 1);
  const deadline = Date.now() + budget;
  const pending = [...pages], ready = [];
  let attempt = 0;
  while (pending.length && Date.now() < deadline) {
    attempt++;
    const results = await Promise.all(pending.map(async page => {
      try {
        const response = await fetch(page.url, {
          headers: { 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now()))),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('公开响应不是 image/png');
        const bytes = Buffer.from(await response.arrayBuffer());
        validatePng(bytes);
        if (createHash('sha256').update(bytes).digest('hex') !== page.hash) throw new Error('公开图片与本班本地版本不符');
        console.log(`[notify] 公开海报已就绪 ${page.filename} attempt=${attempt}`);
        return true;
      } catch (error) {
        page.publicError = error.message;
        console.warn(`[notify] 等待公开海报 ${page.filename} attempt=${attempt}: ${error.message}`);
        return false;
      }
    }));
    for (let i = pending.length - 1; i >= 0; i--) if (results[i]) ready.push(...pending.splice(i, 1));
    if (pending.length && Date.now() < deadline) await sleep(Math.min(interval, deadline - Date.now()));
  }
  if (pending.length) console.warn(`[notify] 公开海报等待结束 budget=${budget}ms，${pending.length} 页改发文字`);
  return { ready, missing: pending };
}
