// ---- live engine: data.json from the vault + ESPN, graded in the browser ----
const SPORTS = { NBA: "basketball/nba", NFL: "football/nfl", NHL: "hockey/nhl" };
// Abbreviation variants -> one canonical form, applied to ESPN and vault text alike.
const ALIASES = {
  NBA: { NY: "NYK", UTAH: "UTA", WSH: "WAS", SA: "SAS", GS: "GSW", NO: "NOP", PHO: "PHX", BRK: "BKN", CHO: "CHA" },
  NFL: { WAS: "WSH", JAC: "JAX", LA: "LAR", ARZ: "ARI" },
  NHL: { LA: "LAK", NJ: "NJD", SJ: "SJS", TB: "TBL", UTAH: "UTA", VEG: "VGK", WAS: "WSH", MON: "MTL", NAS: "NSH", CLB: "CBJ" },
};
// Prop stat keyword -> box-score labels summed; "A|B" = whichever label exists.
const PROP_STATS = {
  pra: ["PTS", "REB", "AST"], "pts+reb+ast": ["PTS", "REB", "AST"], "pts+reb": ["PTS", "REB"], "pts+ast": ["PTS", "AST"],
  "reb+ast": ["REB", "AST"], points: ["PTS"], pts: ["PTS"], rebounds: ["REB"], reb: ["REB"], assists: ["AST"], ast: ["AST"],
  "3pm": ["3PT"], threes: ["3PT"], blocks: ["BLK"], steals: ["STL"], turnovers: ["TO"],
};
const NHL_PROP_STATS = { shots: ["S|SOG"], "shots on goal": ["S|SOG"], sog: ["S|SOG"], goals: ["G"], assists: ["A"], points: ["G", "A"], saves: ["SV"] };
const GAME_RE = /^\s*([A-Z0-9]+)\s*(?:@|vs\.?)\s*([A-Z0-9]+)/;
const LIVE_TTL = 55000;

const norm = (sport, a) => (ALIASES[sport] || {})[a] || a;
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const shift = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const firstFloat = (s) => { const m = String(s || "").match(/[+-]?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };

const httpCache = new Map(); // url -> { t, forever, data, inflight }
async function getJSON(url) {
  const h = httpCache.get(url);
  if (h && h.data && (h.forever || Date.now() - h.t < LIVE_TTL)) return h.data;
  if (h && h.inflight) return h.inflight;
  const p = fetch(url, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => { httpCache.set(url, { t: Date.now(), data, forever: h?.forever }); return data; })
    .catch((e) => { httpCache.set(url, { ...(h || {}), inflight: null }); if (h?.data) return h.data; throw e; });
  httpCache.set(url, { ...(h || {}), inflight: p });
  return p;
}
const pin = (url) => { const h = httpCache.get(url); if (h) h.forever = true; };

async function scoreboard(sport, date) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${SPORTS[sport]}/scoreboard?dates=${date.replace(/-/g, "")}&limit=200`;
  let data;
  try { data = await getJSON(url); } catch { return []; }
  const evs = (data.events || []).map((e) => {
    const c = e.competitions[0], st = c.status.type, teams = {};
    for (const t of c.competitors) {
      const ab = norm(sport, t.team.abbreviation);
      teams[t.homeAway] = { abbr: ab, name: t.team.shortDisplayName || ab, score: st.state !== "pre" && /^\d+$/.test(String(t.score ?? "")) ? +t.score : null };
    }
    return { id: e.id, sport, date, start: e.date, state: st.state, detail: st.shortDetail || "", completed: !!st.completed, away: teams.away, home: teams.home,
             elapsed: elapsedOf(sport, st.state, c.status.period, c.status.clock) };
  });
  if (evs.length && evs.every((e) => e.completed) && date < todayET()) pin(url);
  return evs;
}

async function boxscore(sport, ev) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${SPORTS[sport]}/summary?event=${ev.id}`;
  let data;
  try { data = await getJSON(url); } catch { return {}; }
  if (ev.completed) pin(url);
  const players = {};
  for (const team of data?.boxscore?.players || [])
    for (const block of team.statistics || []) {
      const labels = block.labels || [];
      for (const a of block.athletes || []) {
        const key = nameKey(a.athlete.displayName).join(" ");
        const stats = players[key] || (players[key] = {});
        (a.stats || []).forEach((v, i) => { stats[labels[i]] = v; });
      }
    }
  return players;
}

