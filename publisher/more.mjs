// Should this run hand off to another one in ~an hour? True while today (SF time) still has posts to go
// out before the window closes. Lets one start per day carry the whole day, since GitHub's cron skips hours.
import fs from 'node:fs';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const laDate = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const date = laDate(Date.now());
const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const yday = laDate(new Date(`${date}T12:00:00Z`).getTime() - 86400e3);
const state = readJson('state/published.json', { items: {} });
const items = [...readJson(`queue/${date}/queue.json`, { items: [] }).items.map(i => `${date}/${i.n}`),
               ...readJson(`queue/${yday}/queue.json`, { items: [] }).items.map(i => `${yday}/${i.n}`)];
const pending = items.filter(k => !state.items[k]).length;
const postedToday = Object.values(state.items).filter(v => laDate(v.ts) === date).length;
const more = !fs.existsSync('PAUSED') && hour < 20 && pending > 0 && postedToday < 6;
console.log(`SF hour ${hour}, pending ${pending}, posted today ${postedToday} -> continue: ${more}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `more=${more}\n`);
