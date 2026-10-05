import { TICKET_MS, WINDOW_MS, hmac, randomId, timingSafeEqual, verifyQrToken } from "./crypto";
import { fileName, toCsv, type RecordRow } from "./csv";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The lecturer's passcode, set with `npx wrangler secret put LECTURER_PASSCODE`. */
  LECTURER_PASSCODE: string;
}

interface Sheet {
  id: string;
  name: string;
  secret: string;
  status: "open" | "closed";
  created_at: number;
  opened_at: number | null;
  closed_at: number | null;
}

const ADMIN_COOKIE = "admin";
const DEVICE_COOKIE = "did";
const TICKET_COOKIE = "ticket";
const ADMIN_SESSION_MS = 30 * 24 * 3600_000;

// ---------------------------------------------------------------- helpers

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setCookie(req: Request, name: string, value: string, maxAgeSec: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// ---------------------------------------------------------------- lecturer auth

// The session cookie is signed with a key derived from the passcode, so
// changing the passcode signs every lecturer out.
async function adminSigningKey(env: Env): Promise<string> {
  return hmac(env.LECTURER_PASSCODE, "admin-session-v1");
}

async function makeAdminCookie(env: Env): Promise<string> {
  const exp = Date.now() + ADMIN_SESSION_MS;
  return `${exp}.${await hmac(await adminSigningKey(env), String(exp))}`;
}

async function isAdmin(req: Request, env: Env): Promise<boolean> {
  if (!env.LECTURER_PASSCODE) return false;
  const value = getCookie(req, ADMIN_COOKIE);
  if (!value) return false;
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now() || !sig) return false;
  return timingSafeEqual(sig, await hmac(await adminSigningKey(env), expStr));
}

async function login(req: Request, env: Env): Promise<Response> {
  if (!env.LECTURER_PASSCODE) return error(500, "LECTURER_PASSCODE is not configured on the server.");
  const { passcode } = await readJson<{ passcode: string }>(req);
  const given = await hmac("cmp", String(passcode ?? ""));
  const expected = await hmac("cmp", env.LECTURER_PASSCODE);
  if (!timingSafeEqual(given, expected)) return error(401, "Wrong passcode.");
  return json({ ok: true }, 200, {
    "set-cookie": setCookie(req, ADMIN_COOKIE, await makeAdminCookie(env), ADMIN_SESSION_MS / 1000),
  });
}

// ---------------------------------------------------------------- sheets (lecturer)

async function getSheet(env: Env, id: string): Promise<Sheet | null> {
  return env.DB.prepare("SELECT * FROM sheets WHERE id = ?").bind(id).first<Sheet>();
}

function publicSheet(s: Sheet, count?: number) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: s.created_at,
    openedAt: s.opened_at,
    closedAt: s.closed_at,
    ...(count === undefined ? {} : { count }),
  };
}

async function countFor(env: Env, id: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE sheet_id = ?").bind(id).first<{ n: number }>();
  return r?.n ?? 0;
}

