import fs from "fs";
import path from "path";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

/**
 * Checks information_schema to verify if all tables & columns defined in sqlContent already exist.
 */
async function checkMigrationNeeded(
  client: pg.Client,
  sqlContent: string
): Promise<{ needed: boolean; reason?: string }> {
  // Constraint / policy / publication changes must always run (column checks alone miss these).
  if (
    /DROP\s+CONSTRAINT/i.test(sqlContent) ||
    /ALTER\s+COLUMN\s+\w+\s+DROP\s+NOT\s+NULL/i.test(sqlContent) ||
    /CREATE\s+POLICY/i.test(sqlContent) ||
    /ALTER\s+PUBLICATION/i.test(sqlContent)
  ) {
    return { needed: true, reason: "Contains constraint, policy, or publication changes" };
  }

  const createTableRegex = /CREATE\ TABLE\s+(?:IF\ NOT\ EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi;
  const alterAddColumnRegex = /ALTER\ TABLE\s+(?:IF\ EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s+ADD\ COLUMN\s+(?:IF\ NOT\ EXISTS\s+)?([a-zA-Z0-9_]+)/gi;

  const checks: { table: string; column?: string }[] = [];

  let match;
  while ((match = createTableRegex.exec(sqlContent)) !== null) {
    checks.push({ table: match[1].toLowerCase() });
  }
  while ((match = alterAddColumnRegex.exec(sqlContent)) !== null) {
    checks.push({ table: match[1].toLowerCase(), column: match[2].toLowerCase() });
  }

  if (checks.length === 0) {
    return { needed: true, reason: "No table/column definitions found in SQL, executing migration" };
  }

  for (const check of checks) {
    if (check.column) {
      const res = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2;`,
        [check.table, check.column]
      );
      if (res.rows.length === 0) {
        return { needed: true, reason: `Column public.${check.table}.${check.column} is missing` };
      }
    } else {
      const res = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1;`,
        [check.table]
      );
      if (res.rows.length === 0) {
        return { needed: true, reason: `Table public.${check.table} is missing` };
      }
    }
  }

  return { needed: false, reason: "All target tables and columns are already present in database" };
}

function migrationDbHost(connectionString: string): string {
  try {
    return new URL(connectionString.replace(/^postgresql:/, "http:")).hostname;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

export async function runMigrations() {
  const connectionString =
    process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

  if (!connectionString?.trim()) {
    throw new Error(
      "Set DATABASE_URL (or SUPABASE_DB_URL) in Furlo-Backend/.env — Supabase Dashboard → Project Settings → Database → Connection string → URI. Prefer Session pooler (IPv4-friendly) over direct db.* host.",
    );
  }

  console.log(
    `[Migration] Connecting to database (${migrationDbHost(connectionString)})...`,
  );

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  const executedFiles: string[] = [];
  const skippedFiles: string[] = [];

  try {
    await client.connect();
    console.log("[Migration] Connected successfully.");

    // Create tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        filename text PRIMARY KEY,
        executed_at timestamptz DEFAULT now()
      );
    `);

    // Fetch list of already executed migrations
    const { rows } = await client.query(`SELECT filename FROM public._migrations;`);
    const alreadyRun = new Set(rows.map((r) => r.filename));

    const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
    if (!fs.existsSync(migrationsDir)) {
      console.warn(`[Migration] Directory not found: ${migrationsDir}`);
      return { success: true, executed: [], skipped: [] };
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    console.log(`[Migration] Found ${files.length} SQL migration file(s).`);

    for (const file of files) {
      if (alreadyRun.has(file)) {
        skippedFiles.push(file);
        console.log(`[Migration] ⏩ Skipping ${file} (already recorded in _migrations)`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sqlContent = fs.readFileSync(filePath, "utf8");

      // Check if target tables and columns are already present in DB
      const check = await checkMigrationNeeded(client, sqlContent);
      if (!check.needed) {
        skippedFiles.push(file);
        console.log(`[Migration] ⏩ Skipping ${file} (${check.reason})`);
        await client.query(
          `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING;`,
          [file]
        );
        continue;
      }

      console.log(`[Migration] 🚀 Executing ${file} (${check.reason})...`);
      try {
        await client.query("BEGIN;");
        await client.query(sqlContent);
        await client.query(
          `INSERT INTO public._migrations (filename) VALUES ($1);`,
          [file]
        );
        await client.query("COMMIT;");
        executedFiles.push(file);
        console.log(`[Migration] ✅ Successfully executed ${file}`);
      } catch (err: any) {
        await client.query("ROLLBACK;").catch(() => {});
        if (
          err.code === "42710" || // duplicate_object (policy / trigger / constraint exists)
          err.code === "42P07" || // duplicate_table
          err.code === "42701" || // duplicate_column
          String(err.message).includes("already exists")
        ) {
          console.warn(`[Migration] ⚠️ Notice on ${file}: ${err.message}. Recording as executed.`);
          await client.query(
            `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING;`,
            [file]
          );
          executedFiles.push(file);
        } else {
          console.error(`[Migration] ❌ Error executing ${file}:`, err.message);
          throw new Error(`Migration failed on ${file}: ${err.message}`);
        }
      }
    }

    return {
      success: true,
      executed: executedFiles,
      skipped: skippedFiles,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// Allow direct execution via CLI (e.g. npx tsx scripts/migrate.ts)
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations()
    .then((result) => {
      console.log("[Migration] Finished migration run:", result);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Migration] Fatal migration error:", err);
      if (err?.code === "ENOTFOUND") {
        console.error(
          "[Migration] DNS could not resolve the database host. Try:\n" +
            "  1. Use the Session pooler URI from Supabase (not db.<ref>.supabase.co), or\n" +
            "  2. Set system DNS to 8.8.8.8 / 1.1.1.1, or\n" +
            "  3. Run pending SQL files in Supabase Dashboard → SQL Editor.",
        );
      }
      process.exit(1);
    });
}
