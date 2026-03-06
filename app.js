// app.js
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ WhatsApp oficial da barbearia (fallback / E.164 sem '+')
const BARBERSHOP_WPP =
  (process.env.BARBERSHOP_WPP || "5512988565206").replace(/\D/g, "");

// (opcional) se você tiver domínio oficial, pode setar BASE_URL no .env
const BASE_URL = process.env.BASE_URL ? String(process.env.BASE_URL).trim() : "";

// -------------------- basic config --------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("view cache", false);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev_secret_troque_isso",
    resave: false,
    saveUninitialized: false,
  })
);

function requireAdmin(req, res, next) {
  if (req.session?.adminUser) return next();
  return res.redirect("/admin/login");
}

// -------------------- db helpers --------------------
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// -------------------- settings helpers --------------------
async function getSetting(key, fallback) {
  const row = await dbGet(`SELECT value FROM app_settings WHERE key = ? LIMIT 1`, [key]);
  if (!row) return fallback;
  return row.value;
}
async function getSettingInt(key, fallback) {
  const raw = await getSetting(key, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
async function setSetting(key, value) {
  await dbRun(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

// -------------------- date/time helpers --------------------
function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function getDowFromYMD(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).getDay(); // 0..6
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "00:00")
    .split(":")
    .map((x) => Number(x));
  return h * 60 + m;
}
function fromMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function formatDateToDMY(ymd) {
  if (!isValidYMD(ymd)) return ymd || "";
  const [y, m, d] = ymd.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * Converte datas para yyyy-mm-dd.
 * Aceita:
 *  - yyyy-mm-dd
 *  - dd-mm-yyyy
 *  - dd/mm/yyyy
 */
function toYMD(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  return null;
}

function addDaysYMD(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Number(days || 0));
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function todayYMD() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * ✅ Regra "horário ao vivo"
 * Pode agendar se: agora <= (inicioDoSlot - minAdvanceMinutes)
 */
function canBookSlotLive(ymd, hhmm, minAdvanceMinutes = 10) {
  if (!isValidYMD(ymd)) return false;
  if (!hhmm || !/^\d{2}:\d{2}$/.test(String(hhmm))) return false;

  if (ymd !== todayYMD()) return true;

  const [y, mo, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);

  const slotStart = new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
  const cutoff = slotStart - Number(minAdvanceMinutes) * 60 * 1000;

  return Date.now() <= cutoff;
}

// -------------------- misc helpers --------------------
function buildBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatWhatsAppDisplay(phoneDigits) {
  const digits = normalizePhoneDigits(phoneDigits);

  if (!digits) return "—";

  // 55 + DDD + 9XXXX + XXXX
  if (digits.length === 13 && digits.startsWith("55")) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }

  // DDD + 9XXXX + XXXX
  if (digits.length === 11) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }

  return digits;
}

async function getAgendamentoComBarbeiro(agendamentoId) {
  return dbGet(
    `
    SELECT a.*, b.name AS barber_name
      FROM agendamentos a
      JOIN barbers b ON b.id = a.barber_id
     WHERE a.id = ?
     LIMIT 1
  `,
    [agendamentoId]
  );
}

function buildStatusLabel(status) {
  if (status === "aprovado") return "confirmado";
  if (status === "reservado") return "agendado";
  if (status === "cancelado") return "cancelado";
  return status || "agendado";
}

function buildSuccessViewPayload(ag, cancelUrl, extra = {}) {
  const statusLabel = buildStatusLabel(ag?.status);

  return {
    pageTitle: extra.pageTitle || "Agendamento",
    heading: extra.heading || "✅ Agendamento confirmado",
    headingClass: extra.headingClass || "ok",
    subtitle: extra.subtitle || "O agendamento foi confirmado com sucesso.",
    primaryHref: "/",
    primaryLabel: "Agendar um novo horário",
    cancelLabel: "Cancelar",
    cancelUrl: ag?.status === "cancelado" ? "" : cancelUrl,
    barberName: ag?.barber_name || "",
    nome: ag?.nome || "",
    data: ag?.data || "",
    horario: ag?.horario || "",
    statusLabel,
    hint: extra.hint || "",
  };
}

// -------------------- ✅ garante admin/admin 123 --------------------
async function ensureAdminDefault() {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
    `);

    const hash = await bcrypt.hash("123", 10);

    await dbRun(
      `INSERT OR IGNORE INTO admin_users (username, password_hash) VALUES ('admin', ?)`,
      [hash]
    );

    // ✅ força senha sempre ser 123
    await dbRun(`UPDATE admin_users SET password_hash = ? WHERE username = 'admin'`, [hash]);
  } catch (e) {
    console.error("❌ ensureAdminDefault:", e);
  }
}

async function ensureMensalistaOverridesTable() {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS mensalista_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        original_date TEXT NOT NULL,
        new_date TEXT NOT NULL,
        new_horario TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(plan_id, original_date)
      );
    `);
  } catch (e) {
    console.error("❌ ensureMensalistaOverridesTable:", e);
  }
}

