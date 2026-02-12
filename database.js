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

  // agendamentos (com barber_id)
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

  // ✅ NOVO: plano mensalista (recorrência semanal)
  db.run(`
    CREATE TABLE IF NOT EXISTS mensalistas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      barber_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      start_ymd TEXT NOT NULL,          -- yyyy-mm-dd (início do plano)
      end_ymd TEXT,                     -- yyyy-mm-dd (fim) OU NULL (sem previsão)
      weekday INTEGER NOT NULL,         -- 0..6 (Dom..Sáb)
      horario TEXT NOT NULL,            -- HH:MM
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