async function adminApi(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (!(await isAdmin(req, env))) return error(401, "Please sign in.");
  const method = req.method;

  // /api/admin/sheets
  if (parts.length === 1 && parts[0] === "sheets") {
    if (method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM records r WHERE r.sheet_id = s.id) AS count
           FROM sheets s ORDER BY s.created_at DESC`,
      ).all<Sheet & { count: number }>();
      return json({ sheets: results.map((s) => publicSheet(s, s.count)) });
    }
    if (method === "POST") {
      const body = await readJson<{ name: string }>(req);
      const name = cleanText(body.name, 120);
      if (!name) return error(400, "Give the attendance sheet a name.");
      const sheet: Sheet = {
        id: randomId(8),
        name,
        secret: randomId(32),
        status: "closed",
        created_at: Date.now(),
        opened_at: null,
        closed_at: null,
      };
      await env.DB.prepare("INSERT INTO sheets (id, name, secret, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(sheet.id, sheet.name, sheet.secret, sheet.status, sheet.created_at)
        .run();
      return json({ sheet: publicSheet(sheet, 0) }, 201);
    }
    return error(405, "Method not allowed.");
  }

  if (parts[0] !== "sheets" || !parts[1]) return error(404, "Not found.");
  const sheet = await getSheet(env, parts[1]);
  if (!sheet) return error(404, "Attendance sheet not found.");
  const action = parts[2] ?? "";

  // /api/admin/sheets/:id
  if (action === "") {
    if (method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, student_name, student_id, flags, created_at FROM records WHERE sheet_id = ? ORDER BY created_at",
      )
        .bind(sheet.id)
        .all<RecordRow & { id: number }>();
      return json({
        sheet: publicSheet(sheet, results.length),
        records: results.map((r) => ({
          id: r.id,
          name: r.student_name,
          studentId: r.student_id,
          flags: r.flags,
          createdAt: r.created_at,
        })),
      });
    }
    if (method === "PATCH") {
      const body = await readJson<{ name: string }>(req);
      const name = cleanText(body.name, 120);
      if (!name) return error(400, "Give the attendance sheet a name.");
      await env.DB.prepare("UPDATE sheets SET name = ? WHERE id = ?").bind(name, sheet.id).run();
      return json({ sheet: publicSheet({ ...sheet, name }) });
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM records WHERE sheet_id = ?").bind(sheet.id),
        env.DB.prepare("DELETE FROM tickets WHERE sheet_id = ?").bind(sheet.id),
        env.DB.prepare("DELETE FROM sheets WHERE id = ?").bind(sheet.id),
      ]);
      return json({ ok: true });
    }
    return error(405, "Method not allowed.");
  }

  if (action === "open" && method === "POST") {
    const now = Date.now();
    await env.DB.prepare("UPDATE sheets SET status = 'open', opened_at = ?, closed_at = NULL WHERE id = ?")
      .bind(now, sheet.id)
      .run();
    return json({ sheet: publicSheet({ ...sheet, status: "open", opened_at: now, closed_at: null }) });
  }

  if (action === "close" && method === "POST") {
    const now = Date.now();
    await env.DB.prepare("UPDATE sheets SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, sheet.id).run();
    return json({ sheet: publicSheet({ ...sheet, status: "closed", closed_at: now }) });
  }

  // Everything the projector page needs to draw rotating codes locally.
  if (action === "present" && method === "GET") {
    return json({
      sheet: publicSheet(sheet, await countFor(env, sheet.id)),
      secret: sheet.secret,
      windowMs: WINDOW_MS,
      serverTime: Date.now(),
    });
  }

  if (action === "count" && method === "GET") {
    return json({ count: await countFor(env, sheet.id), status: sheet.status });
  }

  // /api/admin/sheets/:id/records/:recordId
  if (action === "records" && parts[3] && method === "DELETE") {
    await env.DB.prepare("DELETE FROM records WHERE id = ? AND sheet_id = ?").bind(Number(parts[3]), sheet.id).run();
    return json({ ok: true });
  }

  if (action === "export.csv" && method === "GET") {
    const tz = new URL(req.url).searchParams.get("tz") || "UTC";
    const { results } = await env.DB.prepare(
      "SELECT student_name, student_id, flags, created_at FROM records WHERE sheet_id = ? ORDER BY created_at",
    )
      .bind(sheet.id)
      .all<RecordRow>();
    const name = fileName(sheet.name);
    return new Response(toCsv(results, tz), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="attendance.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
      },
    });
  }

  return error(404, "Not found.");
}

// ---------------------------------------------------------------- students

/** GET /c/:sheetId/:window/:token, the URL inside the projected QR code. */
async function scan(req: Request, env: Env, sheetId: string, window: string, token: string): Promise<Response> {
  const sheet = await getSheet(env, sheetId);
  if (!sheet) return redirect("/checkin?error=unknown");
  if (sheet.status !== "open") return redirect("/checkin?error=closed");
  if (!(await verifyQrToken(sheet.secret, sheet.id, window, token))) return redirect("/checkin?error=expired");

  const now = Date.now();
  const cookies: string[] = [];
  let deviceId = getCookie(req, DEVICE_COOKIE);
  if (!deviceId || deviceId.length > 64) {
    deviceId = randomId(12);
    cookies.push(setCookie(req, DEVICE_COOKIE, deviceId, 400 * 24 * 3600));
  }

  const ticketId = randomId(18);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tickets WHERE expires_at < ?").bind(now - 24 * 3600_000),
    env.DB.prepare("INSERT INTO tickets (id, sheet_id, device_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
      ticketId,
      sheet.id,
      deviceId,
      now,
      now + TICKET_MS,
    ),
  ]);
  cookies.push(setCookie(req, TICKET_COOKIE, ticketId, TICKET_MS / 1000));
  // Redirecting drops the token from the address bar so it can't be re-shared.
  return redirect("/checkin", cookies);
}

interface TicketRow {
  id: string;
  sheet_id: string;
  device_id: string;
  expires_at: number;
  used_at: number | null;
  sheet_name: string;
}

async function loadTicket(req: Request, env: Env): Promise<TicketRow | null> {
  const id = getCookie(req, TICKET_COOKIE);
  if (!id) return null;
  return env.DB.prepare(
    `SELECT t.id, t.sheet_id, t.device_id, t.expires_at, t.used_at, s.name AS sheet_name
       FROM tickets t JOIN sheets s ON s.id = t.sheet_id WHERE t.id = ?`,
  )
    .bind(id)
    .first<TicketRow>();
}

async function checkinApi(req: Request, env: Env): Promise<Response> {
  const ticket = await loadTicket(req, env);
  const now = Date.now();
  if (!ticket) return error(403, "Scan the QR code shown in class to check in.");
  if (ticket.used_at) return error(409, "You have already checked in with this scan.");
  if (ticket.expires_at < now) return error(403, "Your check-in time ran out. Scan the QR code again.");

  if (req.method === "GET") {
    return json({ sheetName: ticket.sheet_name, expiresAt: ticket.expires_at, serverTime: now });
  }
  if (req.method !== "POST") return error(405, "Method not allowed.");

  const body = await readJson<{ name: string; studentId: string }>(req);
  const name = cleanText(body.name, 100);
  const studentId = cleanText(body.studentId, 40);
  if (!name || !studentId) return error(400, "Please enter both your name and your student ID.");

  const existing = await env.DB.prepare("SELECT 1 FROM records WHERE sheet_id = ? AND student_id = ?")
    .bind(ticket.sheet_id, studentId)
    .first();
  if (existing) return error(409, `Student ID ${studentId} is already checked in for this class.`);

  // Claim the ticket atomically so it can only be used once.
  const claim = await env.DB.prepare("UPDATE tickets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at >= ?")
    .bind(now, ticket.id, now)
    .run();
  if (!claim.meta.changes) return error(409, "This scan was already used. Scan the QR code again.");

  const flags: string[] = [];
  const sameDevice = await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE sheet_id = ? AND device_id = ?")
    .bind(ticket.sheet_id, ticket.device_id)
    .first<{ n: number }>();
  if (sameDevice && sameDevice.n > 0) flags.push("same device as another check-in");

  try {
    await env.DB.prepare(
      "INSERT INTO records (sheet_id, student_name, student_id, device_id, ip, flags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(ticket.sheet_id, name, studentId, ticket.device_id, req.headers.get("cf-connecting-ip"), flags.join("; "), now)
      .run();
  } catch {
    return error(409, `Student ID ${studentId} is already checked in for this class.`);
  }

  return json({ ok: true, sheetName: ticket.sheet_name, name, studentId }, 200, {
    "set-cookie": setCookie(req, TICKET_COOKIE, "", 0),
  });
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts[0] === "c" && parts.length === 4 && req.method === "GET") {
        return await scan(req, env, parts[1], parts[2], parts[3]);
      }
      if (parts[0] === "api") {
        if (parts[1] === "login" && req.method === "POST") return await login(req, env);
        if (parts[1] === "logout" && req.method === "POST") {
          return json({ ok: true }, 200, { "set-cookie": setCookie(req, ADMIN_COOKIE, "", 0) });
        }
        if (parts[1] === "checkin") return await checkinApi(req, env);
        if (parts[1] === "admin") return await adminApi(req, env, parts.slice(2));
        return error(404, "Not found.");
      }
    } catch (e) {
      console.error(e);
      return error(500, "Something went wrong. Please try again.");
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
