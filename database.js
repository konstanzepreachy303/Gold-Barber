require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        ssl:
          process.env.PGSSL === 'true' ||
          /render|railway|supabase|neon/i.test(connectionString)
            ? { rejectUnauthorized: false }
            : false,
      }
    : {
        host: process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || 'gold_barber',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
      }
);

const INSERT_TABLES_WITH_ID = new Set([
  'barbers',
  'barber_days_off',
  'agendamentos',
  'agendamento_confirm_tokens',
  'agendamento_cancel_tokens',
  'mensalista_plans',
  'admin_users',
  'mensalista_overrides',
  'services',
]);

function normalizeWhitespace(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function replaceQuestionParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function translateCreateTable(sql) {
  return sql
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
    .replace(/TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/gi, 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
    .replace(/TEXT DEFAULT \(datetime\('now'\)\)/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
    .replace(/created_at\s+TEXT/gi, 'created_at TIMESTAMP')
    .replace(/updated_at\s+TEXT/gi, 'updated_at TIMESTAMP')
    .replace(/expires_at\s+TEXT/gi, 'expires_at TIMESTAMP')
    .replace(/used_at\s+TEXT/gi, 'used_at TIMESTAMP');
}

function translateSql(rawSql) {
  let sql = String(rawSql || '').trim();

  sql = translateCreateTable(sql);

  sql = sql.replace(
    /datetime\('now'\s*,\s*\?\s*\)/gi,
    "(CURRENT_TIMESTAMP + (?::interval))"
  );

  sql = sql.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
  sql = sql.replace(/datetime\(([^)]+)\)/gi, '$1');

if (/barber_config/i.test(sql)) {
  sql = sql
    .replace(/\bend\b/g, '"end"')
    .replace(/\blunchStart_(\d)\b/g, 'lunchstart_$1')
    .replace(/\blunchEnd_(\d)\b/g, 'lunchend_$1')
    .replace(/\blunchStart\b/g, 'lunchstart')
    .replace(/\blunchEnd\b/g, 'lunchend')
    .replace(/\bslotMinutes\b/g, 'slotminutes')
    .replace(/\bslotminutes\b/g, 'slotminutes');
}

  sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');

  sql = sql.replace(
    /INSERT\s+OR\s+REPLACE\s+INTO\s+admin_users\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    'INSERT INTO admin_users ($1) VALUES ($2) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash'
  );

  if (/^INSERT\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(sql) && /barber_config/i.test(sql)) {
    sql += ' ON CONFLICT DO NOTHING';
  }

  if (/^INSERT\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(sql) && /barber_days_off/i.test(sql)) {
    sql += ' ON CONFLICT DO NOTHING';
  }

  if (/^INSERT\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(sql) && /app_settings/i.test(sql)) {
    sql += ' ON CONFLICT DO NOTHING';
  }

  if (/^INSERT\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(sql) && /services/i.test(sql)) {
    sql += ' ON CONFLICT DO NOTHING';
  }

  if (/^INSERT\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(sql) && /mensalista_overrides/i.test(sql)) {
    sql += ' ON CONFLICT DO NOTHING';
  }

  sql = replaceQuestionParams(sql);
  return sql;
}

function maybeAddReturningId(sql) {
  const normalized = normalizeWhitespace(sql);
  const match = normalized.match(/^INSERT INTO ([a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (!match) return { sql, wantsId: false };

  const table = match[1].toLowerCase();
  if (!INSERT_TABLES_WITH_ID.has(table)) return { sql, wantsId: false };
  if (/RETURNING\s+/i.test(sql)) return { sql, wantsId: true };

  return { sql: `${sql} RETURNING id`, wantsId: true };
}

async function execute(sql, params = []) {
  const translated = translateSql(sql);
  return pool.query(translated, params);
}

const db = {
  async run(sql, params = [], callback) {
    try {
      const { sql: finalSql, wantsId } = maybeAddReturningId(translateSql(sql));
      const result = await pool.query(finalSql, params);

      const context = {
        lastID: wantsId && result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount || 0,
      };

      if (typeof callback === 'function') callback.call(context, null);
      return context;
    } catch (err) {
      if (typeof callback === 'function') callback(err);
      else throw err;
    }
  },

  async get(sql, params = [], callback) {
    try {
      const result = await execute(sql, params);
      const row = result.rows[0];
      if (typeof callback === 'function') callback(null, row);
      return row;
    } catch (err) {
      if (typeof callback === 'function') callback(err);
      else throw err;
    }
  },

  async all(sql, params = [], callback) {
    try {
      const result = await execute(sql, params);
      const rows = result.rows;
      if (typeof callback === 'function') callback(null, rows);
      return rows;
    } catch (err) {
      if (typeof callback === 'function') callback(err);
      else throw err;
    }
  },

  async query(sql, params = []) {
    return execute(sql, params);
  },

  pool,
};

async function ensureColumn(table, column, definition) {
  const existsResult = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND lower(column_name) = lower($2)
    LIMIT 1
    `,
    [table, column]
  );

  if (existsResult.rowCount > 0) return;

  const safeTable = String(table).replace(/"/g, '""');
  const safeColumn = String(column).replace(/"/g, '""');

  await pool.query(
    `ALTER TABLE "${safeTable}" ADD COLUMN "${safeColumn}" ${definition};`
  );
}

async function ensureConstraint(constraintName, sql) {
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name = '${constraintName}'
      ) THEN
        ${sql}
      END IF;
    END $$;
  `);
}

async function ensureIndex(indexName, sql) {
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = '${indexName}'
      ) THEN
        ${sql}
      END IF;
    END $$;
  `);
}

async function init() {
  try {
    await pool.query('SELECT 1');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS barbers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        redirect_phone TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );
    `);

await pool.query(`
  CREATE TABLE IF NOT EXISTS barber_config (
    barber_id INTEGER PRIMARY KEY REFERENCES barbers(id) ON DELETE CASCADE,
    start TEXT NOT NULL DEFAULT '09:00',
    "end" TEXT NOT NULL DEFAULT '18:00',
    lunchstart TEXT NOT NULL DEFAULT '',
    lunchend TEXT NOT NULL DEFAULT '',
    slotminutes INTEGER NOT NULL DEFAULT 60,
    wd0 INTEGER NOT NULL DEFAULT 0,
    wd1 INTEGER NOT NULL DEFAULT 1,
    wd2 INTEGER NOT NULL DEFAULT 1,
    wd3 INTEGER NOT NULL DEFAULT 1,
    wd4 INTEGER NOT NULL DEFAULT 1,
    wd5 INTEGER NOT NULL DEFAULT 1,
    wd6 INTEGER NOT NULL DEFAULT 1
  );
`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS barber_days_off (
        id SERIAL PRIMARY KEY,
        barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
        ymd TEXT NOT NULL,
        UNIQUE(barber_id, ymd)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        duration_minutes INTEGER NOT NULL DEFAULT 30,
        slots_required INTEGER NOT NULL DEFAULT 1,
        price_cents INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agendamentos (
        id SERIAL PRIMARY KEY,
        barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
        nome TEXT NOT NULL,
        telefone TEXT,
        data TEXT NOT NULL,
        horario TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'reservado',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agendamento_confirm_tokens (
        id SERIAL PRIMARY KEY,
        agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agendamento_cancel_tokens (
        id SERIAL PRIMARY KEY,
        agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensalista_plans (
        id SERIAL PRIMARY KEY,
        barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
        client_name TEXT NOT NULL,
        client_phone TEXT,
        start_ymd TEXT NOT NULL,
        end_ymd TEXT,
        dow INTEGER NOT NULL,
        horario TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensalista_overrides (
        id SERIAL PRIMARY KEY,
        plan_id INTEGER NOT NULL REFERENCES mensalista_plans(id) ON DELETE CASCADE,
        original_date TEXT NOT NULL,
        new_date TEXT NOT NULL,
        new_horario TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(plan_id, original_date)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // -------------------- novas colunas da barber_config por dia --------------------
await ensureColumn('barber_config', 'start_0', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_0', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_0', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_0', `TEXT NOT NULL DEFAULT ''`);

await ensureColumn('barber_config', 'start_1', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_1', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_1', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_1', `TEXT NOT NULL DEFAULT ''`);

await ensureColumn('barber_config', 'start_2', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_2', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_2', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_2', `TEXT NOT NULL DEFAULT ''`);

await ensureColumn('barber_config', 'start_3', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_3', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_3', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_3', `TEXT NOT NULL DEFAULT ''`);

await ensureColumn('barber_config', 'start_4', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_4', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_4', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_4', `TEXT NOT NULL DEFAULT ''`);

await ensureColumn('barber_config', 'start_5', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_5', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_5', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_5', `TEXT NOT NULL DEFAULT ''`);

await ensureColumn('barber_config', 'start_6', `TEXT NOT NULL DEFAULT '09:00'`);
await ensureColumn('barber_config', 'end_6', `TEXT NOT NULL DEFAULT '18:00'`);
await ensureColumn('barber_config', 'lunchstart_6', `TEXT NOT NULL DEFAULT ''`);
await ensureColumn('barber_config', 'lunchend_6', `TEXT NOT NULL DEFAULT ''`);

    await ensureColumn('services', 'price_cents', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn('services', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('services', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');

    await ensureColumn('agendamentos', 'service_id', 'INTEGER');
    await ensureColumn('agendamentos', 'service_name', 'TEXT');
    await ensureColumn('agendamentos', 'service_duration_minutes', 'INTEGER NOT NULL DEFAULT 30');
    await ensureColumn('agendamentos', 'service_slots_required', 'INTEGER NOT NULL DEFAULT 1');
    await ensureColumn('agendamentos', 'service_price_cents', 'INTEGER NOT NULL DEFAULT 0');

    await ensureColumn('mensalista_overrides', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn('mensalista_overrides', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

    await ensureConstraint(
      'fk_agendamentos_service_id',
      `
      ALTER TABLE agendamentos
      ADD CONSTRAINT fk_agendamentos_service_id
      FOREIGN KEY (service_id)
      REFERENCES services(id)
      ON DELETE SET NULL;
      `
    );

    await ensureIndex(
      'idx_services_active',
      `CREATE INDEX idx_services_active ON services(is_active);`
    );

    await ensureIndex(
      'idx_services_name',
      `CREATE INDEX idx_services_name ON services(name);`
    );

    await ensureIndex(
      'idx_agendamentos_service_id',
      `CREATE INDEX idx_agendamentos_service_id ON agendamentos(service_id);`
    );

    await ensureIndex(
      'idx_agendamentos_data_barber_horario',
      `CREATE INDEX idx_agendamentos_data_barber_horario ON agendamentos(barber_id, data, horario);`
    );

    await ensureIndex(
      'idx_barber_days_off_barber_ymd',
      `CREATE INDEX idx_barber_days_off_barber_ymd ON barber_days_off(barber_id, ymd);`
    );

    await ensureIndex(
      'idx_mensalista_plans_barber_dow_horario',
      `CREATE INDEX idx_mensalista_plans_barber_dow_horario ON mensalista_plans(barber_id, dow, horario);`
    );

    await ensureIndex(
      'idx_mensalista_overrides_plan_original',
      `CREATE INDEX idx_mensalista_overrides_plan_original ON mensalista_overrides(plan_id, original_date);`
    );

    await pool.query(`
      CREATE OR REPLACE FUNCTION set_services_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgname = 'trg_services_updated_at'
        ) THEN
          CREATE TRIGGER trg_services_updated_at
          BEFORE UPDATE ON services
          FOR EACH ROW
          EXECUTE FUNCTION set_services_updated_at();
        END IF;
      END $$;
    `);

    await pool.query(`
      CREATE OR REPLACE FUNCTION set_mensalista_overrides_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgname = 'trg_mensalista_overrides_updated_at'
        ) THEN
          CREATE TRIGGER trg_mensalista_overrides_updated_at
          BEFORE UPDATE ON mensalista_overrides
          FOR EACH ROW
          EXECUTE FUNCTION set_mensalista_overrides_updated_at();
        END IF;
      END $$;
    `);

    const hasBarber = await db.get('SELECT id FROM barbers LIMIT 1');

    if (!hasBarber) {
      const created = await db.run(
        'INSERT INTO barbers (name, redirect_phone, is_active) VALUES (?, ?, ?)',
        ['Barbeiro 1', null, 1]
      );

      if (created.lastID) {
        await db.run(
          'INSERT INTO barber_config (barber_id) VALUES (?) ON CONFLICT DO NOTHING',
          [created.lastID]
        );
      }
    } else {
      const barbers = await db.all('SELECT id FROM barbers');
      for (const barber of barbers) {
        await db.run(
          'INSERT INTO barber_config (barber_id) VALUES (?) ON CONFLICT DO NOTHING',
          [barber.id]
        );
      }
    }

// Copia os horários antigos para os dias novos quando estiverem vazios

await pool.query(`
  UPDATE barber_config
  SET
    start_0 = COALESCE(NULLIF(start_0, ''), start),
    end_0 = COALESCE(NULLIF(end_0, ''), "end"),

    start_1 = COALESCE(NULLIF(start_1, ''), start),
    end_1 = COALESCE(NULLIF(end_1, ''), "end"),

    start_2 = COALESCE(NULLIF(start_2, ''), start),
    end_2 = COALESCE(NULLIF(end_2, ''), "end"),

    start_3 = COALESCE(NULLIF(start_3, ''), start),
    end_3 = COALESCE(NULLIF(end_3, ''), "end"),

    start_4 = COALESCE(NULLIF(start_4, ''), start),
    end_4 = COALESCE(NULLIF(end_4, ''), "end"),

    start_5 = COALESCE(NULLIF(start_5, ''), start),
    end_5 = COALESCE(NULLIF(end_5, ''), "end"),

    start_6 = COALESCE(NULLIF(start_6, ''), start),
    end_6 = COALESCE(NULLIF(end_6, ''), "end")
`);

    await db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
      ['reserva_expira_minutos', '30']
    );

    console.log('✅ PostgreSQL conectado e schema inicializado.');
  } catch (error) {
    console.error('❌ Erro ao inicializar PostgreSQL:', error);
  }
}

init();

module.exports = db;
