const bcrypt = require("bcrypt");
const db = require("../database");

async function run() {
  const username = process.argv[2] || "admin";
  const password = process.argv[3] || "admin123";

  const hash = await bcrypt.hash(password, 10);

  db.run(
    `INSERT OR REPLACE INTO admin_users (username, password_hash) VALUES (?, ?)`,
    [username, hash],
    (err) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`✅ Admin criado/atualizado: ${username}`);
      process.exit(0);
    }
  );
}

run();
