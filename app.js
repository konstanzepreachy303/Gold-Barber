require("dotenv").config();

// app.js
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
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

if (!process.env.SESSION_SECRET) {
  console.warn("⚠️ SESSION_SECRET não definido no .env. Em produção, defina uma chave segura.");
}

app.set("trust proxy", 1);

app.use(
  session({
    store: new pgSession({
      conString: process.env.DATABASE_URL,
      tableName: "user_sessions",
      createTableIfMissing: true,
      ssl:
        process.env.PGSSL === "true" ||
        /railway|render|supabase|neon/i.test(process.env.DATABASE_URL || "")
          ? { rejectUnauthorized: false }
          : false,
    }),
    secret: process.env.SESSION_SECRET || "dev_secret_troque_isso",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
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
const APP_TIMEZONE = process.env.APP_TIMEZONE || "America/Sao_Paulo";
const BOOKING_MIN_ADVANCE_MINUTES = Number(process.env.BOOKING_MIN_ADVANCE_MINUTES || 30);

function getNowInAppTimezone() {
  const now = new Date();
  return new Date(now.toLocaleString("en-US", { timeZone: APP_TIMEZONE }));
}

function todayYMD() {
  const d = getNowInAppTimezone();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Pode agendar se: agora <= (inicioDoSlot - minAdvanceMinutes)
 */
function canBookSlotLive(ymd, hhmm, minAdvanceMinutes = BOOKING_MIN_ADVANCE_MINUTES) {
  if (!isValidYMD(ymd)) return false;
  if (!hhmm || !/^\d{2}:\d{2}$/.test(String(hhmm))) return false;

  if (ymd !== todayYMD()) return true;

  const [y, mo, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);

  const now = getNowInAppTimezone();
  const slotStart = new Date(y, mo - 1, d, hh, mm, 0, 0);
  const cutoff = new Date(slotStart.getTime() - Number(minAdvanceMinutes) * 60 * 1000);

  return now.getTime() <= cutoff.getTime();
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

function parseMoneyToCents(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return 0;

  const cleaned = raw.replace(/[^\d,.-]/g, "");
  if (!cleaned) return 0;

  if (cleaned.includes(",")) {
    const normalized = cleaned.replace(/\./g, "").replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
  }

  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : 0;
}

function formatCentsBRL(cents) {
  const value = Number(cents || 0) / 100;
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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

// -------------------- ✅ garante admin do .env sem forçar senha fixa --------------------
async function ensureAdminDefault() {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
    `);

    const adminUsername = String(process.env.ADMIN_USERNAME || "").trim();
    const adminPassword = String(process.env.ADMIN_PASSWORD || "").trim();

    if (!adminUsername || !adminPassword) {
      console.warn("⚠️ ADMIN_USERNAME / ADMIN_PASSWORD não definidos no .env.");
      return;
    }

    const hash = await bcrypt.hash(adminPassword, 10);

    await dbRun(`DELETE FROM admin_users WHERE username != ?`, [adminUsername]);

    const existingUser = await dbGet(
      `SELECT id FROM admin_users WHERE username = ? LIMIT 1`,
      [adminUsername]
    );

    if (!existingUser) {
      await dbRun(
        `INSERT INTO admin_users (username, password_hash) VALUES (?, ?)`,
        [adminUsername, hash]
      );

      console.log(`✅ Admin criado: ${adminUsername}`);
    } else {
      await dbRun(
        `UPDATE admin_users SET password_hash = ? WHERE username = ?`,
        [hash, adminUsername]
      );

      console.log(`🔄 Senha do admin sincronizada com .env`);
    }
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

// -------------------- serviços helpers --------------------
function normalizeServiceSlots(service) {
  const duration = Number(service?.duration_minutes || 30);
  const byDuration = Math.ceil(duration / 30);
  const explicitSlots = Number(service?.slots_required || 0);
  return Math.max(1, explicitSlots || byDuration);
}

function buildConsecutive30MinSlots(startSlot, slotsRequired) {
  const startMinutes = toMinutes(startSlot);
  return Array.from({ length: slotsRequired }, (_, i) =>
    fromMinutes(startMinutes + i * 30)
  );
}

async function getServiceById(serviceId) {
  const id = Number(serviceId);
  if (!id) return null;

  return dbGet(
    `SELECT id, name, duration_minutes, slots_required, price_cents, is_active
       FROM services
      WHERE id = ?
      LIMIT 1`,
    [id]
  );
}

async function getActiveServices() {
  return dbAll(
    `SELECT id, name, duration_minutes, slots_required, price_cents, is_active
       FROM services
      WHERE is_active = 1
      ORDER BY name, id`
  );
}

async function generateServiceBaseSlotsForDateAndBarber(ymd, barberId) {
  if (!isValidYMD(ymd)) return [];

  const config = await loadBarberConfig(barberId);
  const dow = getDowFromYMD(ymd);
  const dayCfg = config.weekly?.[dow];

  if (!dayCfg?.enabled) return [];
  if (config.daysOffDates?.includes(ymd)) return [];

  const startMin = toMinutes(dayCfg.start);
  const endMin = toMinutes(dayCfg.end);
  const lunchStartMin = toMinutes(dayCfg.lunchStart);
  const lunchEndMin = toMinutes(dayCfg.lunchEnd);

  if (endMin <= startMin) return [];

  const result = [];
  for (let t = startMin; t + 30 <= endMin; t += 30) {
    const slotStart = t;
    const slotEnd = t + 30;

    const withinLunch = slotStart < lunchEndMin && slotEnd > lunchStartMin;
    if (withinLunch) continue;

    result.push(fromMinutes(t));
  }

  return result;
}

async function getOccupied30MinSlotsFromAgendamentos(barberId, ymd, opts = {}) {
  const ignoreAgendamentoId = Number(opts.ignoreAgendamentoId || 0) || 0;

  const rows = await dbAll(
    `SELECT id, horario, service_slots_required
       FROM agendamentos
      WHERE barber_id = ?
        AND data = ?
        AND status != 'cancelado'`,
    [barberId, ymd]
  );

  const ocupadosSet = new Set();

  for (const row of rows) {
    if (ignoreAgendamentoId && Number(row.id) === ignoreAgendamentoId) continue;

    const slotsRequired = Math.max(1, Number(row.service_slots_required || 1));
    const usedSlots = buildConsecutive30MinSlots(String(row.horario || ""), slotsRequired);
    usedSlots.forEach((h) => ocupadosSet.add(h));
  }

  return ocupadosSet;
}

async function getMensalistaBlocked30MinSlotsForDate(barberId, ymd, opts = {}) {
  const horarios = await getMensalistaBlockedHorariosForDate(barberId, ymd, opts);
  const set = new Set();

  for (const h of horarios) {
    if (!h) continue;
    set.add(h);
  }

  return set;
}

async function getAvailableSlotsForService({ barberId, ymd, serviceId }) {
  const service = await dbGet(
    `SELECT id, name, duration_minutes, slots_required, price_cents
       FROM services
      WHERE id = ?
        AND is_active = 1
      LIMIT 1`,
    [serviceId]
  );

  if (!service) return [];

  const slotsRequired = normalizeServiceSlots(service);
  const baseSlots = await generateServiceBaseSlotsForDateAndBarber(ymd, barberId);
  const baseSlotSet = new Set(baseSlots);

  const ocupadosSet = await getOccupied30MinSlotsFromAgendamentos(barberId, ymd);
  const mensalistaSet = await getMensalistaBlocked30MinSlotsForDate(barberId, ymd);

  const livres = baseSlots.filter((startSlot) => {
    const required = buildConsecutive30MinSlots(startSlot, slotsRequired);

    const allExist = required.every((slot) => baseSlotSet.has(slot));
    if (!allExist) return false;

    const allFree = required.every(
      (slot) => !ocupadosSet.has(slot) && !mensalistaSet.has(slot)
    );
    if (!allFree) return false;

    return canBookSlotLive(ymd, startSlot, BOOKING_MIN_ADVANCE_MINUTES);
  });

  return livres;
}

async function hasServiceConflict(barberId, ymd, horario, serviceSlotsRequired, opts = {}) {
  const requiredSlots = buildConsecutive30MinSlots(horario, Math.max(1, Number(serviceSlotsRequired || 1)));
  const baseSlots = await generateServiceBaseSlotsForDateAndBarber(ymd, barberId);
  const baseSet = new Set(baseSlots);

  const allExist = requiredSlots.every((slot) => baseSet.has(slot));
  if (!allExist) return true;

  const ocupadosSet = await getOccupied30MinSlotsFromAgendamentos(barberId, ymd, opts);
  const mensalistaSet = await getMensalistaBlocked30MinSlotsForDate(barberId, ymd, opts);

  for (const slot of requiredSlots) {
    if (ocupadosSet.has(slot) || mensalistaSet.has(slot)) {
      return true;
    }
  }

  return false;
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

  const weekly = {
    0: {
      enabled: !!cfg2.wd0,
      start: cfg2.start_0 || cfg2.start || "",
      end: cfg2.end_0 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_0 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_0 || cfg2.lunchend || "",
    },
    1: {
      enabled: !!cfg2.wd1,
      start: cfg2.start_1 || cfg2.start || "",
      end: cfg2.end_1 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_1 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_1 || cfg2.lunchend || "",
    },
    2: {
      enabled: !!cfg2.wd2,
      start: cfg2.start_2 || cfg2.start || "",
      end: cfg2.end_2 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_2 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_2 || cfg2.lunchend || "",
    },
    3: {
      enabled: !!cfg2.wd3,
      start: cfg2.start_3 || cfg2.start || "",
      end: cfg2.end_3 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_3 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_3 || cfg2.lunchend || "",
    },
    4: {
      enabled: !!cfg2.wd4,
      start: cfg2.start_4 || cfg2.start || "",
      end: cfg2.end_4 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_4 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_4 || cfg2.lunchend || "",
    },
    5: {
      enabled: !!cfg2.wd5,
      start: cfg2.start_5 || cfg2.start || "",
      end: cfg2.end_5 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_5 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_5 || cfg2.lunchend || "",
    },
    6: {
      enabled: !!cfg2.wd6,
      start: cfg2.start_6 || cfg2.start || "",
      end: cfg2.end_6 || cfg2.end || "",
      lunchStart: cfg2.lunchstart_6 || cfg2.lunchstart || "",
      lunchEnd: cfg2.lunchend_6 || cfg2.lunchend || "",
    },
  };

  return {
    barber_id: Number(barberId),
    start: cfg2.start,
    end: cfg2.end,
    lunchStart: cfg2.lunchstart || "",
    lunchEnd: cfg2.lunchend || "",
    slotMinutes: Number(cfg2.slotminutes) || 60,
    workDays,
    weekly,
    daysOffDates: offs.map((o) => o.ymd),
  };
}
async function generateSlotsForDateAndBarber(ymd, barberId) {
  if (!isValidYMD(ymd)) return [];

  const config = await loadBarberConfig(barberId);

  const dow = getDowFromYMD(ymd);
  const dayCfg = config.weekly?.[dow];

  if (!dayCfg?.enabled) return [];
  if (config.daysOffDates?.includes(ymd)) return [];

  const startMin = toMinutes(dayCfg.start);
  const endMin = toMinutes(dayCfg.end);
  const lunchStartMin = toMinutes(dayCfg.lunchStart);
  const lunchEndMin = toMinutes(dayCfg.lunchEnd);
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
  if (!cfg.weekly?.[wd]?.enabled) return null;

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

app.get("/servicos", async (req, res) => {
  try {
    const services = await getActiveServices();
    res.json(
      services.map((s) => ({
        ...s,
        price_label: formatCentsBRL(s.price_cents),
      }))
    );
  } catch (e) {
    console.error("❌ /servicos:", e);
    res.status(500).json([]);
  }
});

app.get("/horarios", async (req, res) => {
  const { data, barberId, serviceId } = req.query;
  const bId = Number(barberId);
  const sId = Number(serviceId);

  if (!data || !bId) return res.status(400).json([]);

  const barber = await dbGet(
    `SELECT id FROM barbers WHERE id = ? AND is_active = 1`,
    [bId]
  );
  if (!barber) return res.status(400).json([]);

  if (!sId) {
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

    livres = livres.filter((h) => canBookSlotLive(data, h, BOOKING_MIN_ADVANCE_MINUTES));

    return res.json(livres);
  }

  try {
    const livres = await getAvailableSlotsForService({
      barberId: bId,
      ymd: data,
      serviceId: sId,
    });

    return res.json(livres);
  } catch (e) {
    console.error("❌ /horarios com serviço:", e);
    return res.status(500).json([]);
  }
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

app.post("/agendar", async (req, res) => {
  try {
    const body = req.body || {};
    const nome = String(body.nome || "").trim();

    const telefoneRaw = String(body.telefone || "").trim();
    const telefone = telefoneRaw ? telefoneRaw.replace(/\D+/g, "") : "";

    const data = String(body.data || "").trim();
    const horario = String(body.horario || "").trim();
    const bId = Number(body.barberId);
    const serviceId = Number(body.serviceId);

    if (!nome || !data || !horario || !bId || !serviceId) {
      return res.status(400).send("❌ Preencha nome, barbeiro, serviço, data e horário.");
    }

    if (!isValidYMD(data)) return res.status(400).send("❌ Data inválida.");

    const barber = await dbGet(
      `SELECT * FROM barbers WHERE id = ? AND is_active = 1`,
      [bId]
    );
    if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

    const service = await dbGet(
      `SELECT id, name, duration_minutes, slots_required, price_cents, is_active
         FROM services
        WHERE id = ?
          AND is_active = 1
        LIMIT 1`,
      [serviceId]
    );
    if (!service) return res.status(400).send("❌ Serviço inválido.");

    const serviceSlotsRequired = normalizeServiceSlots(service);
    const servicePriceCents = Math.max(0, Number(service.price_cents || 0));
    const servicePriceLabel = formatCentsBRL(servicePriceCents);

    const available = await getAvailableSlotsForService({
      barberId: bId,
      ymd: data,
      serviceId,
    });

    if (!available.includes(horario)) {
      return res.status(400).send("❌ Horário indisponível para esse serviço.");
    }

    if (!canBookSlotLive(data, horario, BOOKING_MIN_ADVANCE_MINUTES)) {
      return res.status(400).send(`❌ Esse horário já passou do limite mínimo de antecedência (${BOOKING_MIN_ADVANCE_MINUTES} min).`);
    }

    const hasConflict = await hasServiceConflict(bId, data, horario, serviceSlotsRequired);
    if (hasConflict) {
      return res.status(400).send("❌ Horário indisponível.");
    }

    const telefoneToSave = telefone ? telefone : "00000000000";

    const ins = await dbRun(
      `INSERT INTO agendamentos (
         barber_id,
         nome,
         telefone,
         data,
         horario,
         status,
         service_id,
         service_name,
         service_duration_minutes,
         service_slots_required,
         service_price_cents
       )
       VALUES (?, ?, ?, ?, ?, 'reservado', ?, ?, ?, ?, ?)`,
      [
        bId,
        nome,
        telefoneToSave,
        data,
        horario,
        service.id,
        service.name,
        Number(service.duration_minutes || 30),
        serviceSlotsRequired,
        servicePriceCents,
      ]
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

    const servicePriceLine = servicePriceCents > 0 ? `💰 *VALOR:* ${servicePriceLabel}\n` : "";

    const waText =
`💈 *GOLD BARBER* 💈
_Confirmação de Agendamento_

👥 *Olá*, _*${nome}!*_

Seu horário foi reservado com sucesso.
Para garantir o atendimento, *confirme pelo link abaixo.*

━━━━━━━━━━━━━━━

*Detalhes do agendamento:*
💇🏽‍♂️ *PROFISSIONAL:* ${barber.name}
🧰 *SERVIÇO:* ${service.name}
${servicePriceLine}📌 *DIA:* ${dataFormatada}
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
      serviceName: service.name,
      servicePriceLabel,
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

  const services = await dbAll(
    `SELECT id, name, duration_minutes, slots_required, price_cents, is_active
       FROM services
      ORDER BY name, id`
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

  const selectedConfigBarberIdRaw = parsePositiveInt(req.query.configBarberId);
  const selectedConfigBarberId =
    (selectedConfigBarberIdRaw && barbers.some((b) => Number(b.id) === selectedConfigBarberIdRaw))
      ? selectedConfigBarberIdRaw
      : (barbers[0] ? Number(barbers[0].id) : 0);

  const selectedConfigBarber =
    barbers.find((b) => Number(b.id) === Number(selectedConfigBarberId)) || null;

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
const agendamentosRefreshSegundos = await getSettingInt("agendamentos_refresh_segundos", 30);

res.render("admin", {
  agendamentos,
  barbers,
  barberConfigs,
  mensalistas,
  mensalistaConfirmados,
  adminUser: req.session.adminUser,
  reservaExpiraMinutos,
  agendamentosRefreshSegundos,
  services,
  selectedConfigBarberId,
  selectedConfigBarber,
});
});

app.get("/admin/barbeiro/:id/config-json", requireAdmin, async (req, res) => {
  try {
    const barberId = Number(req.params.id);
    if (!barberId) return res.status(400).json({ ok: false });

    const barber = await dbGet(`SELECT id, name, is_active FROM barbers WHERE id = ? LIMIT 1`, [barberId]);
    if (!barber) return res.status(404).json({ ok: false });

    const config = await loadBarberConfig(barberId);

    return res.json({
      ok: true,
      barber,
      config,
    });
  } catch (e) {
    console.error("❌ /admin/barbeiro/:id/config-json:", e);
    return res.status(500).json({ ok: false });
  }
});

app.post("/admin/status", requireAdmin, async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ ok: false });

  await dbRun(`UPDATE agendamentos SET status = ? WHERE id = ?`, [status, id]);
  res.json({ ok: true });
});

app.post("/admin/config/reserva", requireAdmin, async (req, res) => {
  const minutos = Number((req.body || {}).reservaExpiraMinutos);
  const fixed = Number.isFinite(minutos)
    ? Math.max(1, Math.min(720, Math.floor(minutos)))
    : 30;

  const refreshMinutos = Number((req.body || {}).agendamentosRefreshMinutos);
  const refreshFixed = Number.isFinite(refreshMinutos)
     ? Math.max(1, Math.min(60, Math.floor(refreshMinutos))) * 60
     : 30;

  await setSetting("reserva_expira_minutos", fixed);
  await setSetting("agendamentos_refresh_segundos", refreshFixed);

  await cleanupReservasExpiradas();

  return res.redirect("/admin?tab=configgeral");
});

// -------------------- CRUD serviços admin --------------------
app.post("/admin/servicos/create", requireAdmin, async (req, res) => {
  try {
    const name = String((req.body || {}).name || "").trim();
    const durationMinutes = Number((req.body || {}).durationMinutes || 30);
    const slotsRequiredInput = Number((req.body || {}).slotsRequired || 0);
    const priceCents = parseMoneyToCents(
      (req.body || {}).price ?? (req.body || {}).priceCents ?? 0
    );

    if (!name) {
      return res.status(400).send("❌ Nome do serviço inválido.");
    }

    const duration = Math.max(30, Math.floor(durationMinutes || 30));
    const slotsRequired = Math.max(1, slotsRequiredInput || Math.ceil(duration / 30));

    await dbRun(
      `INSERT INTO services (name, duration_minutes, slots_required, price_cents, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [name, duration, slotsRequired, priceCents]
    );

    return res.redirect("/admin?tab=configgeral");
  } catch (e) {
    console.error("❌ /admin/servicos/create:", e);
    return res.status(500).send("❌ Erro ao criar serviço.");
  }
});

app.post("/admin/servicos/:id/update", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String((req.body || {}).name || "").trim();
    const durationMinutes = Number((req.body || {}).durationMinutes || 30);
    const slotsRequiredInput = Number((req.body || {}).slotsRequired || 0);
    const priceCents = parseMoneyToCents(
      (req.body || {}).price ?? (req.body || {}).priceCents ?? 0
    );

    if (!id || !name) {
      return res.status(400).send("❌ Dados inválidos.");
    }

    const duration = Math.max(30, Math.floor(durationMinutes || 30));
    const slotsRequired = Math.max(1, slotsRequiredInput || Math.ceil(duration / 30));

    await dbRun(
      `UPDATE services
          SET name = ?,
              duration_minutes = ?,
              slots_required = ?,
              price_cents = ?
        WHERE id = ?`,
      [name, duration, slotsRequired, priceCents, id]
    );

    return res.redirect("/admin?tab=configgeral");
  } catch (e) {
    console.error("❌ /admin/servicos/:id/update:", e);
    return res.status(500).send("❌ Erro ao atualizar serviço.");
  }
});

app.post("/admin/servicos/:id/toggle", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.redirect("/admin?tab=configgeral");

    const row = await dbGet(`SELECT is_active FROM services WHERE id = ?`, [id]);
    if (!row) return res.redirect("/admin?tab=configgeral");

    const next = Number(row.is_active) ? 0 : 1;

    await dbRun(
      `UPDATE services
          SET is_active = ?
        WHERE id = ?`,
      [next, id]
    );

    return res.redirect("/admin?tab=configgeral");
  } catch (e) {
    console.error("❌ /admin/servicos/:id/toggle:", e);
    return res.status(500).send("❌ Erro ao alterar status do serviço.");
  }
});

app.post("/admin/servicos/:id/delete", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.redirect("/admin?tab=configgeral");

    await dbRun(`DELETE FROM services WHERE id = ?`, [id]);

    return res.redirect("/admin?tab=configgeral");
  } catch (e) {
    console.error("❌ /admin/servicos/:id/delete:", e);
    return res.status(500).send("❌ Erro ao excluir serviço.");
  }
});

// -------------------- barbers admin --------------------
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

  return res.redirect(`/admin?tab=config&configBarberId=${newId}`);
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

  const barber = await dbGet(`SELECT id FROM barbers WHERE id = ? LIMIT 1`, [barberId]);
  if (!barber) {
    return res.status(400).send("❌ Barbeiro inválido.");
  }

  const slotMinutes = Number(body.slotMinutes) || 60;
  const daysOffDates = body.daysOffDates;

  await dbRun(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (?)`, [barberId]);

await dbRun(
  `UPDATE barber_config
   SET
     slotminutes = ?,

     wd0 = ?, start_0 = ?, end_0 = ?, lunchstart_0 = ?, lunchend_0 = ?,
     wd1 = ?, start_1 = ?, end_1 = ?, lunchstart_1 = ?, lunchend_1 = ?,
     wd2 = ?, start_2 = ?, end_2 = ?, lunchstart_2 = ?, lunchend_2 = ?,
     wd3 = ?, start_3 = ?, end_3 = ?, lunchstart_3 = ?, lunchend_3 = ?,
     wd4 = ?, start_4 = ?, end_4 = ?, lunchstart_4 = ?, lunchend_4 = ?,
     wd5 = ?, start_5 = ?, end_5 = ?, lunchstart_5 = ?, lunchend_5 = ?,
     wd6 = ?, start_6 = ?, end_6 = ?, lunchstart_6 = ?, lunchend_6 = ?

   WHERE barber_id = ?`,
    [
      slotMinutes,

      body.wd0 === "on" ? 1 : 0,
      String(body.start_0 || "").trim(),
      String(body.end_0 || "").trim(),
      String(body.lunchStart_0 || "").trim(),
      String(body.lunchEnd_0 || "").trim(),

      body.wd1 === "on" ? 1 : 0,
      String(body.start_1 || "").trim(),
      String(body.end_1 || "").trim(),
      String(body.lunchStart_1 || "").trim(),
      String(body.lunchEnd_1 || "").trim(),

      body.wd2 === "on" ? 1 : 0,
      String(body.start_2 || "").trim(),
      String(body.end_2 || "").trim(),
      String(body.lunchStart_2 || "").trim(),
      String(body.lunchEnd_2 || "").trim(),

      body.wd3 === "on" ? 1 : 0,
      String(body.start_3 || "").trim(),
      String(body.end_3 || "").trim(),
      String(body.lunchStart_3 || "").trim(),
      String(body.lunchEnd_3 || "").trim(),

      body.wd4 === "on" ? 1 : 0,
      String(body.start_4 || "").trim(),
      String(body.end_4 || "").trim(),
      String(body.lunchStart_4 || "").trim(),
      String(body.lunchEnd_4 || "").trim(),

      body.wd5 === "on" ? 1 : 0,
      String(body.start_5 || "").trim(),
      String(body.end_5 || "").trim(),
      String(body.lunchStart_5 || "").trim(),
      String(body.lunchEnd_5 || "").trim(),

      body.wd6 === "on" ? 1 : 0,
      String(body.start_6 || "").trim(),
      String(body.end_6 || "").trim(),
      String(body.lunchStart_6 || "").trim(),
      String(body.lunchEnd_6 || "").trim(),

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

  res.redirect(`/admin?tab=config&configBarberId=${barberId}`);
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
      new_horario = excluded.new_horario
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

// ✅ ADMIN: AGENDAR MANUALMENTE (sempre APROVADO) com serviço
app.post("/admin/agendar", requireAdmin, async (req, res) => {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();
  const dataInput = String(body.data || "").trim();
  const horario = String(body.horario || "").trim();
  const serviceId = Number(body.serviceId);

  const data = toYMD(dataInput);

  if (!barberId || !nome || !data || !horario || !serviceId) {
    return res.status(400).send("❌ Preencha: barbeiro, nome, serviço, data e horário.");
  }

  const barber = await dbGet(`SELECT id, name FROM barbers WHERE id = ?`, [barberId]);
  if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

  const service = await dbGet(
    `SELECT id, name, duration_minutes, slots_required, price_cents, is_active
       FROM services
      WHERE id = ?
        AND is_active = 1
      LIMIT 1`,
    [serviceId]
  );
  if (!service) return res.status(400).send("❌ Serviço inválido.");

  const serviceSlotsRequired = normalizeServiceSlots(service);
  const servicePriceCents = Math.max(0, Number(service.price_cents || 0));
  const servicePriceLabel = formatCentsBRL(servicePriceCents);

  const available = await getAvailableSlotsForService({
    barberId,
    ymd: data,
    serviceId,
  });

  if (!available.includes(horario)) {
    return res.status(400).send("❌ Horário indisponível para esse serviço.");
  }

  const conflict = await hasServiceConflict(barberId, data, horario, serviceSlotsRequired);
  if (conflict) {
    return res.status(400).send("❌ Já existe agendamento nesse horário para esse barbeiro.");
  }

  await dbRun(
    `INSERT INTO agendamentos (
       barber_id,
       nome,
       telefone,
       data,
       horario,
       status,
       service_id,
       service_name,
       service_duration_minutes,
       service_slots_required,
       service_price_cents
     )
     VALUES (?, ?, ?, ?, ?, 'aprovado', ?, ?, ?, ?, ?)`,
    [
      barberId,
      nome,
      telefone || "00000000000",
      data,
      horario,
      service.id,
      service.name,
      Number(service.duration_minutes || 30),
      serviceSlotsRequired,
      servicePriceCents,
    ]
  );

  return res.render("admin_sucesso", {
    barberName: barber.name,
    nome,
    telefone: telefone || "",
    data,
    horario,
    status: "confirmado",
    statusLabel: "confirmado",
    serviceName: service.name,
    servicePriceLabel,
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