function nameKey(name) {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "").split(/\s+/).filter(Boolean);
}
function findPlayer(players, key) {
  const j = key.join(" ");
  if (players[j]) return players[j];
  for (const [k, v] of Object.entries(players)) {
    const parts = k.split(" ");
    if (parts.length && key.length && parts[parts.length - 1] === key[key.length - 1] && parts[0][0] === key[0][0]) return v;
  }
  return null;
}
function statValue(stats, labels) {
  let total = 0;
  for (const lab of labels) {
    let v = null;
    for (const k of lab.split("|")) if (k in stats) { v = stats[k]; break; }
    if (v == null) return null;
    const n = parseFloat(String(v).split("-")[0]); // "5-10" made-attempted
    if (isNaN(n)) return null;
    total += n;
  }
  return total;
}

async function findEvent(sport, game, date) {
  const m = String(game).match(GAME_RE);
  if (!m || !SPORTS[sport]) return null;
  const want = [norm(sport, m[1]), norm(sport, m[2])].sort().join("|");
  // NFL slates run Thu-Mon; NBA/NHL late games stay on the ET date.
  for (let off = 0; off < (sport === "NFL" ? 3 : 1); off++)
    for (const ev of await scoreboard(sport, shift(date, off)))
      if (ev.away && ev.home && [ev.away.abbr, ev.home.abbr].sort().join("|") === want) return ev;
  return null;
}

async function grade(p) {
  const out = { event: null, status: "unmatched", auto: "", live: "", note: "" };
  const ev = await findEvent(p.sport, p.game, p.date);
  if (!ev) { out.note = "Game not found on ESPN"; return out; }
  out.event = ev;
  out.status = { pre: "scheduled", in: "live", post: "final" }[ev.state] || ev.state;
  if (ev.state === "pre" || ev.away.score == null || ev.home.score == null) return out;
  const score = { [ev.away.abbr]: ev.away.score, [ev.home.abbr]: ev.home.score };
  let res = "";
  if (p.market === "ML" || p.market === "spread") {
    const team = norm(p.sport, p.pick.split(/\s+/)[0]);
    if (!(team in score)) { out.note = `${team} not in this game`; return out; }
    const opp = Object.keys(score).find((t) => t !== team);
    let margin = score[team] - score[opp];
    if (p.market === "spread") {
      const line = firstFloat(p.line);
      if (line == null) { out.note = "Spread line missing"; return out; }
      margin += line;
    }
    res = margin > 0 ? "W" : margin < 0 ? "L" : "P";
    out.prog = { kind: "margin", value: margin, unit: team, spread: p.market === "spread" };
    out.note = p.market === "ML"
      ? (margin === 0 ? "Tied" : `${team} ${margin > 0 ? "won" : "lost"} by ${Math.abs(margin)}`)
      : `${team} ${margin >= 0 ? "+" : ""}${margin} vs the number`;
  } else if (p.market === "total") {
    const line = firstFloat(p.line), tot = ev.away.score + ev.home.score, over = /over/i.test(p.pick);
    if (line == null) { out.note = "Total line missing"; return out; }
    const diff = over ? tot - line : line - tot;
    res = diff > 0 ? "W" : diff < 0 ? "L" : "P";
    out.prog = { kind: "count", value: tot, line, side: over ? "over" : "under", unit: "total" };
    out.note = `${tot} total vs ${line}`;
  } else if (p.market === "prop") {
    const m = p.pick.match(/^(.+?)\s+(over|under)\s+(.+?)(?:\s*\(.*\))?$/i);
    if (!m) { out.note = "Prop format not recognised"; return out; }
    const side = m[2].toLowerCase(), stat = m[3].toLowerCase().trim();
    const labels = (p.sport === "NHL" ? NHL_PROP_STATS : PROP_STATS)[stat];
    if (!labels) { out.note = `Stat "${stat}" not mapped`; return out; }
    const stats = findPlayer(await boxscore(p.sport, ev), nameKey(m[1]));
    if (!stats) {
      out.note = "Player not in box score (DNP?)";
      if (ev.state === "post") res = "V";
    } else {
      const val = statValue(stats, labels), line = firstFloat(p.line);
      if (val == null || line == null) out.note = "Stat missing from box score";
      else {
        const diff = side === "over" ? val - line : line - val;
        res = diff > 0 ? "W" : diff < 0 ? "L" : "P";
        out.prog = { kind: "count", value: val, line, side, unit: stat };
        out.note = `${val} vs ${line}${stats.MIN ? ` (${stats.MIN}m)` : ""}`;
      }
    }
  }
  // An over that has already cleared can't lose, so it settles while live.
  const clearedOver = res === "W" && ev.state === "in" && (p.market === "prop" || p.market === "total") && /\bover\b/i.test(p.pick);
  if (ev.state === "post" || clearedOver) out.auto = res; else out.live = res;
  return out;
}

