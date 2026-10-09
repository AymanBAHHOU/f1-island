// F1 headlines from public RSS feeds, merged and newest first.

const FEEDS = [
  { source: 'Motorsport.com', url: 'https://www.motorsport.com/rss/f1/news/' },
  { source: 'The Race', url: 'https://www.the-race.com/category/formula-1/feed/' },
  { source: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
];
const MAX_ITEMS = 12;
const TTL = 15 * 60e3;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
};

function clean(raw) {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFeed(xml, source) {
  const items = [];
  for (const [block] of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const tag = (name) => {
      const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
      return m ? clean(m[1]) : '';
    };
    const title = tag('title');
    const link = tag('link');
    const date = Date.parse(tag('pubDate'));
    if (!title || !/^https?:\/\//.test(link)) continue;
    let summary = tag('description');
    if (summary.length > 320) summary = `${summary.slice(0, 317).replace(/\s+\S*$/, '')}…`;
    items.push({ title, link, source, date: Number.isFinite(date) ? new Date(date).toISOString() : null, summary });
  }
  return items;
}

let cache = null;

async function getNews() {
  if (cache && Date.now() - cache.at < TTL) return cache.items;
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'F1Island/0.1' } });
      if (!res.ok) throw new Error(`${f.source} ${res.status}`);
      return parseFeed(await res.text(), f.source);
    })
  );
  const seen = new Set();
  const items = results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .filter((i) => {
      const key = i.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ITEMS);
  if (!items.length && cache) return cache.items; // stale headlines beat none
  if (!items.length) throw new Error('No headlines available right now');
  cache = { at: Date.now(), items };
  return items;
}

// Only links we handed out may be opened.
const isKnownLink = (url) => !!cache?.items.some((i) => i.link === url);

module.exports = { getNews, isKnownLink };
