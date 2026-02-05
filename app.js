require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== VIEW ENGINE (EJS) =====
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ===== MIDDLEWARES =====
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // IMPORTANTE pro webhook do WhatsApp (JSON)
app.use(express.static(path.join(__dirname, "public")));

// ====== DADOS EM MEMÓRIA (depois ligamos no SQLite) ======
let agendamentos = [];

// ===========================================================
// =================== CONFIG DE FUNCIONAMENTO ===============
// ===========================================================

/**
 * workDays: 0=Dom ... 6=Sáb
 * daysOffDates: ["2026-02-10", "2026-02-11"] (folga por data específica)
 */
let businessConfig = {
  start: "09:00",
  end: "18:00",
  lunchStart: "12:00",
  lunchEnd: "13:00",
  slotMinutes: 60,
  workDays: { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: true },
  daysOffDates: [],
};

function pad2(n) {
  return String(n).padStart(2, "0");
}
function toMinutes(hhmm) {
  const [h, m] = (hhmm || "00:00").split(":").map(Number);
  return h * 60 + m;
}
function fromMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}
function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function getDowFromYMD(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).getDay(); // 0..6
}
function generateSlotsForDate(ymd) {
  if (!isValidYMD(ymd)) return [];

  const dow = getDowFromYMD(ymd);
  if (!businessConfig.workDays?.[dow]) return [];

  if (businessConfig.daysOffDates?.includes(ymd)) return [];

  const startMin = toMinutes(businessConfig.start);
  const endMin = toMinutes(businessConfig.end);

  const lunchStartMin = toMinutes(businessConfig.lunchStart);
  const lunchEndMin = toMinutes(businessConfig.lunchEnd);

  const slot = Number(businessConfig.slotMinutes) || 60;

  // Proteções básicas
  if (endMin <= startMin) return [];
  if (slot <= 0 || slot > 240) return [];

  const result = [];
  for (let t = startMin; t + slot <= endMin; t += slot) {
    // pula se cair dentro do almoço
    const withinLunch =
      t < lunchEndMin && (t + slot) > lunchStartMin;

    if (withinLunch) continue;

    result.push(fromMinutes(t));
  }
  return result;
}

// ===========================================================
// ============ WHATSAPP CLOUD API (PROFISSIONAL) =============
// ===========================================================

// token -> { wa_id, createdAt }
const wppTokens = new Map();
const TOKEN_TTL_MS = 1000 * 60 * 30; // 30 minutos

function cleanupTokens() {
  const now = Date.now();
  for (const [t, info] of wppTokens.entries()) {
    if (!info?.createdAt || now - info.createdAt > TOKEN_TTL_MS) {
      wppTokens.delete(t);
    }
  }
}

function genToken() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  ).slice(0, 48);
}

async function sendWhatsAppText(toWaId, text) {
  const version = process.env.WPP_GRAPH_VERSION || "v21.0";
  const phoneNumberId = process.env.WPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.log("⚠️ WhatsApp não configurado: falta WPP_PHONE_NUMBER_ID ou WPP_ACCESS_TOKEN no .env");
    return;
  }

  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: toWaId,
    type: "text",
    text: { body: text },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.log("❌ Erro ao enviar WhatsApp:", res.status, errText);
  }
}

// Webhook verificação (Meta chama isso ao validar)
app.get("/wpp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(401);
});

// Webhook mensagens recebidas
app.post("/wpp/webhook", (req, res) => {
  res.sendStatus(200);

  (async () => {
    try {
      const body = req.body;
      const value = body?.entry?.[0]?.changes?.[0]?.value;

      const waId =
        value?.contacts?.[0]?.wa_id ||
        value?.messages?.[0]?.from;

      const msgText = value?.messages?.[0]?.text?.body || "";
      if (!waId) return;

      const t = (msgText || "").trim().toLowerCase();
      const shouldRespond =
        !t ||
        t.includes("agendar") ||
        t.includes("agenda") ||
        t.includes("horario") ||
        t.includes("horário");

      if (!shouldRespond) return;

      cleanupTokens();

      const token = genToken();
      wppTokens.set(token, { wa_id: waId, createdAt: Date.now() });

      const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
      const link = `${baseUrl}/?t=${encodeURIComponent(token)}`;

      await sendWhatsAppText(
        waId,
        `Olá! 👋\n\nPara agendar seu horário na Gold Barber, clique no link abaixo:\n${link}\n\n⚠️ Esse link expira em 30 minutos.`
      );
    } catch (e) {
      console.log("❌ Erro no webhook do WhatsApp:", e);
    }
  })();
});