const weekStart = (d) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };

async function buildFeed(raw) {
  const today = todayET(), recent = shift(today, -1);
  const picks = raw.picks.map((p) => ({ ...p }));
  await Promise.all(picks.map(async (p) => {
    const logged = (p.loggedResult || "").split(" ")[0].trim();
    p.provisional = /prov/.test(p.loggedResult || "");
    const needs = !logged || p.provisional || p.date >= recent;
    const g = needs ? await grade(p) : { status: "final", auto: "", live: "", note: p.loggedActual, event: null };
    const ev = g.event;
    Object.assign(p, {
      status: g.status, autoResult: g.auto, liveResult: g.live, note: g.note || p.loggedActual,
      score: ev && ev.away.score != null ? `${ev.away.abbr} ${ev.away.score} - ${ev.home.abbr} ${ev.home.score}` : "",
      detail: ev ? ev.detail : "", prog: g.prog || null, elapsed: ev ? ev.elapsed : null, start: ev ? ev.start : "",
      eventId: ev ? ev.id : "", live: g.live, actual: p.loggedActual,
    });
    if (["W", "L", "P", "V"].includes(logged)) { p.result = logged; p.source = "log"; }
    else if (g.auto) { p.result = g.auto; p.source = "auto"; }
    else { p.result = ""; p.source = ""; }
  }));
  const byRef = new Map(picks.map((p) => [`${p.date}|${p.game}|${p.pick}`, p]));

  const tickets = raw.tickets.map((t) => {
    const legs = t.legRefs.map(({ game, pick }) => {
      const p = byRef.get(`${t.date}|${game}|${pick}`);
      return p ? { ...p, found: true }
               :{ game, pick, found: false, result: "", live: "", status: "missing", score: "", detail: "", note: "Not in Pick Log", line: "", price: "" };
    });
    const res = legs.map((l) => l.result);
    const status = t.override || (res.includes("L") ? "L" : legs.length && res.every((r) => ["W", "P", "V"].includes(r)) ? "W" : "open");
    return { ...t, legs, status, won: res.filter((r) => r === "W").length, lost: res.filter((r) => r === "L").length,
             pending: res.filter((r) => !r).length, paid: status === "W" ? t.returns : 0 };
  });

  const games = {};
  await Promise.all(Object.keys(SPORTS).map(async (s) => { games[s] = await scoreboard(s, today); }));
  // Attach picks by the ESPN event they were graded against, so a same-teams game on another day never borrows them.
  const picked = new Map();
  for (const p of picks) {
    if (!p.eventId || p.superseded) continue;
    if (!picked.has(p.eventId)) picked.set(p.eventId, []);
    picked.get(p.eventId).push(p);
  }
  for (const evs of Object.values(games))
    for (const e of evs) e.picks = picked.get(e.id) || [];

  return {
    generated: new Date().toISOString(), exported: raw.exported, today, picks, tickets, games,
    weeks: [...new Set(picks.map((p) => weekStart(p.date)))].sort().reverse(),
  };
}

