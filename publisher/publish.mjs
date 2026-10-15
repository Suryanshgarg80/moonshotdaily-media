// Runs on GitHub Actions on a schedule, so @moonshotdaily posts even when the Mac is asleep.
// The Mac queues each day's finished posts under queue/<date>/ (queue.json + images/videos);
// GitHub's schedule can start hours late, so one run works through the whole day's queue itself:
// publish the next unpublished item, commit state/published.json (so nothing is ever posted twice,
// even if the job dies), wait GAP_MIN, repeat — stopping at LATEST_HOUR in SF. Later runs just pick up leftovers.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = 'https://graph.instagram.com/v23.0';
const { IG_USER_ID, IG_ACCESS_TOKEN, GITHUB_REPOSITORY } = process.env;
const MIN_GAP_MIN = 20;
const GAP_MIN = Number(process.env.GAP_MIN || 30);
const LATEST_HOUR = 16; // don't start new posts after 4 PM in San Francisco
const RAW = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main`;

// DRY_RUN=1 QUEUE_DATE=<folder>: builds the Instagram container (proves URLs + token work) but never publishes or records state
const DRY = process.env.DRY_RUN === '1';
const date = process.env.QUEUE_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson('state/published.json', { items: {}, last_ts: null, events: [] });
const queue = readJson(`queue/${date}/queue.json`, null);
const save = () => { fs.mkdirSync('state', { recursive: true }); fs.writeFileSync('state/published.json', JSON.stringify(state, null, 2)); };
const event = e => { state.events = [...(state.events || []), { ts: new Date().toISOString(), ...e }].slice(-300); };

if (!queue?.items?.length) { console.log(`nothing queued for ${date}`); process.exit(0); }
if (!IG_USER_ID || !IG_ACCESS_TOKEN) { console.error('missing IG secrets'); process.exit(4); }
const sfHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const commit = () => {
  if (DRY || !process.env.GITHUB_ACTIONS) return;
  execSync('git config user.name "moonshot-publisher" && git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  execSync('git add state && (git diff --cached --quiet || (git commit -q -m "state: ' + new Date().toISOString() + '" && git pull -q --rebase && git push -q))');
};

async function call(path, params, method = 'POST') {
  const body = new URLSearchParams({ access_token: IG_ACCESS_TOKEN, ...params });
  const r = await fetch(method === 'GET' ? `${API}${path}?${body}` : `${API}${path}`, method === 'GET' ? {} : { method, body });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(JSON.stringify(j.error || j));
  return j;
}
async function waitReady(id, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const s = await call(`/${id}`, { fields: 'status_code' }, 'GET');
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`container ${id}: ${s.status_code}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`container ${id} timed out`);
}
const url = f => `${RAW}/queue/${date}/${f}`;
const publishContainer = async params => {
  const c = await call(`/${IG_USER_ID}/media`, params); await waitReady(c.id);
  if (DRY) { console.log(`DRY RUN: container ${c.id} ready (${params.media_type || 'IMAGE'}), not published`); process.exit(0); }
  return (await call(`/${IG_USER_ID}/media_publish`, { creation_id: c.id })).id;
};

async function publish(it) {
  if (it.type === 'carousel') {
    const children = [];
    for (const f of it.images) { const c = await call(`/${IG_USER_ID}/media`, { image_url: url(f), is_carousel_item: 'true' }); await waitReady(c.id); children.push(c.id); }
    return ['carousel', await publishContainer({ media_type: 'CAROUSEL', children: children.join(','), caption: it.caption })];
  }
  if (it.type === 'reel') {
    try { return ['reel', await publishContainer({ media_type: 'REELS', video_url: url(it.video), cover_url: url(it.image), caption: it.caption, share_to_feed: 'true' })]; }
    catch (e) { event({ event: 'reel_failed_fallback_image', key: `${date}/${it.n}`, reason: String(e.message || e) }); }
  }
  return ['image', await publishContainer({ image_url: url(it.image), caption: it.caption })];
}

while (true) {
  const next = queue.items.find(it => !state.items[`${date}/${it.n}`]);
  if (!next) { console.log(`all ${queue.items.length} items for ${date} published`); break; }
  if (!DRY && sfHour() >= LATEST_HOUR) { console.log('past the posting window in SF; leftovers stay unposted'); break; }
  const wait = state.last_ts ? MIN_GAP_MIN * 60e3 - (Date.now() - new Date(state.last_ts).getTime()) : 0;
  if (wait > 0) await sleep(wait);
  const key = `${date}/${next.n}`;
  try {
    const [format, media_id] = await publish(next);
    state.items[key] = { media_id, format, ts: new Date().toISOString(), headline: next.headline, tag: next.tag, company: next.company };
    state.last_ts = state.items[key].ts;
    event({ event: 'published', key, format, media_id });
    console.log(`PUBLISHED ${key} as ${format} (${media_id}): ${next.headline}`);
    if (next.story) {
      try { const sid = await publishContainer({ media_type: 'STORIES', image_url: url(next.story) }); event({ event: 'story_published', key, media_id: sid }); console.log('story', sid); }
      catch (e) { event({ event: 'story_failed', key, reason: String(e.message || e) }); }
    }
    save(); commit();
  } catch (e) {
    event({ event: 'publish_failed', key, reason: String(e.message || e).slice(0, 500) });
    save(); commit();
    console.error('PUBLISH FAILED', e.message || e);
    process.exit(5);
  }
  if (queue.items.some(it => !state.items[`${date}/${it.n}`])) await sleep(GAP_MIN * 60e3);
}
