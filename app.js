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

const HORARIOS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

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
  // responde rápido (Meta gosta disso)
  res.sendStatus(200);

  // processa depois
  (async () => {
    try {
      const body = req.body;

      // Estrutura típica: entry[0].changes[0].value
      const value = body?.entry?.[0]?.changes?.[0]?.value;

      // pega WA ID (telefone do WhatsApp) - geralmente vem aqui
      const waId =
        value?.contacts?.[0]?.wa_id || // preferível
        value?.messages?.[0]?.from; // fallback

      const msgText = value?.messages?.[0]?.text?.body || "";

      if (!waId) return;

      // opcional: só responde se a pessoa pedir algo relacionado a agenda
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

  const ocupados = agendamentos
    .filter(
      (a) =>
        a.data === data &&
        (a.status === "agendado" || a.status === "aprovado") // bloqueia horários já marcados/aprovados
    )
    .map((a) => a.horario);

  const livres = HORARIOS.filter((h) => !ocupados.includes(h));
  res.json(livres);
});

app.post("/agendar", (req, res) => {
  const { nome, telefone, data, horario, token } = req.body;

  if (!nome || !data || !horario) {
    return res.status(400).send("❌ Preencha nome, data e horário.");
  }

  // Se veio token do WhatsApp, NÃO deixa o cliente escolher telefone.
  // O telefone vem do wa_id associado ao token.
  let telefoneFinal = (telefone || "").toString().trim();

  if (token) {
    cleanupTokens();
    const info = wppTokens.get(token);

    if (!info?.wa_id) {
      return res.status(400).send("❌ Link expirado. Peça um novo link no WhatsApp.");
    }

    telefoneFinal = info.wa_id; // ex: 5511999999999
  } else {
    // sem token => exige telefone no formato mínimo (DD + número)
    const digits = telefoneFinal.replace(/\D/g, "");
    if (digits.length < 10) {
      return res.status(400).send("❌ Digite um telefone válido (com DDD).");
    }
    telefoneFinal = telefoneFinal; // mantém formatado como foi digitado
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
// ====================== ADMIN (DEPOIS) ======================
// ===========================================================

app.get("/admin", (req, res) => {
  // (sem foco agora) - mas deixa funcionando
  res.render("admin", { agendamentos });
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
