// database.js
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./barbearia.db");

db.serialize(() => {
  // barbeiros
  db.run(`
    CREATE TABLE IF NOT EXISTS barbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // config por barbeiro (1 linha por barbeiro)
  db.run(`
    CREATE TABLE IF NOT EXISTS barber_config (
      barber_id INTEGER PRIMARY KEY,
      start TEXT NOT NULL DEFAULT '09:00',
      end TEXT NOT NULL DEFAULT '18:00',
      lunchStart TEXT NOT NULL DEFAULT '12:00',
      lunchEnd TEXT NOT NULL DEFAULT '13:00',
      slotMinutes INTEGER NOT NULL DEFAULT 60,
      wd0 INTEGER NOT NULL DEFAULT 0,
      wd1 INTEGER NOT NULL DEFAULT 1,
      wd2 INTEGER NOT NULL DEFAULT 1,
      wd3 INTEGER NOT NULL DEFAULT 1,
      wd4 INTEGER NOT NULL DEFAULT 1,
      wd5 INTEGER NOT NULL DEFAULT 1,
      wd6 INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (barber_id) REFERENCES barbers(id)
    )
  `);

  // folgas por barbeiro (várias datas)
  db.run(`
    CREATE TABLE IF NOT EXISTS barber_days_off (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barber_id INTEGER NOT NULL,
      ymd TEXT NOT NULL,
      UNIQUE(barber_id, ymd),
      FOREIGN KEY (barber_id) REFERENCES barbers(id)
    )
  `);

  // admins (login do painel)
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    )
  `);

  // agendamentos (agora com barber_id)
  db.run(`
    CREATE TABLE IF NOT EXISTS agendamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barber_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      telefone TEXT,
      data TEXT NOT NULL,
      horario TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'agendado',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (barber_id) REFERENCES barbers(id)
    )
  `);

  // ✅ NOVO: tokens de confirmação via WhatsApp (link único)
  db.run(`
    CREATE TABLE IF NOT EXISTS agendamento_confirm_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agendamento_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,           -- datetime('now', '+30 minutes')
      used_at TEXT,                       -- datetime quando usado
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id)
    )
  `);

  // ✅ NOVO: índice para acelerar a regra "1 por dia por telefone"
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agendamentos_telefone_data
    ON agendamentos (telefone, data)
  `);

  // ✅ NOVO: índice para acelerar busca por token
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_confirm_tokens_token
    ON agendamento_confirm_tokens (token)
  `);

  // ✅ NOVO: planos mensalistas (regra recorrente semanal)
  db.run(`
    CREATE TABLE IF NOT EXISTS mensalista_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barber_id INTEGER NOT NULL,
      client_name TEXT NOT NULL,
      client_phone TEXT,
      start_ymd TEXT NOT NULL,          -- yyyy-mm-dd
      end_ymd TEXT,                     -- yyyy-mm-dd ou NULL (sem previsão)
      dow INTEGER NOT NULL,             -- 0..6 (Dom..Sáb)
      horario TEXT NOT NULL,            -- "18:30"
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (barber_id) REFERENCES barbers(id)
    )
  `);

  // seed 2 barbeiros (se não existir)
  db.run(`
    INSERT OR IGNORE INTO barbers (id, name, is_active) VALUES
      (1, 'Barbeiro 1', 1),
      (2, 'Barbeiro 2', 1)
  `);

  // config default pra cada barbeiro (se não existir)
  db.run(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (1)`);
  db.run(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (2)`);
});

module.exports = db;