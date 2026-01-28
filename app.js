require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// view engine EJS (para admin)
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// arquivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// ====== SESSÃO (PASSO 1) ======
app.use(
  session({
    secret: process.env.SESSION_SECRET || "troque-essa-chave",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);

function requireAdmin(req, res, next) {
  if (req.session?.adminLogged) return next();
  return res.redirect("/admin/login");
}

// ====== DADOS EM MEMÓRIA (depois ligamos no SQLite) ======
let agendamentos = [];

const HORARIOS = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

// ===== CLIENTE =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "agendar.html"));
});

app.get("/horarios", (req, res) => {
  const { data } = req.query;

  const ocupados = agendamentos
    .filter((a) => a.data === data && (a.status === "agendado" || a.status === "aprovado"))
    .map((a) => a.horario);

  const livres = HORARIOS.filter((h) => !ocupados.includes(h));
  res.json(livres);
});

app.post("/agendar", (req, res) => {
  const { nome, telefone, data, horario } = req.body;

  const conflito = agendamentos.find(
    (a) => a.data === data && a.horario === horario && a.status !== "cancelado"
  );

  if (conflito) return res.send("❌ Horário indisponível");

  agendamentos.push({
    id: Date.now(),
    nome,
    telefone,
    data,
    horario,
    status: "agendado",
  });

  res.sendFile(path.join(__dirname, "views", "sucesso.html"));
});

// ===== ADMIN (PASSO 1) =====

// página de login
app.get("/admin/login", (req, res) => {
  if (req.session?.adminLogged) return res.redirect("/admin");
  res.render("admin_login", { error: null });
});

// faz login
app.post("/admin/login", async (req, res) => {
  const { user, pass } = req.body;

  const adminUser = process.env.ADMIN_USER || "admin";
  const passHash = process.env.ADMIN_PASS_HASH;

  if (!passHash) {
    return res.status(500).render("admin_login", {
      error: "ADMIN_PASS_HASH não configurado no .env",
    });
  }

  if (user !== adminUser) {
    return res.status(401).render("admin_login", { error: "Usuário ou senha inválidos" });
  }

  const ok = await bcrypt.compare(pass || "", passHash);
  if (!ok) {
    return res.status(401).render("admin_login", { error: "Usuário ou senha inválidos" });
  }

  req.session.adminLogged = true;
  return res.redirect("/admin");
});

// logout
app.post("/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

// painel (protegido)
app.get("/admin", requireAdmin, (req, res) => {
  // seu admin.ejs usa "agendamentos"
  res.render("admin", { agendamentos });
});

// endpoints admin (protegidos também)
app.post("/admin/status", requireAdmin, (req, res) => {
  const { id, status } = req.body;

  const ag = agendamentos.find((a) => a.id == id);
  if (ag) ag.status = status;

  res.json({ ok: true });
});

app.get("/admin/agendamentos", requireAdmin, (req, res) => {
  res.json(agendamentos);
});

app.listen(PORT, () => {
  console.log(`🔥 Rodando em http://localhost:${PORT}`);
});
