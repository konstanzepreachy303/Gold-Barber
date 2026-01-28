const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./barbearia.db');

db.run(`
  CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT,
    telefone TEXT,
    data TEXT,
    horario TEXT,
    status TEXT DEFAULT 'agendado'
  )
`);

module.exports = db;
