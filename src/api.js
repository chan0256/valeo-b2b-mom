// B2B Weekly MoM portal API (Cloudflare Worker, D1 binding "DB").
// Every route lives under /api. Auth is an email + password login that sets
// an HttpOnly session cookie; sessions are stored hashed in D1.

const SESSION_DAYS = 30;
const PBKDF2_ITER = 100000; // Workers' maximum for PBKDF2
const COOKIE = "mom_session";
const STATUSES = ["open", "progress", "done"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const newId = p => p + Date.now().toString(36) + randomHex(4);
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return hex(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function checkPassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) fail(400, "Password must be at least 8 characters.");
  return pw;
}
const str = (v, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const addDaysISO = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function readCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
const cookieHeader = (req, value, maxAge) => {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};

async function startSession(env, req, userId) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 86400000).run();
  return cookieHeader(req, token, SESSION_DAYS * 86400);
}

async function currentUser(env, req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1"
  ).bind(await sha256(token), Date.now()).first();
}

const publicUser = u => ({ id: u.id, name: u.name, email: u.email, title: u.title || "", role: u.role, active: !!u.active });
const publicItem = (i, assignees) => ({
  id: i.id, meetingId: i.meeting_id, task: i.task, owner: i.owner, assignees: assignees || [], due: i.due, status: i.status,
  update: i.progress_note, doneAt: i.done_at, createdAt: i.created_at, updatedAt: i.updated_at,
});

// ---------- schema upgrade ----------
// Adds meeting types ("series") to databases created before they existed.
// Runs once per Worker instance, so no console step is needed after an update.
let migrated = null;
async function migrate(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS series (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, weekday INTEGER NOT NULL DEFAULT 1, time TEXT NOT NULL DEFAULT '10:00',
    duration INTEGER NOT NULL DEFAULT 60, location TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`).run();
  try { await env.DB.prepare("ALTER TABLE meetings ADD COLUMN series_id TEXT").run(); }
  catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  // one-off changes to a single date of a meeting type: moved (new_date/new_time) or cancelled (new_date NULL)
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS series_changes (
    series_id TEXT NOT NULL, orig_date TEXT NOT NULL, new_date TEXT, new_time TEXT, note TEXT NOT NULL DEFAULT '',
    updated_by TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (series_id, orig_date))`).run();
  if (!(await env.DB.prepare("SELECT 1 FROM series LIMIT 1").first())) {
    const s = (await env.DB.prepare("SELECT weekday, time, duration, title, location FROM settings WHERE id = 1").first())
      || { weekday: 1, time: "10:00", duration: 60, title: "UAE B2B Weekly Meeting", location: "" };
    const sid = newId("s");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO series (id, title, weekday, time, duration, location, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
        .bind(sid, s.title, s.weekday, s.time, s.duration, s.location, Date.now()),
      env.DB.prepare("UPDATE meetings SET series_id = ? WHERE series_id IS NULL").bind(sid),
    ]);
  }
}
const ensureMigrated = env => (migrated ||= migrate(env).catch(e => { migrated = null; throw e; }));

// Validates a meeting type from a request body
function seriesFields(body) {
  const weekday = Number(body.weekday), duration = Number(body.duration), title = str(body.title, 200);
  if (!title) fail(400, "Give the meeting a name.");
  if (!(weekday >= 0 && weekday <= 6) || !TIME_RE.test(body.time || "") || !(duration >= 15 && duration <= 600)) fail(400, "Check the day, time and length.");
  return { title, weekday, time: body.time, duration: Math.round(duration), location: str(body.location, 500) };
}

// ---------- route handlers ----------
async function getState(env) {
  const [series, users, meetings, items, links, changes] = await env.DB.batch([
    env.DB.prepare("SELECT id, title, weekday, time, duration, location FROM series ORDER BY sort, created_at"),
    env.DB.prepare("SELECT id, name, email, title, role, active FROM users ORDER BY name COLLATE NOCASE"),
    env.DB.prepare("SELECT id, series_id AS seriesId, date, title, attendees, notes, created_at AS createdAt FROM meetings ORDER BY date DESC"),
    env.DB.prepare("SELECT * FROM items ORDER BY created_at"),
    env.DB.prepare("SELECT item_id, user_id FROM item_assignees"),
    env.DB.prepare("SELECT series_id AS seriesId, orig_date AS origDate, new_date AS newDate, new_time AS newTime, note FROM series_changes WHERE orig_date >= ? OR new_date >= ?")
      .bind(addDaysISO(today(), -90), addDaysISO(today(), -90)),
  ]);
  const byItem = {};
  for (const l of links.results) (byItem[l.item_id] ||= []).push(l.user_id);
  return {
    series: series.results,
    changes: changes.results,
    users: users.results.map(publicUser),
    meetings: meetings.results,
    items: items.results.map(i => publicItem(i, byItem[i.id])),
  };
}