// -------------------- barber config & slots --------------------
async function loadBarberConfig(barberId) {
  const cfg = await dbGet(`SELECT * FROM barber_config WHERE barber_id = ?`, [barberId]);

  if (!cfg) {
    await dbRun(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (?)`, [barberId]);
  }

  const cfg2 = cfg || (await dbGet(`SELECT * FROM barber_config WHERE barber_id = ?`, [barberId]));

  const offs = await dbAll(
    `SELECT ymd FROM barber_days_off WHERE barber_id = ? ORDER BY ymd`,
    [barberId]
  );

  const workDays = {
    0: !!cfg2.wd0,
    1: !!cfg2.wd1,
    2: !!cfg2.wd2,
    3: !!cfg2.wd3,
    4: !!cfg2.wd4,
    5: !!cfg2.wd5,
    6: !!cfg2.wd6,
  };

  return {
    start: cfg2.start,
    end: cfg2.end,
    lunchStart: cfg2.lunchStart,
    lunchEnd: cfg2.lunchEnd,
    slotMinutes: Number(cfg2.slotMinutes) || 60,
    workDays,
    daysOffDates: offs.map((o) => o.ymd),
  };
}

async function generateSlotsForDateAndBarber(ymd, barberId) {
  if (!isValidYMD(ymd)) return [];

  const config = await loadBarberConfig(barberId);

  const dow = getDowFromYMD(ymd);
  if (!config.workDays?.[dow]) return [];
  if (config.daysOffDates?.includes(ymd)) return [];

  const startMin = toMinutes(config.start);
  const endMin = toMinutes(config.end);
  const lunchStartMin = toMinutes(config.lunchStart);
  const lunchEndMin = toMinutes(config.lunchEnd);
  const slot = Number(config.slotMinutes) || 60;

  if (endMin <= startMin) return [];
  if (slot <= 0 || slot > 240) return [];

  const result = [];
  for (let t = startMin; t + slot <= endMin; t += slot) {
    const withinLunch = t < lunchEndMin && t + slot > lunchStartMin;
    if (withinLunch) continue;
    result.push(fromMinutes(t));
  }
  return result;
}

async function sampleDateForWeekday(barberId, weekday) {
  const cfg = await loadBarberConfig(barberId);
  const wd = Number(weekday);

  if (!(wd >= 0 && wd <= 6)) return null;
  if (!cfg.workDays?.[wd]) return null;

  let cursor = todayYMD();
  for (let i = 0; i < 400; i++) {
    if (getDowFromYMD(cursor) === wd) break;
    cursor = addDaysYMD(cursor, 1);
  }

  for (let i = 0; i < 60; i++) {
    if (!cfg.daysOffDates?.includes(cursor)) return cursor;
    cursor = addDaysYMD(cursor, 7);
  }

  return null;
}

async function slotsForWeekday(barberId, weekday) {
  const sample = await sampleDateForWeekday(barberId, weekday);
  if (!sample) return [];
  return generateSlotsForDateAndBarber(sample, barberId);
}

async function getMensalistaBlockedEntriesForDate(barberId, ymd, opts = {}) {
  if (!barberId || !isValidYMD(ymd)) return [];

  const ignorePlanId = Number(opts.ignorePlanId || 0) || 0;
  const ignoreOriginalDate = opts.ignoreOriginalDate ? String(opts.ignoreOriginalDate) : "";

  const dow = getDowFromYMD(ymd);

  const planRows = await dbAll(
    `
    SELECT id AS plan_id, horario
      FROM mensalista_plans
     WHERE barber_id = ?
       AND dow = ?
       AND start_ymd <= ?
       AND (end_ymd IS NULL OR end_ymd = '' OR end_ymd >= ?)
  `,
    [barberId, dow, ymd, ymd]
  );

  let blocked = planRows.map((r) => ({
    plan_id: Number(r.plan_id),
    horario: String(r.horario || ""),
    source: "plan",
    original_date: null,
  }));

  const overrideRows = await dbAll(
    `
    SELECT
      o.plan_id,
      o.original_date,
      o.new_date,
      o.new_horario,
      p.horario AS base_horario
    FROM mensalista_overrides o
    JOIN mensalista_plans p ON p.id = o.plan_id
    WHERE p.barber_id = ?
      AND (o.original_date = ? OR o.new_date = ?)
  `,
    [barberId, ymd, ymd]
  );

  for (const o of overrideRows) {
    const planId = Number(o.plan_id);
    const baseHorario = String(o.base_horario || "");
    const originalDate = String(o.original_date || "");
    const newDate = String(o.new_date || "");
    const newHorario = String(o.new_horario || "");

    if (originalDate === ymd) {
      blocked = blocked.filter(
        (item) => !(item.plan_id === planId && item.source === "plan" && item.horario === baseHorario)
      );
    }

    if (newDate === ymd) {
      blocked.push({
        plan_id: planId,
        horario: newHorario,
        source: "override",
        original_date: originalDate,
      });
    }
  }

  if (ignorePlanId && ignoreOriginalDate) {
    blocked = blocked.filter(
      (item) =>
        !(
          item.plan_id === ignorePlanId &&
          item.source === "override" &&
          item.original_date === ignoreOriginalDate
        )
    );
  }

  return blocked;
}

async function getMensalistaBlockedHorariosForDate(barberId, ymd, opts = {}) {
  const entries = await getMensalistaBlockedEntriesForDate(barberId, ymd, opts);
  return [...new Set(entries.map((e) => e.horario).filter(Boolean))];
}

async function hasMensalistaConflict(barberId, ymd, horario, opts = {}) {
  if (!barberId || !isValidYMD(ymd) || !horario) return false;
  const blocked = await getMensalistaBlockedHorariosForDate(barberId, ymd, opts);
  return blocked.includes(horario);
}

// -------------------- ✅ LIMPEZA: apaga reservados expirados --------------------
async function cleanupReservasExpiradas() {
  try {
    const minutos = await getSettingInt("reserva_expira_minutos", 30);

    await dbRun(`
      DELETE FROM agendamento_confirm_tokens
       WHERE used_at IS NULL
         AND datetime(expires_at) <= datetime('now')
    `);

    await dbRun(`
      DELETE FROM agendamento_cancel_tokens
       WHERE used_at IS NULL
         AND datetime(expires_at) <= datetime('now')
    `);

    const rows = await dbAll(
      `
      SELECT id
        FROM agendamentos
       WHERE status = 'reservado'
         AND datetime(created_at) <= datetime('now', ?)
    `,
      [`-${minutos} minutes`]
    );

    if (!rows.length) return;

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    await dbRun(
      `DELETE FROM agendamento_confirm_tokens WHERE agendamento_id IN (${placeholders})`,
      ids
    );
    await dbRun(
      `DELETE FROM agendamento_cancel_tokens WHERE agendamento_id IN (${placeholders})`,
      ids
    );
    await dbRun(`DELETE FROM agendamentos WHERE id IN (${placeholders})`, ids);
  } catch (e) {
    console.error("❌ cleanupReservasExpiradas:", e);
  }
}

// roda a cada 60s
setInterval(cleanupReservasExpiradas, 60 * 1000);

// -------------------- PUBLIC ROUTES --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "agendar.html"));
});

app.get("/barbeiros", async (req, res) => {
  const barbers = await dbAll(
    `SELECT id, name FROM barbers WHERE is_active = 1 ORDER BY id`
  );
  res.json(barbers);
});

app.get("/horarios", async (req, res) => {
  const { data, barberId } = req.query;
  const bId = Number(barberId);

  if (!data || !bId) return res.status(400).json([]);

  const barber = await dbGet(
    `SELECT id FROM barbers WHERE id = ? AND is_active = 1`,
    [bId]
  );
  if (!barber) return res.status(400).json([]);

  const baseSlots = await generateSlotsForDateAndBarber(data, bId);

  const ocupadosRows = await dbAll(
    `SELECT horario FROM agendamentos
     WHERE barber_id = ?
       AND data = ?
       AND status != 'cancelado'`,
    [bId, data]
  );
  const ocupados = ocupadosRows.map((r) => r.horario);

  const travados = await getMensalistaBlockedHorariosForDate(bId, data);

  let livres = baseSlots.filter(
    (h) => !ocupados.includes(h) && !travados.includes(h)
  );

  livres = livres.filter((h) => canBookSlotLive(data, h, 10));

  res.json(livres);
});

app.get("/horarios_weekday", async (req, res) => {
  const bId = Number(req.query.barberId);
  const weekday = Number(req.query.weekday);

  if (!bId || !(weekday >= 0 && weekday <= 6)) return res.json([]);

  const barber = await dbGet(
    `SELECT id FROM barbers WHERE id = ? AND is_active = 1`,
    [bId]
  );
  if (!barber) return res.json([]);

  const slots = await slotsForWeekday(bId, weekday);
  res.json(slots);
});

// ✅ confirmação pelo link único (vira APROVADO)
app.get("/confirmar", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).send("❌ Token inválido.");

    const row = await dbGet(
      `
      SELECT t.id AS token_id,
             t.agendamento_id,
             t.expires_at,
             t.used_at
        FROM agendamento_confirm_tokens t
       WHERE t.token = ?
       LIMIT 1
    `,
      [token]
    );

    if (!row) return res.status(400).send("❌ Link inválido ou expirado.");

    const agAntes = await getAgendamentoComBarbeiro(row.agendamento_id);
    if (!agAntes) return res.status(404).send("❌ Agendamento não encontrado.");

    const cancelTokenRow = await dbGet(
      `
      SELECT token
        FROM agendamento_cancel_tokens
       WHERE agendamento_id = ?
       LIMIT 1
    `,
      [row.agendamento_id]
    );

    const baseUrl = buildBaseUrl(req);
    const cancelUrl = cancelTokenRow?.token
      ? `${baseUrl}/cancelar?token=${encodeURIComponent(cancelTokenRow.token)}`
      : "";

    if (agAntes.status === "cancelado") {
      return res.render(
        "sucesso",
        buildSuccessViewPayload(agAntes, "", {
          pageTitle: "Agendamento cancelado",
          heading: "⚠️ Horário já cancelado",
          headingClass: "warn",
          subtitle: "Este horário já foi cancelado pelo cliente.",
          hint: "O link de cancelamento já foi utilizado anteriormente.",
        })
      );
    }

    if (row.used_at) {
      return res.render(
        "sucesso",
        buildSuccessViewPayload(agAntes, cancelUrl, {
          pageTitle: "Agendamento confirmado",
          heading: "✅ Agendamento confirmado",
          headingClass: "ok",
          subtitle: "Este agendamento já estava confirmado.",
          hint: "Caso precise, você ainda pode cancelar este horário pelo botão abaixo.",
        })
      );
    }

    const stillValid = await dbGet(
      `SELECT 1 AS ok
         FROM agendamento_confirm_tokens
        WHERE id = ?
          AND datetime(expires_at) > datetime('now')
        LIMIT 1`,
      [row.token_id]
    );

    if (!stillValid) {
      return res.status(400).send("❌ Link expirado. Faça um novo agendamento.");
    }

    await dbRun(`UPDATE agendamentos SET status = 'aprovado' WHERE id = ?`, [
      row.agendamento_id,
    ]);

    await dbRun(
      `UPDATE agendamento_confirm_tokens
          SET used_at = datetime('now')
        WHERE id = ?`,
      [row.token_id]
    );

    const agDepois = await getAgendamentoComBarbeiro(row.agendamento_id);

    return res.render(
      "sucesso",
      buildSuccessViewPayload(agDepois, cancelUrl, {
        pageTitle: "Agendamento confirmado",
        heading: "✅ Agendamento confirmado",
        headingClass: "ok",
        subtitle: "O agendamento foi confirmado com sucesso.",
        hint: "Se mudar de ideia, você pode cancelar este horário pelo botão abaixo.",
      })
    );
  } catch (e) {
    console.error(e);
    return res.status(500).send("❌ Erro ao confirmar. Tente novamente.");
  }
});

// ✅ tela de cancelamento pelo link único
app.get("/cancelar", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).send("❌ Token inválido.");

    const row = await dbGet(
      `
      SELECT t.id AS token_id,
             t.agendamento_id,
             t.expires_at,
             t.used_at
        FROM agendamento_cancel_tokens t
       WHERE t.token = ?
       LIMIT 1
    `,
      [token]
    );

    if (!row) return res.status(400).send("❌ Link inválido ou expirado.");

    const ag = await getAgendamentoComBarbeiro(row.agendamento_id);
    if (!ag) return res.status(404).send("❌ Agendamento não encontrado.");

    const alreadyCancelled = ag.status === "cancelado" || !!row.used_at;

    return res.render("cancelar_agendamento", {
      token,
      barberName: ag?.barber_name || "",
      nome: ag?.nome || "",
      data: ag?.data || "",
      horario: ag?.horario || "",
      statusLabel: buildStatusLabel(ag?.status),
      alreadyCancelled,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send("❌ Erro ao abrir a tela de cancelamento.");
  }
});

// ✅ confirmação final do cancelamento
app.post("/cancelar/confirmar", async (req, res) => {
  try {
    const token = String((req.body || {}).token || "").trim();
    if (!token) return res.status(400).send("❌ Token inválido.");

    const row = await dbGet(
      `
      SELECT t.id AS token_id,
             t.agendamento_id,
             t.expires_at,
             t.used_at
        FROM agendamento_cancel_tokens t
       WHERE t.token = ?
       LIMIT 1
    `,
      [token]
    );

    if (!row) return res.status(400).send("❌ Link inválido ou expirado.");

    const agAntes = await getAgendamentoComBarbeiro(row.agendamento_id);
    if (!agAntes) return res.status(404).send("❌ Agendamento não encontrado.");

    if (agAntes.status === "cancelado" || row.used_at) {
      return res.render(
        "sucesso",
        buildSuccessViewPayload(agAntes, "", {
          pageTitle: "Agendamento cancelado",
          heading: "⚠️ Horário já cancelado",
          headingClass: "warn",
          subtitle: "Este horário já foi cancelado pelo cliente.",
          hint: "O link de cancelamento não pode mais ser utilizado.",
        })
      );
    }

    const stillValid = await dbGet(
      `SELECT 1 AS ok
         FROM agendamento_cancel_tokens
        WHERE id = ?
          AND datetime(expires_at) > datetime('now')
        LIMIT 1`,
      [row.token_id]
    );

    if (!stillValid) {
      return res.status(400).send("❌ Link de cancelamento expirado.");
    }

    await dbRun(`UPDATE agendamentos SET status = 'cancelado' WHERE id = ?`, [
      row.agendamento_id,
    ]);

    await dbRun(
      `UPDATE agendamento_cancel_tokens
          SET used_at = datetime('now')
        WHERE id = ?`,
      [row.token_id]
    );

    const agDepois = await getAgendamentoComBarbeiro(row.agendamento_id);

    return res.render(
      "sucesso",
      buildSuccessViewPayload(agDepois, "", {
        pageTitle: "Agendamento cancelado",
        heading: "❌ Agendamento cancelado",
        headingClass: "danger",
        subtitle: "O horário foi cancelado com sucesso.",
        hint: "Este link de cancelamento já foi consumido e não poderá ser reutilizado.",
      })
    );
  } catch (e) {
    console.error(e);
    return res.status(500).send("❌ Erro ao cancelar. Tente novamente.");
  }
});

// ✅ agendar (público) — cria RESERVADO e tokens expiram no tempo configurado
app.post("/agendar", async (req, res) => {
  try {
    const body = req.body || {};
    const nome = String(body.nome || "").trim();

    const telefoneRaw = String(body.telefone || "").trim();
    const telefone = telefoneRaw ? telefoneRaw.replace(/\D+/g, "") : "";

    const data = String(body.data || "").trim();
    const horario = String(body.horario || "").trim();
    const bId = Number(body.barberId);

    if (!nome || !data || !horario || !bId) {
      return res.status(400).send("❌ Preencha nome, barbeiro, data e horário.");
    }

    if (!isValidYMD(data)) return res.status(400).send("❌ Data inválida.");

    const barber = await dbGet(
      `SELECT * FROM barbers WHERE id = ? AND is_active = 1`,
      [bId]
    );
    if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

    const slots = await generateSlotsForDateAndBarber(data, bId);
    if (!slots.includes(horario)) {
      return res.status(400).send("❌ Horário inválido para esse barbeiro nessa data.");
    }

    if (!canBookSlotLive(data, horario, 10)) {
      return res.status(400).send("❌ Esse horário já passou do limite mínimo de antecedência (10 min).");
    }

    if (await hasMensalistaConflict(bId, data, horario)) {
      return res.status(400).send("❌ Horário indisponível (mensalista).");
    }

    const conflito = await dbGet(
      `SELECT id FROM agendamentos
       WHERE barber_id = ?
         AND data = ?
         AND horario = ?
         AND status != 'cancelado'
       LIMIT 1`,
      [bId, data, horario]
    );
    if (conflito) return res.status(400).send("❌ Horário indisponível.");

    const telefoneToSave = telefone ? telefone : "00000000000";

    const ins = await dbRun(
      `INSERT INTO agendamentos (barber_id, nome, telefone, data, horario, status)
       VALUES (?, ?, ?, ?, ?, 'reservado')`,
      [bId, nome, telefoneToSave, data, horario]
    );
    const agendamentoId = ins.lastID;

    const minutos = await getSettingInt("reserva_expira_minutos", 30);

    const confirmToken = crypto.randomBytes(24).toString("hex");
    const cancelToken = crypto.randomBytes(24).toString("hex");

    await dbRun(
      `
      INSERT INTO agendamento_confirm_tokens (agendamento_id, token, expires_at)
      VALUES (?, ?, datetime('now', ?))
    `,
      [agendamentoId, confirmToken, `+${minutos} minutes`]
    );

    await dbRun(
      `
      INSERT INTO agendamento_cancel_tokens (agendamento_id, token, expires_at)
      VALUES (?, ?, datetime('now', ?))
    `,
      [agendamentoId, cancelToken, `+${minutos} minutes`]
    );

    const baseUrl = buildBaseUrl(req);
    const confirmUrl = `${baseUrl}/confirmar?token=${encodeURIComponent(confirmToken)}`;
    const cancelUrl = `${baseUrl}/cancelar?token=${encodeURIComponent(cancelToken)}`;

    const redirectPhone = normalizePhoneDigits(barber.redirect_phone) || BARBERSHOP_WPP;
    const dataFormatada = formatDateToDMY(data);

    const waText =
`💈 *GOLD BARBER* 💈
_Confirmação de Agendamento_

👥 *Olá*, _*${nome}!*_

Seu horário foi reservado com sucesso.
Para garantir o atendimento, *confirme pelo link abaixo.*

━━━━━━━━━━━━━━━

*Detalhes do agendamento:*
💇🏽‍♂️ *PROFISSIONAL:* ${barber.name}
📌 *DIA:* ${dataFormatada}
⌚ *HORÁRIO:* ${horario}

━━━━━━━━━━━━━━━

✅ *Confirme clicando no link abaixo:*
${confirmUrl}

━━━━━━━━━━━━━━━

❌ *Cancelar horário:*
${cancelUrl}

━━━━━━━━━━━━━━━

⚠️ A confirmação é necessária para manter o horário reservado.
⏳ O link expira em ${minutos} minutos.

*COMPROVANTE DE AGENDAMENTO*`;

    return res.render("confirmar_whatsapp", {
      nome,
      telefone: telefone || "",
      barberName: barber.name,
      data,
      horario,
      confirmUrl,
      cancelUrl,
      waText,
      reservaExpiraMinutos: minutos,
      barbershopWppDisplay: formatWhatsAppDisplay(redirectPhone),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).send("❌ Erro ao agendar. Tente novamente.");
  }
});

// -------------------- ADMIN AUTH --------------------
app.get("/admin/login", (req, res) => {
  res.render("admin_login", { error: null });
});

app.post("/admin/login", async (req, res) => {
  const { username, password } = req.body || {};

  const user = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [username]);
  if (!user) return res.render("admin_login", { error: "Usuário/senha inválidos" });

  const ok = await bcrypt.compare(String(password || ""), user.password_hash);
  if (!ok) return res.render("admin_login", { error: "Usuário/senha inválidos" });

  req.session.adminUser = { id: user.id, username: user.username };
  return res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

// -------------------- ADMIN PANEL --------------------
app.get("/admin", requireAdmin, async (req, res) => {
  await cleanupReservasExpiradas();

  const barbers = await dbAll(
    `SELECT id, name, redirect_phone, is_active FROM barbers ORDER BY id`
  );

  const agendamentos = await dbAll(
    `SELECT a.*, b.name AS barber_name
     FROM agendamentos a
     JOIN barbers b ON b.id = a.barber_id
     ORDER BY a.data, a.horario`
  );

  const barberConfigs = {};
  for (const b of barbers) {
    barberConfigs[b.id] = await loadBarberConfig(b.id);
  }

  const mensalistas = await dbAll(
    `
    SELECT
      p.id,
      p.barber_id,
      b.name AS barber_name,
      p.client_name AS nome,
      p.client_phone AS telefone,
      p.start_ymd,
      p.end_ymd,
      p.dow AS weekday,
      p.horario
    FROM mensalista_plans p
    JOIN barbers b ON b.id = p.barber_id
    ORDER BY p.barber_id, p.start_ymd, p.horario
  `
  );

  const overrideRows = await dbAll(
    `
    SELECT plan_id, original_date, new_date, new_horario
      FROM mensalista_overrides
  `
  );
  const overrideMap = new Map(
    overrideRows.map((o) => [
      `${Number(o.plan_id)}::${String(o.original_date || "")}`,
      {
        new_date: String(o.new_date || ""),
        new_horario: String(o.new_horario || ""),
      },
    ])
  );

  const today = todayYMD();
  const winStart = addDaysYMD(today, -365);
  const winEnd = addDaysYMD(today, 365);

  const mensalistaConfirmados = [];
  for (const p of mensalistas) {
    const start = p.start_ymd;
    const end = p.end_ymd && String(p.end_ymd).trim() ? p.end_ymd : null;

    const rangeStart = start > winStart ? start : winStart;
    const rangeEnd = end ? (end < winEnd ? end : winEnd) : winEnd;

    if (!isValidYMD(rangeStart) || !isValidYMD(rangeEnd) || rangeEnd < rangeStart) continue;

    let cursor = rangeStart;
    while (cursor <= rangeEnd && getDowFromYMD(cursor) !== Number(p.weekday)) {
      cursor = addDaysYMD(cursor, 1);
    }

    while (cursor <= rangeEnd) {
      const overrideKey = `${Number(p.id)}::${cursor}`;
      const override = overrideMap.get(overrideKey);

      const finalDate = override?.new_date || cursor;
      const finalHorario = override?.new_horario || p.horario;

      mensalistaConfirmados.push({
        id: `m-${p.id}-${cursor}`,
        is_mensalista: true,
        barber_id: p.barber_id,
        barber_name: p.barber_name,
        nome: p.nome,
        telefone: p.telefone || "",
        data: finalDate,
        horario: finalHorario,
        status: "aprovado",
      });

      cursor = addDaysYMD(cursor, 7);
    }
  }

  const reservaExpiraMinutos = await getSettingInt("reserva_expira_minutos", 30);

  res.render("admin", {
    agendamentos,
    barbers,
    barberConfigs,
    mensalistas,
    mensalistaConfirmados,
    adminUser: req.session.adminUser,
    reservaExpiraMinutos,
  });
});

app.post("/admin/status", requireAdmin, async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ ok: false });

  await dbRun(`UPDATE agendamentos SET status = ? WHERE id = ?`, [status, id]);
  res.json({ ok: true });
});

// ✅ salvar tempo de expiração na aba Configuração
app.post("/admin/config/reserva", requireAdmin, async (req, res) => {
  const minutos = Number((req.body || {}).reservaExpiraMinutos);
  const fixed = Number.isFinite(minutos) ? Math.max(1, Math.min(720, Math.floor(minutos))) : 30;

  await setSetting("reserva_expira_minutos", fixed);
  await cleanupReservasExpiradas();

  return res.redirect("/admin?tab=configgeral");
});

// -------------------- barbers admin --------------------

// ✅ criar novo barbeiro
app.post("/admin/barbeiros/create", requireAdmin, async (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  const redirectPhone = normalizePhoneDigits((req.body || {}).redirectPhone || "");

  if (!name) return res.status(400).send("Nome inválido.");

  const ins = await dbRun(
    `INSERT INTO barbers (name, redirect_phone, is_active) VALUES (?, ?, 1)`,
    [name, redirectPhone || null]
  );
  const newId = ins.lastID;

  await dbRun(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (?)`, [newId]);

  return res.redirect("/admin?tab=configgeral");
});

