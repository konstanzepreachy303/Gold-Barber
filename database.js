// database.js
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = path.join(__dirname, "database.sqlite");
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

(async () => {
  try {
    await run(`PRAGMA foreign_keys = ON;`);

    await run(`
      CREATE TABLE IF NOT EXISTS barbers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        redirect_phone TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );
    `);

    // Se o banco já existia sem redirect_phone, tenta adicionar
    try {
      await run(`ALTER TABLE barbers ADD COLUMN redirect_phone TEXT;`);
    } catch (_) {}

    await run(`
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
        FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
      );
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS barber_days_off (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barber_id INTEGER NOT NULL,
        ymd TEXT NOT NULL,
        UNIQUE(barber_id, ymd),
        FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
      );
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS agendamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barber_id INTEGER NOT NULL,
        nome TEXT NOT NULL,
        telefone TEXT,
        data TEXT NOT NULL,
        horario TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reservado', -- reservado | aprovado | cancelado
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
      );
    `);

    // Se o banco já existia sem created_at, tenta adicionar
    try {
      await run(
        `ALTER TABLE agendamentos ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));`
      );
    } catch (_) {}

    await run(`
      CREATE TABLE IF NOT EXISTS agendamento_confirm_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agendamento_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (agendamento_id) REFERENCES agendamentos(id) ON DELETE CASCADE
      );
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS mensalista_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        barber_id INTEGER NOT NULL,
        client_name TEXT NOT NULL,
        client_phone TEXT,
        start_ymd TEXT NOT NULL,
        end_ymd TEXT,
        dow INTEGER NOT NULL, -- 0..6
        horario TEXT NOT NULL,
        FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
      );
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Defaults
    const hasBarber = await get(`SELECT id FROM barbers LIMIT 1`);
    if (!hasBarber) {
      await run(`INSERT INTO barbers (name, redirect_phone, is_active) VALUES ('Barbeiro 1', NULL, 1);`);
      const b = await get(`SELECT id FROM barbers ORDER BY id LIMIT 1`);
      if (b) await run(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (?)`, [b.id]);
    } else {
      const barbers = await all(`SELECT id FROM barbers`);
      for (const b of barbers) {
        await run(`INSERT OR IGNORE INTO barber_config (barber_id) VALUES (?)`, [b.id]);
      }
    }

    // Default: expiração de reserva (minutos)
    await run(
      `INSERT OR IGNORE INTO app_settings (key, value) VALUES ('reserva_expira_minutos', '30');`
    );

    console.log("✅ Banco inicializado em:", dbPath);
  } catch (e) {
    console.error("❌ Erro ao inicializar DB:", e);
  }
})();

module.exports = db;