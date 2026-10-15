// Runs on GitHub Actions on a schedule, so @moonshotdaily posts even when the Mac is asleep.
// The Mac queues each day's finished posts under queue/<date>/ (queue.json + images/videos);
// Runs hourly through SF's workday. Each run publishes at most ONE item — the next unpublished one —
// once enough time has passed since the last post, so the day's posts spread from EARLIEST_HOUR to LATEST_HOUR.
// The gap adapts: if runs were delayed and time is short, posts move closer together. State is committed
// after every post so nothing is ever posted twice.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = 'https://graph.instagram.com/v23.0';
const { IG_USER_ID, IG_ACCESS_TOKEN, GITHUB_REPOSITORY } = process.env;
const MIN_GAP_MIN = 20;
const GAP_MIN = Number(process.env.GAP_MIN || 120); // hourly runs + 120 min ≈ 7, 9, 11 AM, 1, 3 PM in SF
const EARLIEST_HOUR = 7, LATEST_HOUR = 18; // SF local time window for posting
const RAW = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/main`;

// DRY_RUN=1 QUEUE_DATE=<folder>: builds the Instagram container (proves URLs + token work) but never publishes or records state
const DRY = process.env.DRY_RUN === '1';
const date = process.env.QUEUE_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson('state/published.json', { items: {}, last_ts: null, events: [] });
const queue = readJson(`queue/${date}/queue.json`, null);
const save = () => { fs.mkdirSync('state', { recursive: true }); fs.writeFileSync('state/published.json', JSON.stringify(state, null, 2)); };
const event = e => { state.events = [...(state.events || []), { ts: new Date().toISOString(), ...e }].slice(-300); };

// kill switch: a PAUSED file in the repo root stops all posting (used when Instagram blocks the app)
if (fs.existsSync('PAUSED')) { console.log(`paused: ${fs.readFileSync('PAUSED', 'utf8').trim()}`); process.exit(0); }
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
  // Instagram sometimes reports FINISHED a moment before the media can be published (code 9007): wait and retry
  for (let i = 0; ; i++) {
    try { return (await call(`/${IG_USER_ID}/media_publish`, { creation_id: c.id })).id; }
    catch (e) { if (i >= 5 || !String(e.message).includes('"code":9007')) throw e; await new Promise(r => setTimeout(r, 10000)); }
  }
};

// collab invites: the featured company (and lead investor) can accept and the post shows on their profile too
const collab = it => it.collaborators?.length ? { collaborators: JSON.stringify(it.collaborators.slice(0, 3)) } : {};
async function withCollabFallback(it, build) {
  try { return await build(collab(it)); }
  catch (e) {
    if (!it.collaborators?.length) throw e;
    // an invalid/private collaborator must never cost us the post
    event({ event: 'collab_failed_retry_without', key: `${date}/${it.n}`, collaborators: it.collaborators, reason: String(e.message || e).slice(0, 300) });
    return await build({});
  }
}

async function publish(it) {
  if (it.type === 'carousel') {
    const children = [];
    for (const f of it.images) { const c = await call(`/${IG_USER_ID}/media`, { image_url: url(f), is_carousel_item: 'true' }); await waitReady(c.id); children.push(c.id); }
    return ['carousel', await withCollabFallback(it, extra => publishContainer({ media_type: 'CAROUSEL', children: children.join(','), caption: it.caption, ...extra }))];
  }
  if (it.type === 'reel') {
    try { return ['reel', await withCollabFallback(it, extra => publishContainer({ media_type: 'REELS', video_url: url(it.video), cover_url: url(it.image), caption: it.caption, share_to_feed: 'true', ...extra }))]; }
    catch (e) { event({ event: 'reel_failed_fallback_image', key: `${date}/${it.n}`, reason: String(e.message || e) }); }
  }
  return ['image', await withCollabFallback(it, extra => publishContainer({ image_url: url(it.image), caption: it.caption, ...extra }))];
}

// Threads: same story as an image carousel with a short text. Optional — runs only when THREADS_* secrets exist,
// and a Threads failure never affects the Instagram post.
const { THREADS_USER_ID, THREADS_ACCESS_TOKEN } = process.env;
async function tcall(path, params, method = 'POST') {
  const body = new URLSearchParams({ access_token: THREADS_ACCESS_TOKEN, ...params });
  const r = await fetch(method === 'GET' ? `https://graph.threads.net/v1.0${path}?${body}` : `https://graph.threads.net/v1.0${path}`, method === 'GET' ? {} : { method, body });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(JSON.stringify(j.error || j));
  return j;
}
async function treadyThenPublish(id) {
  for (let i = 0; i < 40; i++) {
    const s = await tcall(`/${id}`, { fields: 'status,error_message' }, 'GET');
    if (s.status === 'FINISHED') break;
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error(`threads container ${id}: ${s.status} ${s.error_message || ''}`);
    await new Promise(r => setTimeout(r, 4000));
  }
  return (await tcall(`/${THREADS_USER_ID}/threads_publish`, { creation_id: id })).id;
}
async function postToThreads(it) {
  const images = (it.images?.length ? it.images : [it.image]).slice(0, 20);
  if (images.length === 1) {
    const c = await tcall(`/${THREADS_USER_ID}/threads`, { media_type: 'IMAGE', image_url: url(images[0]), text: it.threads_text || it.headline });
    return treadyThenPublish(c.id);
  }
  const children = [];
  for (const f of images) children.push((await tcall(`/${THREADS_USER_ID}/threads`, { media_type: 'IMAGE', image_url: url(f), is_carousel_item: 'true' })).id);
  const c = await tcall(`/${THREADS_USER_ID}/threads`, { media_type: 'CAROUSEL', children: children.join(','), text: it.threads_text || it.headline });
  return treadyThenPublish(c.id);
}

const pending = queue.items.filter(it => !state.items[`${date}/${it.n}`]);
const next = pending[0];
if (!next) { console.log(`all ${queue.items.length} items for ${date} published`); process.exit(0); }
const now = new Date(), hour = sfHour();
if (!DRY && (hour < EARLIEST_HOUR || hour >= LATEST_HOUR)) { console.log(`outside the SF posting window (hour ${hour})`); process.exit(0); }
// minutes left in today's window, shared across what's still unposted
const sfMinutes = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', minute: 'numeric' }).format(now));
const minutesLeft = (LATEST_HOUR - hour) * 60 - sfMinutes;
const gap = Math.max(MIN_GAP_MIN, Math.min(GAP_MIN, minutesLeft / pending.length));
const sinceLast = state.last_ts ? (now - new Date(state.last_ts)) / 60e3 : Infinity;
if (!DRY && sinceLast < gap - 10) { console.log(`last post ${Math.round(sinceLast)} min ago; next due after ~${Math.round(gap)} min`); process.exit(0); }
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
  if (THREADS_USER_ID && THREADS_ACCESS_TOKEN) {
    try { const tid = await postToThreads(next); state.items[key].threads_id = tid; event({ event: 'threads_published', key, media_id: tid }); console.log('threads', tid); }
    catch (e) { event({ event: 'threads_failed', key, reason: String(e.message || e).slice(0, 300) }); console.error('threads failed (instagram post is fine):', e.message || e); }
  }
  save(); commit();
} catch (e) {
  event({ event: 'publish_failed', key, reason: String(e.message || e).slice(0, 500) });
  save(); commit();
  console.error('PUBLISH FAILED', e.message || e);
  process.exit(5);
}
