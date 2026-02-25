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

// ✅ WhatsApp oficial da barbearia (E.164 sem '+')
const BARBERSHOP_WPP =
  (process.env.BARBERSHOP_WPP || "5512988565206").replace(/\D/g, "");

// (opcional) se você tiver domínio oficial, pode setar BASE_URL no .env
const BASE_URL = process.env.BASE_URL ? String(process.env.BASE_URL).trim() : "";

// -------------------- basic config --------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

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

// Converte dd-mm-yyyy -> yyyy-mm-dd (aceita também yyyy-mm-dd)
function toYMD(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    const dd = m[1],
      mm = m[2],
      yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

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

// -------------------- phone helpers --------------------
function normalizePhoneBR(input) {
  let digits = String(input || "").replace(/\D+/g, "");
  digits = digits.replace(/^0+/, "");

  // remove 55 se vier com DDI
  if (digits.startsWith("55") && digits.length > 11) {
    digits = digits.slice(2);
  }

  // esperado: 10 ou 11 (DDD + número)
  return digits;
}

function buildBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
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

async function hasMensalistaConflict(barberId, ymd, horario) {
  if (!barberId || !isValidYMD(ymd) || !horario) return false;

  const dow = getDowFromYMD(ymd);

  const row = await dbGet(
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
    [barberId, dow, horario, ymd, ymd]
  );

  return !!row;
}

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

  const dow = getDowFromYMD(data);
  const mensalistaRows = await dbAll(
    `
    SELECT horario
      FROM mensalista_plans
     WHERE barber_id = ?
       AND dow = ?
       AND start_ymd <= ?
       AND (end_ymd IS NULL OR end_ymd = '' OR end_ymd >= ?)
  `,
    [bId, dow, data, data]
  );
  const travados = mensalistaRows.map((r) => r.horario);

  const livres = baseSlots.filter(
    (h) => !ocupados.includes(h) && !travados.includes(h)
  );

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

// ✅ confirmação pelo link único
app.get("/confirmar", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).send("❌ Token inválido.");

    const row = await dbGet(
      `
      SELECT t.id AS token_id,
             t.agendamento_id,
             t.expires_at,
             t.used_at,
             a.status
        FROM agendamento_confirm_tokens t
        JOIN agendamentos a ON a.id = t.agendamento_id
       WHERE t.token = ?
       LIMIT 1
    `,
      [token]
    );

    if (!row) return res.status(400).send("❌ Link inválido ou expirado.");

    if (row.used_at) {
      return res.sendFile(path.join(__dirname, "views", "sucesso.html"));
    }

    // expiração (melhor do que converter pra Date na marra: valida no sqlite mesmo)
    const stillValid = await dbGet(
      `SELECT 1 AS ok FROM agendamento_confirm_tokens WHERE id = ? AND datetime(expires_at) > datetime('now') LIMIT 1`,
      [row.token_id]
    );
    if (!stillValid) {
      return res.status(400).send("❌ Link expirado. Faça um novo agendamento.");
    }

    await dbRun(`UPDATE agendamentos SET status = 'aprovado' WHERE id = ?`, [
      row.agendamento_id,
    ]);
    await dbRun(
      `UPDATE agendamento_confirm_tokens SET used_at = datetime('now') WHERE id = ?`,
      [row.token_id]
    );

    return res.sendFile(path.join(__dirname, "views", "sucesso.html"));
  } catch (e) {
    console.error(e);
    return res.status(500).send("❌ Erro ao confirmar. Tente novamente.");
  }
});