// ===========================================================
// ===================== ROTAS CLIENTE =======================
// ===========================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "agendar.html"));
});

app.get("/horarios", (req, res) => {
  const { data } = req.query;

  const baseSlots = generateSlotsForDate(data);

  // ocupa horários já marcados/aprovados
  const ocupados = agendamentos
    .filter(
      (a) =>
        a.data === data &&
        (a.status === "agendado" || a.status === "aprovado")
    )
    .map((a) => a.horario);

  const livres = baseSlots.filter((h) => !ocupados.includes(h));
  res.json(livres);
});

app.post("/agendar", (req, res) => {
  const { nome, telefone, data, horario, token } = req.body;

  if (!nome || !data || !horario) {
    return res.status(400).send("❌ Preencha nome, data e horário.");
  }

  // valida se esse horário existe pela config (evita agendar horário fora)
  const slots = generateSlotsForDate(data);
  if (!slots.includes(horario)) {
    return res.status(400).send("❌ Horário inválido para essa data.");
  }

  let telefoneFinal = (telefone || "").toString().trim();

  if (token) {
    cleanupTokens();
    const info = wppTokens.get(token);

    if (!info?.wa_id) {
      return res.status(400).send("❌ Link expirado. Peça um novo link no WhatsApp.");
    }

    telefoneFinal = info.wa_id; // ex: 5511999999999
  } else {
    // ✅ SEM TOKEN: por enquanto deixa fixo e NÃO valida input
    telefoneFinal = "12992314361";
  }

  const conflito = agendamentos.find(
    (a) => a.data === data && a.horario === horario && a.status !== "cancelado"
  );

  if (conflito) {
    return res.send("❌ Horário indisponível");
  }

  agendamentos.push({
    id: Date.now(),
    nome,
    telefone: telefoneFinal,
    data,
    horario,
    status: "agendado",
  });

  return res.sendFile(path.join(__dirname, "views", "sucesso.html"));
});

// ===========================================================
// ========================== ADMIN ==========================
// ===========================================================

app.get("/admin", (req, res) => {
  res.render("admin", { agendamentos, config: businessConfig });
});

// atualizar config (salva em memória por enquanto)
app.post("/admin/config", (req, res) => {
  const {
    start,
    end,
    lunchStart,
    lunchEnd,
    slotMinutes,
    daysOffDates,
    wd0, wd1, wd2, wd3, wd4, wd5, wd6,
  } = req.body;

  // dias da semana (checkbox -> "on" quando marcado)
  const workDays = {
    0: wd0 === "on",
    1: wd1 === "on",
    2: wd2 === "on",
    3: wd3 === "on",
    4: wd4 === "on",
    5: wd5 === "on",
    6: wd6 === "on",
  };

  // folgas por data (textarea com linhas ou vírgulas)
  const parsedDates = String(daysOffDates || "")
    .split(/[\s,;]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isValidYMD);

  businessConfig = {
    ...businessConfig,
    start: start || businessConfig.start,
    end: end || businessConfig.end,
    lunchStart: lunchStart || businessConfig.lunchStart,
    lunchEnd: lunchEnd || businessConfig.lunchEnd,
    slotMinutes: Number(slotMinutes) || businessConfig.slotMinutes,
    workDays,
    daysOffDates: parsedDates,
  };

  return res.redirect("/admin");
});

app.post("/admin/status", (req, res) => {
  const { id, status } = req.body;

  const ag = agendamentos.find((a) => a.id == id);
  if (ag) ag.status = status;

  res.json({ ok: true });
});

app.get("/admin/agendamentos", (req, res) => {
  res.json(agendamentos);
});

// ===========================================================

app.listen(PORT, () => {
  console.log(`🔥 Rodando em http://localhost:${PORT}`);
  console.log(`📲 Webhook WhatsApp (verificação e eventos): /wpp/webhook`);
});
