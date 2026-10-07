// B2B Weekly MoM portal API (Cloudflare Pages Function, D1 binding "DB").
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

// ---------- route handlers ----------
async function getState(env) {
  const [settings, users, meetings, items, links] = await env.DB.batch([
    env.DB.prepare("SELECT weekday, time, duration, title, location FROM settings WHERE id = 1"),
    env.DB.prepare("SELECT id, name, email, title, role, active FROM users ORDER BY name COLLATE NOCASE"),
    env.DB.prepare("SELECT id, date, title, attendees, notes, created_at AS createdAt FROM meetings ORDER BY date DESC"),
    env.DB.prepare("SELECT * FROM items ORDER BY created_at"),
    env.DB.prepare("SELECT item_id, user_id FROM item_assignees"),
  ]);
  const byItem = {};
  for (const l of links.results) (byItem[l.item_id] ||= []).push(l.user_id);
  return {
    settings: settings.results[0],
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

  if (path === "settings" && method === "PUT") {
    admin();
    const weekday = Number(body.weekday), duration = Number(body.duration);
    if (!(weekday >= 0 && weekday <= 6) || !TIME_RE.test(body.time || "") || !(duration >= 15 && duration <= 600)) fail(400, "Check the day, time and length.");
    await env.DB.prepare("UPDATE settings SET weekday = ?, time = ?, duration = ?, title = ?, location = ? WHERE id = 1")
      .bind(weekday, body.time, Math.round(duration), str(body.title, 200) || "UAE B2B Weekly Meeting", str(body.location, 500)).run();
    return json({ ok: true });
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

  // --- meetings
  if (res === "meetings") {
    const fields = () => {
      const date = str(body.date, 10), title = str(body.title, 200);
      if (!DATE_RE.test(date) || !title) fail(400, "A meeting needs a date and a title.");
      return { date, title, attendees: str(body.attendees, 2000), notes: str(body.notes, 50000) };
    };
    if (method === "POST" && !id) {
      const f = fields(), mid = newId("m"), now = Date.now();
      await env.DB.prepare("INSERT INTO meetings (id, date, title, attendees, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(mid, f.date, f.title, f.attendees, f.notes, me.id, now, now).run();
      return json({ ok: true, id: mid });
    }
    if (method === "PUT" && id) {
      const f = fields();
      const r = await env.DB.prepare("UPDATE meetings SET date = ?, title = ?, attendees = ?, notes = ?, updated_at = ? WHERE id = ?")
        .bind(f.date, f.title, f.attendees, f.notes, Date.now(), id).run();
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
    return await route(request, env, path, method);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong on the server." }, 500);
  }
}