// ✅ agendar (público) — 1 por dia por telefone + gera link WhatsApp da barbearia
app.post("/agendar", async (req, res) => {
  try {
    const body = req.body || {};
    const nome = String(body.nome || "").trim();
    const telefoneRaw = String(body.telefone || "").trim();
    const data = String(body.data || "").trim();
    const horario = String(body.horario || "").trim();
    const bId = Number(body.barberId);

    if (!nome || !telefoneRaw || !data || !horario || !bId) {
      return res
        .status(400)
        .send("❌ Preencha nome, telefone (com DDD), barbeiro, data e horário.");
    }

    const telefone = normalizePhoneBR(telefoneRaw);
    if (!(telefone.length === 10 || telefone.length === 11)) {
      return res
        .status(400)
        .send("❌ Telefone inválido. Digite com DDD (ex: 12988565206).");
    }

    if (!isValidYMD(data)) {
      return res.status(400).send("❌ Data inválida.");
    }

    const barber = await dbGet(
      `SELECT * FROM barbers WHERE id = ? AND is_active = 1`,
      [bId]
    );
    if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

    // ✅ 1 agendamento por dia por telefone (pela data do agendamento)
    const jaTemNoDia = await dbGet(
      `
      SELECT id
        FROM agendamentos
       WHERE telefone = ?
         AND data = ?
         AND status != 'cancelado'
       LIMIT 1
    `,
      [telefone, data]
    );
    if (jaTemNoDia) {
      return res
        .status(400)
        .send(
          "❌ Você já tem um horário marcado para essa data.\nSe precisa alterar, fale com a barbearia para remarcar/cancelar."
        );
    }

    const slots = await generateSlotsForDateAndBarber(data, bId);
    if (!slots.includes(horario)) {
      return res
        .status(400)
        .send("❌ Horário inválido para esse barbeiro nessa data.");
    }

    if (await hasMensalistaConflict(bId, data, horario)) {
      return res
        .status(400)
        .send("❌ Horário indisponível (reservado para mensalista).");
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

    // cria pendente
    const ins = await dbRun(
      `INSERT INTO agendamentos (barber_id, nome, telefone, data, horario, status)
       VALUES (?, ?, ?, ?, ?, 'agendado')`,
      [bId, nome, telefone, data, horario]
    );

    const agendamentoId = ins.lastID;

    // token link único (30 min)
    const token = crypto.randomBytes(24).toString("hex");
    await dbRun(
      `
      INSERT INTO agendamento_confirm_tokens (agendamento_id, token, expires_at)
      VALUES (?, ?, datetime('now', '+30 minutes'))
    `,
      [agendamentoId, token]
    );

    const baseUrl = buildBaseUrl(req);
    const confirmUrl = `${baseUrl}/confirmar?token=${encodeURIComponent(token)}`;

    // ✅ agora o WhatsApp abre PARA O NÚMERO DA BARBEARIA
    const waText =
      `Olá! Quero confirmar meu agendamento na Gold Barber:\n\n` +
      `👤 Cliente: ${nome}\n` +
      `📞 Telefone: ${telefone}\n` +
      `💇‍♂️ Barbeiro: ${barber.name}\n` +
      `📅 Data: ${data}\n` +
      `🕒 Horário: ${horario}\n\n` +
      `✅ Clique para confirmar: ${confirmUrl}`;

    const waLink = `https://wa.me/${BARBERSHOP_WPP}?text=${encodeURIComponent(waText)}`;

    return res.render("confirmar_whatsapp", {
      nome,
      telefone,
      barberName: barber.name,
      data,
      horario,
      confirmUrl,
      waLink,
      barbershopWppDisplay: "12 98856-5206",
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

  const user = await dbGet(`SELECT * FROM admin_users WHERE username = ?`, [
    username,
  ]);
  if (!user)
    return res.render("admin_login", { error: "Usuário/senha inválidos" });

  const ok = await bcrypt.compare(String(password || ""), user.password_hash);
  if (!ok)
    return res.render("admin_login", { error: "Usuário/senha inválidos" });

  req.session.adminUser = { id: user.id, username: user.username };
  return res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

// -------------------- ADMIN PANEL --------------------
app.get("/admin", requireAdmin, async (req, res) => {
  const barbers = await dbAll(
    `SELECT id, name, is_active FROM barbers ORDER BY id`
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
    ORDER BY p.barber_id, p.dow, p.horario
  `
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

    if (!isValidYMD(rangeStart) || !isValidYMD(rangeEnd) || rangeEnd < rangeStart)
      continue;

    let cursor = rangeStart;
    while (cursor <= rangeEnd && getDowFromYMD(cursor) !== Number(p.weekday)) {
      cursor = addDaysYMD(cursor, 1);
    }

    while (cursor <= rangeEnd) {
      mensalistaConfirmados.push({
        id: `m-${p.id}-${cursor}`,
        is_mensalista: true,
        barber_id: p.barber_id,
        barber_name: p.barber_name,
        nome: p.nome,
        telefone: p.telefone || "",
        data: cursor,
        horario: p.horario,
        status: "aprovado",
      });
      cursor = addDaysYMD(cursor, 7);
    }
  }

  res.render("admin", {
    agendamentos,
    barbers,
    barberConfigs,
    mensalistas,
    mensalistaConfirmados,
    adminUser: req.session.adminUser,
  });
});

app.post("/admin/status", requireAdmin, async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ ok: false });

  await dbRun(`UPDATE agendamentos SET status = ? WHERE id = ?`, [status, id]);
  res.json({ ok: true });
});

app.post("/admin/barbeiros/:id/toggle", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  const current = await dbGet(`SELECT is_active FROM barbers WHERE id = ?`, [
    barberId,
  ]);
  if (!current) return res.redirect("/admin");

  const next = current.is_active ? 0 : 1;
  await dbRun(`UPDATE barbers SET is_active = ? WHERE id = ?`, [next, barberId]);
  res.redirect("/admin");
});

app.post("/admin/barbeiros/:id/nome", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  const name = String((req.body || {}).name || "").trim();

  if (!name) return res.status(400).send("Nome inválido.");

  await dbRun(`UPDATE barbers SET name = ? WHERE id = ?`, [name, barberId]);
  res.redirect("/admin");
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

  res.redirect("/admin");
});

// -------------------- ✅ PLANO MENSALISTA --------------------
async function handleCreateMensalista(req, res) {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();

  const start_ymd = toYMD(String(body.start || "").trim());
  const endRaw = String(body.end || "").trim();
  const end_ymd = endRaw ? toYMD(endRaw) : null;

  const weekday = Number(body.weekday);
  const horario = String(body.horario || "").trim();

  if (!barberId || !nome || !start_ymd || !isValidYMD(start_ymd) || !horario) {
    return res
      .status(400)
      .send("❌ Preencha: barbeiro, nome, data início, dia da semana e horário.");
  }
  if (!(weekday >= 0 && weekday <= 6)) {
    return res.status(400).send("❌ Dia da semana inválido.");
  }
  if (end_ymd && !isValidYMD(end_ymd)) {
    return res.status(400).send("❌ Data fim inválida.");
  }
  if (end_ymd && end_ymd < start_ymd) {
    return res.status(400).send("❌ Data fim não pode ser menor que a data início.");
  }

  const slots = await slotsForWeekday(barberId, weekday);
  if (!slots.includes(horario)) {
    return res
      .status(400)
      .send(
        "❌ Horário inválido para o dia da semana escolhido (ou barbeiro não trabalha nesse dia)."
      );
  }

  const endCompare = end_ymd || "9999-12-31";
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
    [barberId, weekday, horario, endCompare, start_ymd]
  );

  if (existsPlan) {
    return res
      .status(400)
      .send(
        "❌ Já existe um mensalista nesse mesmo dia/horário para esse barbeiro (período sobreposto)."
      );
  }

  await dbRun(
    `
    INSERT INTO mensalista_plans
      (barber_id, client_name, client_phone, start_ymd, end_ymd, dow, horario)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    [barberId, nome, telefone || null, start_ymd, end_ymd, weekday, horario]
  );

  return res.redirect("/admin");
}

async function handleUpdateMensalista(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.redirect("/admin");

  const body = req.body || {};
  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();

  const start_ymd = toYMD(String(body.start || "").trim());
  const endRaw = String(body.end || "").trim();
  const end_ymd = endRaw ? toYMD(endRaw) : null;

  const weekday = Number(body.weekday);
  const horario = String(body.horario || "").trim();

  if (!barberId || !nome || !start_ymd || !isValidYMD(start_ymd) || !horario) {
    return res
      .status(400)
      .send("❌ Preencha: barbeiro, nome, data início, dia da semana e horário.");
  }
  if (!(weekday >= 0 && weekday <= 6)) {
    return res.status(400).send("❌ Dia da semana inválido.");
  }
  if (end_ymd && !isValidYMD(end_ymd)) {
    return res.status(400).send("❌ Data fim inválida.");
  }
  if (end_ymd && end_ymd < start_ymd) {
    return res.status(400).send("❌ Data fim não pode ser menor que a data início.");
  }

  const slots = await slotsForWeekday(barberId, weekday);
  if (!slots.includes(horario)) {
    return res
      .status(400)
      .send(
        "❌ Horário inválido para o dia da semana escolhido (ou barbeiro não trabalha nesse dia)."
      );
  }

  const endCompare = end_ymd || "9999-12-31";
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
    [id, barberId, weekday, horario, endCompare, start_ymd]
  );
  if (existsPlan) {
    return res
      .status(400)
      .send(
        "❌ Já existe um mensalista nesse mesmo dia/horário para esse barbeiro (período sobreposto)."
      );
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

  return res.redirect("/admin");
}

async function handleDeleteMensalista(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.redirect("/admin");
  await dbRun(`DELETE FROM mensalista_plans WHERE id = ?`, [id]);
  return res.redirect("/admin");
}

app.post("/admin/mensalistas", requireAdmin, handleCreateMensalista);
app.post("/admin/mensalistas/:id/update", requireAdmin, handleUpdateMensalista);
app.post("/admin/mensalistas/:id/delete", requireAdmin, handleDeleteMensalista);

// ✅ ADMIN: AGENDAR MANUALMENTE (mantido)
app.post("/admin/agendar", requireAdmin, async (req, res) => {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();
  const dataInput = String(body.data || "").trim();
  const horario = String(body.horario || "").trim();

  const status = String(body.status || "agendado").trim();
  const data = toYMD(dataInput);

  if (!barberId || !nome || !data || !horario) {
    return res.status(400).send("❌ Preencha: barbeiro, nome, data e horário.");
  }

  const barber = await dbGet(`SELECT id, name FROM barbers WHERE id = ?`, [barberId]);
  if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

  const slots = await generateSlotsForDateAndBarber(data, barberId);
  if (!slots.includes(horario)) {
    return res
      .status(400)
      .send("❌ Horário inválido para esse barbeiro nessa data (ou é folga).");
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
     VALUES (?, ?, ?, ?, ?, ?)`,
    [barberId, nome, telefone || "00000000000", data, horario, status || "agendado"]
  );

  return res.render("admin_sucesso", {
    barberName: barber.name,
    nome,
    telefone: telefone || "",
    data,
    horario,
    status,
  });
});

// -------------------- start --------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📲 WhatsApp oficial: ${BARBERSHOP_WPP}`);
  if (BASE_URL) console.log(`🌐 BASE_URL: ${BASE_URL}`);
});