app.post("/admin/barbeiros/:id/toggle", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  const current = await dbGet(`SELECT is_active FROM barbers WHERE id = ?`, [barberId]);
  if (!current) return res.redirect("/admin?tab=configgeral");

  const next = current.is_active ? 0 : 1;
  await dbRun(`UPDATE barbers SET is_active = ? WHERE id = ?`, [next, barberId]);
  res.redirect("/admin?tab=configgeral");
});

app.post("/admin/barbeiros/:id/nome", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  const name = String((req.body || {}).name || "").trim();
  const redirectPhone = normalizePhoneDigits((req.body || {}).redirectPhone || "");

  if (!name) return res.status(400).send("Nome inválido.");

  await dbRun(
    `UPDATE barbers SET name = ?, redirect_phone = ? WHERE id = ?`,
    [name, redirectPhone || null, barberId]
  );
  res.redirect("/admin?tab=configgeral");
});

// ✅ EXCLUIR barbeiro
app.post("/admin/barbeiros/:id/delete", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  if (!barberId) return res.redirect("/admin?tab=configgeral");

  const total = await dbGet(`SELECT COUNT(*) AS c FROM barbers`);
  if (total && Number(total.c) <= 1) {
    return res.status(400).send("❌ Não é possível excluir o último barbeiro.");
  }

  await dbRun(`DELETE FROM barbers WHERE id = ?`, [barberId]);
  return res.redirect("/admin?tab=configgeral");
});

