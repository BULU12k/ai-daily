import { parseHTML } from 'linkedom';

const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const datePattern = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(\d{4})\b/i;
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function parseOfficialDescription(html) {
  const { document } = parseHTML(html);
  const description = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || document.querySelector('meta[name="description"]')?.getAttribute('content');
  if (!description?.trim()) throw new Error('官方文章没有可用描述');
  return description.replace(/\s+/g, ' ').trim();
}

// These official lists expose calendar dates, not publication instants. Use UTC
// midnight consistently (never fetch time); the 24h gate can exclude late-day
// articles early. Reject impossible/future dates instead of allowing JS rollover.
function publicationDate(raw, now) {
  const m = raw.match(datePattern);
  if (!m) return null;
  const month = months.indexOf(m[1].slice(0, 3).toLowerCase());
  const year = Number(m[3]), day = Number(m[2]);
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day || d.getTime() > now) return null;
  return d.toISOString();
}

function articleUrl(raw, kind) {
  try {
    const origin = kind === 'anthropic' ? 'https://www.anthropic.com' : 'https://ai.meta.com';
    const u = new URL(raw, origin);
    // Anthropic's own news cards also link to root-level Claude launches and
    // /features articles. This is used only inside its dated news-card region.
    const articlePath = kind === 'anthropic'
      ? /^\/(?:news\/[a-z0-9-]+|features\/[a-z0-9-]+|claude-[a-z0-9-]+)\/?$/
      : /^\/blog\/[a-z0-9-]+\/?$/;
    if (u.origin !== origin || !articlePath.test(u.pathname)) return null;
    if (kind === 'anthropic' && /\/(product|announcements|policy|safeguards|research|company|economic-research)\/?$/.test(u.pathname)) return null;
    u.search = ''; u.hash = '';
    return u.href;
  } catch { return null; }
}

/** Parse only official article cards; throw on an unrecognized/empty page. */
export function parseOfficialNews(html, kind, { now = Date.now(), warn = () => {} } = {}) {
  if (!['anthropic', 'meta'].includes(kind)) throw new Error(`未知官方来源: ${kind}`);
  const { document } = parseHTML(html);
  const items = new Map();
  let candidates = 0, missingDate = 0;
  const add = (title, link, dateRaw, desc = '') => {
    if (!title || !link || items.has(link)) return;
    candidates++;
    const date = publicationDate(dateRaw, now);
    if (!date) { missingDate++; warn(`官方文章日期缺失/异常/未来，不进入时效候选: ${link}`); }
    items.set(link, { title, link, id: link, date, desc, datePrecision: 'day' });
  };
  if (kind === 'anthropic') {
    for (const a of document.querySelectorAll('a[class*="details-title"][href]')) {
      const region = a.closest('[role="region"]');
      if (!region) continue;
      add(text(a), articleUrl(a.getAttribute('href'), kind), text(region.querySelector('[class*="details-meta"]')?.firstElementChild), text(region.querySelector('[class*="details-description"]')));
    }
  } else {
    // Official server-rendered hero, Latest News and ordinary list cards.
    // Read dates only inside each card, never from a neighbouring card.
    for (const card of document.querySelectorAll('._amc_, ._amdc, ._8xiz')) {
      const anchors = [...card.querySelectorAll('a[href]')].filter(a => articleUrl(a.getAttribute('href'), kind));
      const links = new Set(anchors.map(a => articleUrl(a.getAttribute('href'), kind)));
      if (links.size !== 1) continue;
      // Ordinary cards put a category h4 before the article h4. Select the
      // article container for each layout; never fall back to the first heading.
      const titleNode = card.matches('._8xiz')
        ? card.querySelector('._8wpz h1, ._8wpz h2, ._8wpz h3, ._8wpz h4')
        : card.querySelector(card.matches('._amc_') ? '._amd1 a[href]' : '._amde a[href]');
      const title = text(titleNode);
      const dates = [...card.querySelectorAll('time,p,div')].filter(n => !n.children.length && datePattern.test(text(n)));
      add(title, [...links][0], dates.length === 1 ? text(dates[0]) : '');
    }
  }
  if (!candidates) throw new Error(`官方 ${kind} 页面未识别文章卡片（空页面或结构变化）`);
  if (missingDate === candidates) throw new Error(`官方 ${kind} 全部 ${candidates} 条文章缺少有效发布日期`);
  return [...items.values()];
}