// Validates the tagged members; returns their ids and a names snapshot
async function assigneeFields(env, ids) {
  if (!Array.isArray(ids) || !ids.length) fail(400, "Tag at least one member on the action item.");
  ids = [...new Set(ids.map(String))].slice(0, 20);
  const rows = (await env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
  if (rows.length !== ids.length) fail(400, "One of those members no longer exists.");
  const name = Object.fromEntries(rows.map(r => [r.id, r.name]));
  return { ids, owner: ids.map(id => name[id]).join(", ") };
}
const assigneeStmts = (env, itemId, ids) => [
  env.DB.prepare("DELETE FROM item_assignees WHERE item_id = ?").bind(itemId),
  ...ids.map(uid => env.DB.prepare("INSERT INTO item_assignees (item_id, user_id) VALUES (?, ?)").bind(itemId, uid)),
];

async function route(req, env, path, method) {
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await req.json().catch(() => ({})) : {};

  // --- first-run setup: create the first admin while the users table is empty
  if (path === "setup" && method === "GET") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return json({ needsSetup: n.n === 0 });
  }
  if (path === "setup" && method === "POST") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    if (n.n > 0) fail(403, "Setup is already done. Sign in instead.");
    const name = str(body.name, 100), email = str(body.email, 200).toLowerCase();
    if (!name || !EMAIL_RE.test(email)) fail(400, "Enter your name and a valid email.");
    const salt = randomHex(16), id = newId("u");
    await env.DB.prepare("INSERT INTO users (id, name, email, role, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)")
      .bind(id, name, email, await hashPassword(checkPassword(body.password), salt), salt, Date.now()).run();
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, req, id) });
  }

  if (path === "login" && method === "POST") {
    const email = str(body.email, 200).toLowerCase();
    const u = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND active = 1").bind(email).first();
    const ok = u && safeEqual(await hashPassword(String(body.password || ""), u.pw_salt), u.pw_hash);
    if (!ok) fail(401, "Email or password is incorrect.");
    return json({ ok: true }, 200, { "set-cookie": await startSession(env, req, u.id) });
  }

  if (path === "logout" && method === "POST") {
    const token = readCookie(req, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookieHeader(req, "", 0) });
  }

  // --- everything below needs a signed-in participant
  const me = await currentUser(env, req);
  if (!me) fail(401, "Please sign in.");
  const admin = () => { if (me.role !== "admin") fail(403, "Only an admin can do that."); };
  const [res, id] = path.split("/");

  if (path === "me" && method === "GET") return json({ user: me });
  if (path === "state" && method === "GET") return json({ user: me, ...(await getState(env)) });

  if (path === "password" && method === "POST") {
    const u = await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?").bind(me.id).first();
    if (!safeEqual(await hashPassword(String(body.current || ""), u.pw_salt), u.pw_hash)) fail(400, "Current password is incorrect.");
    const salt = randomHex(16);
    await env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(await hashPassword(checkPassword(body.next), salt), salt, me.id).run();
    return json({ ok: true });
  }

  // --- meeting types (each a weekly slot with its own name, day and time)
  if (res === "series") {
    admin();
    if (method === "POST" && !id) {
      const f = seriesFields(body), sid = newId("s");
      const max = await env.DB.prepare("SELECT COALESCE(MAX(sort), -1) AS m FROM series").first();
      await env.DB.prepare("INSERT INTO series (id, title, weekday, time, duration, location, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(sid, f.title, f.weekday, f.time, f.duration, f.location, max.m + 1, Date.now()).run();
      return json({ ok: true, id: sid });
    }
    if (method === "PUT" && id) {
      const f = seriesFields(body);
      const r = await env.DB.prepare("UPDATE series SET title = ?, weekday = ?, time = ?, duration = ?, location = ? WHERE id = ?")
        .bind(f.title, f.weekday, f.time, f.duration, f.location, id).run();
      if (!r.meta.changes) fail(404, "Meeting type not found.");
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM series").first();
      if (n.n <= 1) fail(400, "Keep at least one meeting type.");
      // Recorded minutes stay; they just lose their link to the removed type
      await env.DB.batch([
        env.DB.prepare("UPDATE meetings SET series_id = NULL WHERE series_id = ?").bind(id),
        env.DB.prepare("DELETE FROM series_changes WHERE series_id = ?").bind(id),
        env.DB.prepare("DELETE FROM series WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // --- participants (admin manages accounts)
  if (res === "users") {
    admin();
    if (method === "POST" && !id) {
      const name = str(body.name, 100), email = str(body.email, 200).toLowerCase();
      if (!name || !EMAIL_RE.test(email)) fail(400, "Enter a name and a valid email.");
      if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "A participant with that email already exists.");
      const salt = randomHex(16), uid = newId("u");
      await env.DB.prepare("INSERT INTO users (id, name, email, title, role, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(uid, name, email, str(body.title, 100), body.role === "admin" ? "admin" : "member", await hashPassword(checkPassword(body.password), salt), salt, Date.now()).run();
      return json({ ok: true, id: uid });
    }
    if (method === "PUT" && id) {
      const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!u) fail(404, "Participant not found.");
      const name = str(body.name, 100) || u.name, email = (str(body.email, 200) || u.email).toLowerCase();
      if (!EMAIL_RE.test(email)) fail(400, "Enter a valid email.");
      const role = body.role === "admin" || body.role === "member" ? body.role : u.role;
      const active = body.active === undefined ? u.active : (body.active ? 1 : 0);
      if (id === me.id && (role !== "admin" || !active)) fail(400, "You can't remove your own admin access.");
      const dup = await env.DB.prepare("SELECT 1 FROM users WHERE email = ? AND id != ?").bind(email, id).first();
      if (dup) fail(409, "Another participant already uses that email.");
      const title = body.title === undefined ? u.title : str(body.title, 100);
      const stmts = [env.DB.prepare("UPDATE users SET name = ?, email = ?, title = ?, role = ?, active = ? WHERE id = ?").bind(name, email, title, role, active, id)];
      if (body.password) {
        const salt = randomHex(16);
        stmts.push(env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(await hashPassword(checkPassword(body.password), salt), salt, id));
      }
      if (body.password || !active) stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
      await env.DB.batch(stmts);
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      if (id === me.id) fail(400, "You can't delete your own account.");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM item_assignees WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // --- reschedule or cancel one date of a meeting type
  if (path === "reschedule" && method === "PUT") {
    admin();
    const seriesId = str(body.seriesId, 60), origDate = str(body.origDate, 10);
    const sr = await env.DB.prepare("SELECT weekday FROM series WHERE id = ?").bind(seriesId).first();
    if (!sr) fail(400, "That meeting type no longer exists.");
    if (!DATE_RE.test(origDate) || new Date(origDate + "T00:00:00Z").getUTCDay() !== sr.weekday) fail(400, "Pick one of the meeting's usual dates.");
    if (body.restore) {
      await env.DB.prepare("DELETE FROM series_changes WHERE series_id = ? AND orig_date = ?").bind(seriesId, origDate).run();
      return json({ ok: true });
    }
    let newDate = null, newTime = null;
    if (!body.cancel) {
      newDate = str(body.newDate, 10); newTime = str(body.newTime, 5);
      if (!DATE_RE.test(newDate) || !TIME_RE.test(newTime)) fail(400, "Pick the new date and time.");
    }
    await env.DB.prepare(`INSERT INTO series_changes (series_id, orig_date, new_date, new_time, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (series_id, orig_date) DO UPDATE SET new_date = excluded.new_date, new_time = excluded.new_time, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(seriesId, origDate, newDate, newTime, str(body.note, 500), me.id, Date.now()).run();
    return json({ ok: true });
  }

  // --- meetings
  if (res === "meetings") {
    const fields = () => {
      const date = str(body.date, 10), title = str(body.title, 200);
      if (!DATE_RE.test(date) || !title) fail(400, "A meeting needs a date and a title.");
      return { date, title, seriesId: str(body.seriesId, 60) || null, attendees: str(body.attendees, 2000), notes: str(body.notes, 50000) };
    };
    const checkSeries = async f => {
      if (f.seriesId && !(await env.DB.prepare("SELECT 1 FROM series WHERE id = ?").bind(f.seriesId).first())) fail(400, "That meeting type no longer exists.");
    };
    if (method === "POST" && !id) {
      const f = fields(), mid = newId("m"), now = Date.now();
      await checkSeries(f);
      await env.DB.prepare("INSERT INTO meetings (id, series_id, date, title, attendees, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(mid, f.seriesId, f.date, f.title, f.attendees, f.notes, me.id, now, now).run();
      return json({ ok: true, id: mid });
    }
    if (method === "PUT" && id) {
      const f = fields();
      await checkSeries(f);
      const r = await env.DB.prepare("UPDATE meetings SET series_id = ?, date = ?, title = ?, attendees = ?, notes = ?, updated_at = ? WHERE id = ?")
        .bind(f.seriesId, f.date, f.title, f.attendees, f.notes, Date.now(), id).run();
      if (!r.meta.changes) fail(404, "Meeting not found.");
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      admin();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM item_assignees WHERE item_id IN (SELECT id FROM items WHERE meeting_id = ?)").bind(id),
        env.DB.prepare("DELETE FROM items WHERE meeting_id = ?").bind(id),
        env.DB.prepare("DELETE FROM meetings WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  // --- action items
  if (res === "items") {
    if (method === "POST" && !id) {
      const task = str(body.task, 1000), due = str(body.due, 10), meetingId = str(body.meetingId, 60);
      if (!task || !DATE_RE.test(due)) fail(400, "An action item needs a description and a due date.");
      if (!(await env.DB.prepare("SELECT 1 FROM meetings WHERE id = ?").bind(meetingId).first())) fail(400, "That meeting no longer exists.");
      const a = await assigneeFields(env, body.assignees), iid = newId("i"), now = Date.now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO items (id, meeting_id, task, owner, due, status, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)")
          .bind(iid, meetingId, task, a.owner, due, now, now, me.id),
        ...assigneeStmts(env, iid, a.ids),
      ]);
      return json({ ok: true, id: iid });
    }
    if (method === "PATCH" && id) {
      const it = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first();
      if (!it) fail(404, "Action item not found.");
      const next = { task: it.task, owner: it.owner, due: it.due, status: it.status, progress_note: it.progress_note, done_at: it.done_at };
      if (body.task !== undefined) { next.task = str(body.task, 1000); if (!next.task) fail(400, "The action can't be empty."); }
      if (body.due !== undefined) { if (!DATE_RE.test(body.due)) fail(400, "Pick a valid due date."); next.due = body.due; }
      if (body.update !== undefined) next.progress_note = str(body.update, 5000);
      let a = null;
      if (body.assignees !== undefined) { a = await assigneeFields(env, body.assignees); next.owner = a.owner; }
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) fail(400, "Unknown status.");
        if (body.status === "done" && it.status !== "done") next.done_at = today();
        if (body.status !== "done") next.done_at = null;
        next.status = body.status;
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE items SET task = ?, owner = ?, due = ?, status = ?, progress_note = ?, done_at = ?, updated_at = ?, updated_by = ? WHERE id = ?")
          .bind(next.task, next.owner, next.due, next.status, next.progress_note, next.done_at, Date.now(), me.id, id),
        ...(a ? assigneeStmts(env, id, a.ids) : []),
      ]);
      return json({ ok: true });
    }
    if (method === "DELETE" && id) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM item_assignees WHERE item_id = ?").bind(id),
        env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  fail(404, "Not found.");
}

export async function onRequest({ request, env, params }) {
  const path = (Array.isArray(params.route) ? params.route : [params.route || ""]).join("/");
  const method = request.method.toUpperCase();
  // Same-origin check for writes (blocks cross-site form posts riding the cookie)
  if (method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return json({ error: "Cross-site request blocked." }, 403);
  }
  try {
    await ensureMigrated(env);
    return await route(request, env, path, method);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}