app.post("/admin/barbeiro/:id/config", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  const body = req.body || {};

  const {
    start,
    end,
    lunchStart,
    lunchEnd,
    slotMinutes,
    wd0,
    wd1,
    wd2,
    wd3,
    wd4,
    wd5,
    wd6,
    daysOffDates,
  } = body;

  await dbRun(
    `UPDATE barber_config
     SET start=?, end=?, lunchStart=?, lunchEnd=?, slotMinutes=?,
         wd0=?, wd1=?, wd2=?, wd3=?, wd4=?, wd5=?, wd6=?
     WHERE barber_id=?`,
    [
      start,
      end,
      lunchStart,
      lunchEnd,
      Number(slotMinutes) || 60,
      wd0 === "on" ? 1 : 0,
      wd1 === "on" ? 1 : 0,
      wd2 === "on" ? 1 : 0,
      wd3 === "on" ? 1 : 0,
      wd4 === "on" ? 1 : 0,
      wd5 === "on" ? 1 : 0,
      wd6 === "on" ? 1 : 0,
      barberId,
    ]
  );

  await dbRun(`DELETE FROM barber_days_off WHERE barber_id = ?`, [barberId]);

  const parsedDates = String(daysOffDates || "")
    .split(/[\s,;]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toYMD)
    .filter(Boolean)
    .filter(isValidYMD);

  for (const ymd of parsedDates) {
    await dbRun(
      `INSERT OR IGNORE INTO barber_days_off (barber_id, ymd) VALUES (?, ?)`,
      [barberId, ymd]
    );
  }

  res.redirect("/admin?tab=config");
});

