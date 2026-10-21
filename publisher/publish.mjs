// Runs on GitHub Actions on a schedule, so @moonshotdaily posts even when the Mac is asleep.
// The Mac queues each day's finished posts under queue/<date>/ (queue.json + images/videos);
// Runs (hourly, in theory) through SF's workday. GitHub's scheduler often skips hours, so instead of "one post
// per run" each run posts every item whose time SLOT has already passed (max MAX_PER_RUN per run, a few minutes
// apart). Yesterday's unposted items carry over after today's, within MAX_PER_DAY. State is committed after every
// post so nothing is ever posted twice.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const API = 'https://graph.instagram.com/v23.0';
const { IG_USER_ID, IG_ACCESS_TOKEN, GITHUB_REPOSITORY } = process.env;
const MIN_GAP_FLOOR = 35; // never closer than this; the real gap spreads today's posts evenly (Instagram blocked posts made minutes apart on 10-18/19)
const GAP_MIN = Number(process.env.GAP_MIN || 120); // hourly runs + 120 min ≈ 7, 9, 11 AM, 1, 3 PM in SF
const EARLIEST_HOUR = 7, LATEST_HOUR = 20; // SF local time window for posting
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
if (!IG_USER_ID || !IG_ACCESS_TOKEN) { console.error('missing IG secrets'); process.exit(4); }
// Instagram "action is blocked" (code 4 / 2207051) sets a 24h cooldown: hammering a block makes it longer
if (!DRY && state.blocked_until && new Date(state.blocked_until) > new Date()) { console.log(`cooling down after an Instagram action block until ${state.blocked_until}`); process.exit(0); }
const sfHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Saving state must never fail a run that already posted (a rejected push on 2026-10-19 lost the record of a live
// post and the next run posted it again). So: merge with whatever is on main now, commit on top of it, retry.
function mergeRemote() {
  try {
    const r = JSON.parse(execSync('git show origin/main:state/published.json', { stdio: 'pipe' }).toString());
    state.items = { ...(r.items || {}), ...state.items };
    const id = e => `${e.ts}|${e.event}|${e.key || ''}`, seen = new Set();
    state.events = [...(r.events || []), ...(state.events || [])].filter(e => !seen.has(id(e)) && seen.add(id(e))).sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(-300);
    for (const k of ['last_ts', 'blocked_until']) if (r[k] && (!state[k] || r[k] > state[k])) state[k] = r[k];
  } catch {}
}
const commit = () => {
  if (DRY || !process.env.GITHUB_ACTIONS) return;
  execSync('git config user.name "moonshot-publisher" && git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
  for (let i = 0; i < 5; i++) {
    try {
      execSync('git fetch -q origin main', { stdio: 'pipe' });
      mergeRemote(); save();
      execSync(`git reset -q --mixed origin/main && git add state && (git diff --cached --quiet || git commit -q -m "state: ${new Date().toISOString()}") && git push -q origin HEAD:main && git checkout -q -- .`, { stdio: 'pipe' });
      return;
    } catch (e) { console.error(`state push attempt ${i + 1} failed: ${String(e.message).slice(0, 200)}`); execSync('sleep 6'); }
  }
  console.error('could not push state; the "Save publish state" step will retry');
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
let itemDate = date; // queue folder of the item being published (yesterday's leftovers live in their own folder)
const url = f => `${RAW}/queue/${itemDate}/${f}`;
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
    // only a collaborator problem justifies a retry; anything else (e.g. an action block) may already have posted
    if (!it.collaborators?.length || !/"code":210|collaborat|Tag User/i.test(String(e.message))) throw e;
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

// today's posts are spread evenly from 7 AM to 7:30 PM SF time; post N may go out once SLOTS[N] has passed
const planned = Math.max(1, (queue?.items || []).length);
const SPACING_H = planned > 1 ? 12.5 / (planned - 1) : 12.5;
const SLOTS = Array.from({ length: planned + 3 }, (_, k) => 7 + k * SPACING_H); // + room for yesterday's leftovers
const MIN_GAP_MIN = Math.max(MIN_GAP_FLOOR, Math.min(90, Math.floor(SPACING_H * 60) - 10));
const MAX_PER_DAY = 20, MAX_PER_RUN = 1, IN_RUN_GAP_MIN = 4;
const laDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const yday = laDate(new Date(`${date}T12:00:00Z`).getTime() - 86400e3);
const leftovers = readJson(`queue/${yday}/queue.json`, { items: [] }).items.map(it => ({ ...it, _date: yday }));
const items = [...(queue?.items || []).map(it => ({ ...it, _date: date })), ...(DRY ? [] : leftovers)];
const pending = items.filter(it => !state.items[`${it._date}/${it.n}`]);
if (!pending.length) { console.log(`nothing left to post for ${date}`); process.exit(0); }
const now = new Date(), hour = sfHour();
if (!DRY && (hour < EARLIEST_HOUR || hour >= LATEST_HOUR)) { console.log(`outside the SF posting window (hour ${hour}); ${pending.length} waiting`); process.exit(0); }
const sfMinutes = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', minute: 'numeric' }).format(now));
const postedToday = Object.values(state.items).filter(v => laDate(v.ts) === date).length;
const due = SLOTS.filter(h => h <= hour + sfMinutes / 60).length;
const sinceLast = state.last_ts ? (now - new Date(state.last_ts)) / 60e3 : Infinity;
let toPost = DRY ? 1 : Math.min(due - postedToday, MAX_PER_DAY - postedToday, pending.length, MAX_PER_RUN);
if (!DRY && sinceLast < MIN_GAP_MIN) toPost = 0;
if (toPost <= 0) { console.log(`${postedToday} posted today, ${due} slots due so far, last post ${Math.round(sinceLast)} min ago — nothing due yet`); process.exit(0); }

// Instagram has returned errors for posts that still went live (3 duplicate Suki posts on 2026-10-18), so a
// failure is only a failure once the account's latest media shows no post with this caption since the attempt began
async function findLive(caption, sinceMs) {
  try {
    const r = await call(`/${IG_USER_ID}/media`, { fields: 'id,caption,timestamp', limit: '12' }, 'GET');
    const head = s => String(s || '').slice(0, 200);
    return r.data.find(m => head(m.caption) === head(caption) && new Date(m.timestamp).getTime() >= sinceMs - 120e3)?.id || null;
  } catch { return null; }
}

async function postOne(next) {
  itemDate = next._date;
  const key = `${next._date}/${next.n}`;
  const started = Date.now();
  // already on the page (e.g. a run posted it but its record was lost)? record it and never post it twice
  const already = DRY ? null : await findLive(next.caption, started - 72 * 3600e3);
  if (already) {
    state.items[key] = { media_id: already, format: next.type, ts: new Date().toISOString(), headline: next.headline, tag: next.tag, company: next.company, note: 'already live, not reposted' };
    event({ event: 'already_live', key, media_id: already });
    save(); commit();
    console.log(`already live, skipped: ${key} (${already})`);
    return;
  }
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
    if (/"code":4,|2207051|action is blocked/i.test(String(e.message))) state.blocked_until = new Date(Date.now() + 24 * 3600e3).toISOString();
    const live = await findLive(next.caption, started);
    if (live) {
      state.items[key] = { media_id: live, format: next.type, ts: new Date().toISOString(), headline: next.headline, tag: next.tag, company: next.company, note: 'went live despite an error' };
      state.last_ts = state.items[key].ts;
      event({ event: 'published_despite_error', key, media_id: live, reason: String(e.message || e).slice(0, 300) });
      save(); commit();
      console.log(`went live despite an error: ${key} (${live})`);
      process.exit(0);
    }
    event({ event: 'publish_failed', key, reason: String(e.message || e).slice(0, 500) });
    save(); commit();
    console.error('PUBLISH FAILED', e.message || e);
    process.exit(5);
  }
}

for (let i = 0; i < toPost; i++) {
  if (i > 0) await new Promise(r => setTimeout(r, IN_RUN_GAP_MIN * 60e3));
  await postOne(pending[i]);
}
