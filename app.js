// app.js
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcrypt");

const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

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

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // já é YMD

  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/); // DMY
  if (m) {
    const dd = m[1],
      mm = m[2],
      yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

async function loadBarberConfig(barberId) {
  const cfg = await dbGet(`SELECT * FROM barber_config WHERE barber_id = ?`, [
    barberId,
  ]);

  if (!cfg) {
    await dbRun(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (?)`, [
      barberId,
    ]);
  }

  const cfg2 =
    cfg ||
    (await dbGet(`SELECT * FROM barber_config WHERE barber_id = ?`, [barberId]));

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
    daysOffDates: offs.map((o) => o.ymd), // yyyy-mm-dd
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

// ✅ NOVO: conflito com plano mensalista (regra recorrente semanal)
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

// -------------------- whatsapp token (optional) --------------------
const wppTokens = new Map(); // token -> { wa_id, expiresAt }
function cleanupTokens() {
  const now = Date.now();
  for (const [token, info] of wppTokens.entries()) {
    if (!info?.expiresAt || info.expiresAt <= now) wppTokens.delete(token);
  }
}

// rota opcional p/ teste
app.get("/wpp/token/mock", (req, res) => {
  const token = Math.random().toString(36).slice(2);
  wppTokens.set(token, {
    wa_id: "5599999999999",
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  res.json({ token });
});

// -------------------- PUBLIC ROUTES --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "agendar.html"));
});

// lista barbeiros ativos (pra montar select no agendamento)
app.get("/barbeiros", async (req, res) => {
  const barbers = await dbAll(
    `SELECT id, name FROM barbers WHERE is_active = 1 ORDER BY id`
  );
  res.json(barbers);
});

// horários disponíveis (exige barberId)
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

  // ✅ NOVO: remove slots “travados” pelo mensalista
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

// agendar (público)
app.post("/agendar", async (req, res) => {
  const body = req.body || {};
  const { nome, telefone, data, horario, token, barberId } = body;
  const bId = Number(barberId);

  if (!nome || !data || !horario || !bId) {
    return res.status(400).send("❌ Preencha nome, barbeiro, data e horário.");
  }

  const barber = await dbGet(
    `SELECT * FROM barbers WHERE id = ? AND is_active = 1`,
    [bId]
  );
  if (!barber) return res.status(400).send("❌ Barbeiro inválido.");

  const slots = await generateSlotsForDateAndBarber(data, bId);
  if (!slots.includes(horario)) {
    return res
      .status(400)
      .send("❌ Horário inválido para esse barbeiro nessa data.");
  }

  // ✅ NOVO: bloqueia se for mensalista
  if (await hasMensalistaConflict(bId, data, horario)) {
    return res.status(400).send("❌ Horário indisponível (reservado para mensalista).");
  }

  let telefoneFinal = String(telefone || "").trim();

  if (token) {
    cleanupTokens();
    const info = wppTokens.get(token);
    if (!info?.wa_id) {
      return res
        .status(400)
        .send("❌ Link expirado. Peça um novo link no WhatsApp.");
    }
    telefoneFinal = info.wa_id;
  } else {
    telefoneFinal = telefoneFinal || "00000000000";
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

  if (conflito) return res.send("❌ Horário indisponível");

  // público normalmente entra como "agendado" (aguardando)
  await dbRun(
    `INSERT INTO agendamentos (barber_id, nome, telefone, data, horario, status)
     VALUES (?, ?, ?, ?, ?, 'agendado')`,
    [bId, nome, telefoneFinal, data, horario]
  );

  return res.sendFile(path.join(__dirname, "views", "sucesso.html"));
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

  // ✅ NOVO: listar planos mensalistas
  const mensalistaPlans = await dbAll(
    `
    SELECT p.*, b.name AS barber_name
      FROM mensalista_plans p
      JOIN barbers b ON b.id = p.barber_id
     ORDER BY p.barber_id, p.dow, p.horario
  `
  );

  res.render("admin", {
    agendamentos,
    barbers,
    barberConfigs,
    mensalistaPlans, // ✅ manda pro admin.ejs
    adminUser: req.session.adminUser,
  });
});

// mudar status agendamento
app.post("/admin/status", requireAdmin, async (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) return res.status(400).json({ ok: false });

  await dbRun(`UPDATE agendamentos SET status = ? WHERE id = ?`, [status, id]);
  res.json({ ok: true });
});

// listar agendamentos (json)
app.get("/admin/agendamentos", requireAdmin, async (req, res) => {
  const rows = await dbAll(
    `SELECT a.*, b.name AS barber_name
     FROM agendamentos a
     JOIN barbers b ON b.id = a.barber_id
     ORDER BY a.data, a.horario`
  );
  res.json(rows);
});

// ativar/desativar barbeiro
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

// atualizar nome do barbeiro
app.post("/admin/barbeiros/:id/nome", requireAdmin, async (req, res) => {
  const barberId = Number(req.params.id);
  const name = String((req.body || {}).name || "").trim();

  if (!name) return res.status(400).send("Nome inválido.");

  await dbRun(`UPDATE barbers SET name = ? WHERE id = ?`, [name, barberId]);
  res.redirect("/admin");
});

// salvar config por barbeiro + folgas
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

// ✅ NOVO: criar plano mensalista
app.post("/admin/mensalista/create", requireAdmin, async (req, res) => {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const client_name = String(body.client_name || "").trim();
  const client_phone = String(body.client_phone || "").trim();

  // aceita yyyy-mm-dd do input type="date"
  const start_ymd = toYMD(String(body.start_ymd || "").trim());
  const end_ymd_raw = String(body.end_ymd || "").trim();
  const end_ymd = end_ymd_raw ? toYMD(end_ymd_raw) : null;

  const dow = Number(body.dow);
  const horario = String(body.horario || "").trim();

  if (!barberId || !client_name || !start_ymd || !isValidYMD(start_ymd) || !horario) {
    return res.status(400).send("❌ Preencha: barbeiro, nome, data início e horário.");
  }
  if (!(dow >= 0 && dow <= 6)) {
    return res.status(400).send("❌ Dia da semana inválido.");
  }
  if (end_ymd && !isValidYMD(end_ymd)) {
    return res.status(400).send("❌ Data fim inválida.");
  }
  if (end_ymd && end_ymd < start_ymd) {
    return res.status(400).send("❌ Data fim não pode ser menor que a data início.");
  }

  // valida se o horário é um slot válido em alguma data que bata com esse DOW
  // (pega o primeiro dia >= start_ymd que caia no DOW escolhido)
  function nextOccurrenceYMD(startYmd, targetDow) {
    const [y, m, d] = startYmd.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    while (dt.getDay() !== targetDow) dt.setDate(dt.getDate() + 1);
    const y2 = dt.getFullYear();
    const m2 = String(dt.getMonth() + 1).padStart(2, "0");
    const d2 = String(dt.getDate()).padStart(2, "0");
    return `${y2}-${m2}-${d2}`;
  }

  const sampleDate = nextOccurrenceYMD(start_ymd, dow);

  const slots = await generateSlotsForDateAndBarber(sampleDate, barberId);
  if (!slots.includes(horario)) {
    return res
      .status(400)
      .send("❌ Horário inválido para esse barbeiro (não existe na grade).");
  }

  // não pode criar plano em cima de outro plano ativo pro mesmo dow+horário
  const existsPlan = await dbGet(
    `
    SELECT id
      FROM mensalista_plans
     WHERE barber_id = ?
       AND dow = ?
       AND horario = ?
       AND (end_ymd IS NULL OR end_ymd = '' OR end_ymd >= ?)
       AND start_ymd <= ?
     LIMIT 1
  `,
    [barberId, dow, horario, start_ymd, end_ymd || "9999-12-31"]
  );
  if (existsPlan) {
    return res.status(400).send("❌ Já existe um plano mensalista nesse mesmo horário/dia.");
  }

  await dbRun(
    `
    INSERT INTO mensalista_plans
      (barber_id, client_name, client_phone, start_ymd, end_ymd, dow, horario)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    [barberId, client_name, client_phone || null, start_ymd, end_ymd, dow, horario]
  );

  return res.redirect("/admin");
});

// ✅ NOVO: deletar plano mensalista
app.post("/admin/mensalista/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.redirect("/admin");
  await dbRun(`DELETE FROM mensalista_plans WHERE id = ?`, [id]);
  return res.redirect("/admin");
});

// ✅ ADMIN: AGENDAR MANUALMENTE -> abre tela de finalizado
app.post("/admin/agendar", requireAdmin, async (req, res) => {
  const body = req.body || {};

  const barberId = Number(body.barberId);
  const nome = String(body.nome || "").trim();
  const telefone = String(body.telefone || "").trim();
  const dataInput = String(body.data || "").trim(); // dd-mm-yyyy ou yyyy-mm-dd
  const horario = String(body.horario || "").trim();

  // aqui o padrão é "agendado" (aguardando confirmação)
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

  // ✅ NOVO: bloqueia se for mensalista
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

  // ✅ abre nova tela de finalizado
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
});