// -------------------- ✅ PLANO MENSALISTA --------------------
async function handleCreateMensalista(req, res) {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();

  const start_ymd = toYMD(String(body.start || "").trim());
  const horario = String(body.horario || "").trim();

  if (!barberId || !nome || !start_ymd || !isValidYMD(start_ymd) || !horario) {
    return res.status(400).send("❌ Preencha: barbeiro, nome, data inicial e horário.");
  }

  const weekday = getDowFromYMD(start_ymd);
  const end_ymd = addDaysYMD(start_ymd, 21);

  const barber = await dbGet(`SELECT id FROM barbers WHERE id = ? AND is_active = 1`, [barberId]);
  if (!barber) {
    return res.status(400).send("❌ Barbeiro inválido.");
  }

  const slots = await generateSlotsForDateAndBarber(start_ymd, barberId);
  if (!slots.includes(horario)) {
    return res.status(400).send("❌ Horário inválido para a data inicial escolhida.");
  }

  for (let i = 0; i < 4; i++) {
    const currentDate = addDaysYMD(start_ymd, i * 7);

    const validSlots = await generateSlotsForDateAndBarber(currentDate, barberId);
    if (!validSlots.includes(horario)) {
      return res.status(400).send(`❌ O horário ${horario} não está disponível na data ${currentDate}.`);
    }

    const conflitoAgendamento = await dbGet(
      `SELECT id
         FROM agendamentos
        WHERE barber_id = ?
          AND data = ?
          AND horario = ?
          AND status != 'cancelado'
        LIMIT 1`,
      [barberId, currentDate, horario]
    );

    if (conflitoAgendamento) {
      return res.status(400).send(`❌ Já existe agendamento no horário ${horario} na data ${currentDate}.`);
    }
  }

  const existsPlan = await dbGet(
    `
    SELECT id
      FROM mensalista_plans
     WHERE barber_id = ?
       AND dow = ?
       AND horario = ?
       AND start_ymd <= ?
       AND (end_ymd IS NULL OR end_ymd = '' OR end_ymd >= ?)
     LIMIT 1
  `,
    [barberId, weekday, horario, end_ymd, start_ymd]
  );

  if (existsPlan) {
    return res.status(400).send("❌ Já existe mensalista nesse dia/horário (período sobreposto).");
  }

  await dbRun(
    `
    INSERT INTO mensalista_plans
      (barber_id, client_name, client_phone, start_ymd, end_ymd, dow, horario)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    [barberId, nome, telefone || null, start_ymd, end_ymd, weekday, horario]
  );

  return res.redirect("/admin?tab=mensalistas");
}

async function handleUpdateMensalista(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.redirect("/admin?tab=mensalistas");

  const body = req.body || {};
  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();

  const start_ymd = toYMD(String(body.start || "").trim());
  const horario = String(body.horario || "").trim();

  if (!barberId || !nome || !start_ymd || !isValidYMD(start_ymd) || !horario) {
    return res.status(400).send("❌ Preencha: barbeiro, nome, data inicial e horário.");
  }

  const weekday = getDowFromYMD(start_ymd);
  const end_ymd = addDaysYMD(start_ymd, 21);

  const barber = await dbGet(`SELECT id FROM barbers WHERE id = ? AND is_active = 1`, [barberId]);
  if (!barber) {
    return res.status(400).send("❌ Barbeiro inválido.");
  }

  const slots = await generateSlotsForDateAndBarber(start_ymd, barberId);
  if (!slots.includes(horario)) {
    return res.status(400).send("❌ Horário inválido para a data inicial escolhida.");
  }

  for (let i = 0; i < 4; i++) {
    const currentDate = addDaysYMD(start_ymd, i * 7);

    const validSlots = await generateSlotsForDateAndBarber(currentDate, barberId);
    if (!validSlots.includes(horario)) {
      return res.status(400).send(`❌ O horário ${horario} não está disponível na data ${currentDate}.`);
    }

    const conflitoAgendamento = await dbGet(
      `SELECT id
         FROM agendamentos
        WHERE barber_id = ?
          AND data = ?
          AND horario = ?
          AND status != 'cancelado'
        LIMIT 1`,
      [barberId, currentDate, horario]
    );

    if (conflitoAgendamento) {
      return res.status(400).send(`❌ Já existe agendamento no horário ${horario} na data ${currentDate}.`);
    }
  }

  const existsPlan = await dbGet(
    `
    SELECT id
      FROM mensalista_plans
     WHERE id != ?
       AND barber_id = ?
       AND dow = ?
       AND horario = ?
       AND start_ymd <= ?
       AND (end_ymd IS NULL OR end_ymd = '' OR end_ymd >= ?)
     LIMIT 1
  `,
    [id, barberId, weekday, horario, end_ymd, start_ymd]
  );

  if (existsPlan) {
    return res.status(400).send("❌ Já existe mensalista nesse dia/horário (sobreposto).");
  }

  await dbRun(
    `
    UPDATE mensalista_plans
       SET barber_id = ?,
           client_name = ?,
           client_phone = ?,
           start_ymd = ?,
           end_ymd = ?,
           dow = ?,
           horario = ?
     WHERE id = ?
  `,
    [barberId, nome, telefone || null, start_ymd, end_ymd, weekday, horario, id]
  );

  return res.redirect("/admin?tab=mensalistas");
}

async function handleTrocarHorarioMensalista(req, res) {
  const body = req.body || {};

  const planId = Number(body.planId);
  const barberId = Number(body.barberId);
  const originalDate = toYMD(String(body.originalDate || "").trim());
  const originalHorario = String(body.originalHorario || "").trim();
  const newDate = toYMD(String(body.newDate || "").trim());
  const newHorario = String(body.newHorario || "").trim();

  if (!planId || !barberId || !originalDate || !newDate || !originalHorario || !newHorario) {
    return res.status(400).send("❌ Preencha os dados da troca de horário.");
  }

  if (!isValidYMD(originalDate) || !isValidYMD(newDate)) {
    return res.status(400).send("❌ Data inválida.");
  }

  const plan = await dbGet(
    `
    SELECT id, barber_id, start_ymd, end_ymd, dow, horario
      FROM mensalista_plans
     WHERE id = ?
     LIMIT 1
  `,
    [planId]
  );

  if (!plan || Number(plan.barber_id) !== barberId) {
    return res.status(400).send("❌ Plano mensalista inválido.");
  }

  if (originalDate < plan.start_ymd || (plan.end_ymd && String(plan.end_ymd).trim() && originalDate > plan.end_ymd)) {
    return res.status(400).send("❌ A ocorrência original está fora do período do plano.");
  }

  const slots = await generateSlotsForDateAndBarber(newDate, barberId);
  if (!slots.includes(newHorario)) {
    return res.status(400).send("❌ Novo horário inválido para a data escolhida.");
  }

  const conflitoAgendamento = await dbGet(
    `SELECT id
       FROM agendamentos
      WHERE barber_id = ?
        AND data = ?
        AND horario = ?
        AND status != 'cancelado'
      LIMIT 1`,
    [barberId, newDate, newHorario]
  );

  if (conflitoAgendamento) {
    return res.status(400).send("❌ Já existe agendamento nesse horário.");
  }

  const conflitoMensalista = await hasMensalistaConflict(barberId, newDate, newHorario, {
    ignorePlanId: planId,
    ignoreOriginalDate: originalDate,
  });

  if (conflitoMensalista) {
    return res.status(400).send("❌ Já existe mensalista nesse novo dia/horário.");
  }

  await dbRun(
    `
    INSERT INTO mensalista_overrides (plan_id, original_date, new_date, new_horario, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(plan_id, original_date)
    DO UPDATE SET
      new_date = excluded.new_date,
      new_horario = excluded.new_horario,
      updated_at = datetime('now')
  `,
    [planId, originalDate, newDate, newHorario]
  );

  return res.redirect("/admin?tab=agendamentos");
}

async function handleDeleteMensalista(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.redirect("/admin?tab=mensalistas");
  await dbRun(`DELETE FROM mensalista_overrides WHERE plan_id = ?`, [id]);
  await dbRun(`DELETE FROM mensalista_plans WHERE id = ?`, [id]);
  return res.redirect("/admin?tab=mensalistas");
}

app.post("/admin/mensalistas", requireAdmin, handleCreateMensalista);
app.post("/admin/mensalistas/:id/update", requireAdmin, handleUpdateMensalista);
app.post("/admin/mensalistas/:id/delete", requireAdmin, handleDeleteMensalista);
app.post("/admin/mensalistas/trocar-horario", requireAdmin, handleTrocarHorarioMensalista);

// ✅ ADMIN: AGENDAR MANUALMENTE (SEM STATUS — sempre APROVADO)
app.post("/admin/agendar", requireAdmin, async (req, res) => {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();
  const dataInput = String(body.data || "").trim();
  const horario = String(body.horario || "").trim();

  const data = toYMD(dataInput);

  if (!barberId || !nome || !data || !horario) {
    return res.status(400).send("❌ Preencha: barbeiro, nome, data e horário.");
  }

  const barber = await dbGet(`SELECT id, name FROM barbers WHERE id = ?`, [barberId]);
  if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

  const slots = await generateSlotsForDateAndBarber(data, barberId);
  if (!slots.includes(horario)) {
    return res.status(400).send("❌ Horário inválido para esse barbeiro nessa data (ou é folga).");
  }

  if (await hasMensalistaConflict(barberId, data, horario)) {
    return res.status(400).send("❌ Esse horário está reservado para um mensalista.");
  }

  const conflito = await dbGet(
    `SELECT id FROM agendamentos
     WHERE barber_id = ?
       AND data = ?
       AND horario = ?
       AND status != 'cancelado'
     LIMIT 1`,
    [barberId, data, horario]
  );

  if (conflito) {
    return res.status(400).send("❌ Já existe agendamento nesse horário para esse barbeiro.");
  }

  await dbRun(
    `INSERT INTO agendamentos (barber_id, nome, telefone, data, horario, status)
     VALUES (?, ?, ?, ?, ?, 'aprovado')`,
    [barberId, nome, telefone || "00000000000", data, horario]
  );

  return res.render("admin_sucesso", {
    barberName: barber.name,
    nome,
    telefone: telefone || "",
    data,
    horario,
    status: "confirmado",
    statusLabel: "confirmado",
  });
});

// -------------------- start --------------------
(async () => {
  await ensureAdminDefault();
  await ensureMensalistaOverridesTable();
  await cleanupReservasExpiradas();

  app.listen(PORT, () => {
    console.log(`✅ Server Online http://localhost:${PORT}`);
    if (BASE_URL) console.log(`🌐 BASE_URL: ${BASE_URL}`);
  });
})();