// ---- progress bars: one per pick, shared by both pages ----
const REG = { NBA: [4, 720], NFL: [4, 900], NHL: [3, 1200] }; // regulation periods, seconds each
const MARGIN_RANGE = { NBA: 20, NFL: 17, NHL: 4 };
// Share of regulation played (0-1); overtime counts as 1.
function elapsedOf(sport, state, period, clock) {
  if (state === "pre") return 0;
  if (state !== "in" || !REG[sport]) return 1;
  const [n, len] = REG[sport];
  if (!period || period > n) return period > n ? 1 : 0;
  return Math.min(1, Math.max(0, ((period - 1) * len + (len - (+clock || 0))) / (n * len)));
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); // used by both pages too
const r1 = (v) => Math.round(v * 10) / 10;

// p: { prog, elapsed, status, result, detail, start, sport }. Empty string when there's nothing to show. Styles: progress.css.
function progressBar(p) {
  const g = p.prog, clock = p.status === "live" && p.elapsed != null ? `<div class="pb-clock"><span style="width:${(p.elapsed * 100).toFixed(1)}%"></span></div>` : "";
  if (!g) {
    if (p.status !== "scheduled") return "";
    const t = p.start ? new Date(p.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    return `<div class="pbar"><div class="pb-track"></div><div class="pb-txt"><span>Not started</span><span>${t}</span></div></div>`;
  }
  const final = !!p.result, live = p.status === "live";
  let track, label, aside = live ? esc(p.detail) : final ? "Final" : "", tone, aria;
  if (g.kind === "count") {
    const pace = live && p.elapsed >= 0.15 && p.elapsed < 1 ? g.value / p.elapsed : null;
    const scale = Math.max(g.line * 1.25, g.value * 1.05, 1), w = (v) => Math.min(100, (v / scale) * 100).toFixed(1);
    const over = g.side === "over", hit = over ? g.value > g.line : g.value < g.line;
    // An under sitting exactly on a whole-number line is a push so far, not a loss.
    tone = final ? { W: "good", L: "bad" }[p.result] || "flat"
      : over ? (hit ? "good" : pace != null && pace < g.line ? "warn" : "on")
      : g.value > g.line ? "bad" : g.value === g.line ? "flat" : pace != null && pace >= g.line ? "warn" : "on";
    track = `${pace != null ? `<span class="pb-pace" style="width:${w(pace)}%"></span>` : ""}<span class="pb-fill" style="width:${w(g.value)}%"></span><span class="pb-line" style="left:${w(g.line)}%"></span>`;
    const need = over ? Math.max(0, Math.floor(g.line) + 1 - g.value) : null;
    label = `<b>${r1(g.value)}</b> / ${g.line} ${esc(g.unit)}${!final && over ? (hit ? " · cleared" : ` · ${need} to go`) : ""}`;
    if (pace != null) aside = `pace ${r1(pace)} · ${aside}`;
    aria = `${g.value} of ${g.line} ${g.unit}, ${g.side}`;
  } else {
    const range = Math.max(MARGIN_RANGE[p.sport] || 10, Math.abs(g.value)), half = Math.min(50, (Math.abs(g.value) / range) * 50);
    tone = final ? { W: "good", L: "bad" }[p.result] || "flat" : g.value > 0 ? "good" : g.value < 0 ? "bad" : "flat";
    track = `<span class="pb-mid"></span><span class="pb-fill" style="left:${g.value >= 0 ? 50 : 50 - half}%;width:${half.toFixed(1)}%"></span>`;
    const a = r1(Math.abs(g.value)), team = esc(g.unit), done = p.status === "final";
    const words = g.spread ? (done ? ["covered by", "missed by", "pushed"] : ["covering by", "short by", "on the number"])
      : done ? ["won by", "lost by", "tied"] : ["up", "down", "tied"];
    label = g.value === 0 ? `${team} ${words[2]}` : `${team} ${words[g.value > 0 ? 0 : 1]} <b>${a}</b>`;
    aria = `${g.unit} margin ${g.value}`;
  }
  return `<div class="pbar ${tone}" role="img" aria-label="${esc(aria)}">
    <div class="pb-track">${track}</div>${clock}<div class="pb-txt"><span>${label}</span><span>${aside}</span></div></div>`;
}

// Fetch the vault export and build the graded feed. Keeps the last good copy.
let _raw = null;
async function loadFeed() {
  try {
    const r = await fetch("data.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("data.json returned " + r.status);
    _raw = await r.json();
  } catch (e) {
    if (!_raw) throw e;
  }
  return { raw: _raw, feed: await buildFeed(_raw) };
}
