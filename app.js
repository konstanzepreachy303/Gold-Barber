require("dotenv").config();

const session = require("express-session");
const bcrypt = require("bcrypt");

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;

// view engine EJS (para admin)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// ====== DADOS EM MEMÓRIA (depois ligamos no SQLite) ======
let agendamentos = [];

const HORARIOS = [
  "09:00","10:00","11:00",
  "13:00","14:00","15:00",
  "16:00","17:00"
];

// ===== CLIENTE =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'agendar.html'));
});

app.get('/horarios', (req, res) => {
  const { data } = req.query;

  const ocupados = agendamentos
    .filter(a =>
      a.data === data &&
      (a.status === 'agendado' || a.status === 'aprovado')
    )
    .map(a => a.horario);

  const livres = HORARIOS.filter(h => !ocupados.includes(h));
  res.json(livres);
});

app.post('/agendar', (req, res) => {
  const { nome, telefone, data, horario } = req.body;

  const conflito = agendamentos.find(a =>
    a.data === data &&
    a.horario === horario &&
    a.status !== 'cancelado'
  );

  if (conflito) {
    return res.send('❌ Horário indisponível');
  }

  agendamentos.push({
    id: Date.now(),
    nome,
    telefone,
    data,
    horario,
    status: 'agendado'
  });

  res.sendFile(path.join(__dirname, 'views', 'sucesso.html'));
});

// ===== ADMIN =====
app.get('/admin', (req, res) => {
  res.render('admin');
});

app.post('/admin/status', (req, res) => {
  const { id, status } = req.body;

  const ag = agendamentos.find(a => a.id == id);
  if (ag) ag.status = status;

  res.json({ ok: true });
});

app.get('/admin/agendamentos', (req, res) => {
  res.json(agendamentos);
});

app.listen(PORT, () => {
  console.log(`🔥 Rodando em http://localhost:${PORT}`);
});
