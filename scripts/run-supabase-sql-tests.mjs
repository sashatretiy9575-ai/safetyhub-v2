import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const supabaseDirectory = path.join(projectRoot, "supabase");
const testsDirectory = path.join(supabaseDirectory, "tests");
const config = readFileSync(path.join(supabaseDirectory, "config.toml"), "utf8");
const projectId = config.match(/^\s*project_id\s*=\s*"([^"]+)"/mu)?.[1];
const testFiles = readdirSync(testsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (!projectId) {
  console.error("Supabase project_id is missing from supabase/config.toml.");
  process.exit(1);
}

if (testFiles.length === 0) {
  console.error("No Supabase SQL regression tests were found.");
  process.exit(1);
}

const databaseContainer = `supabase_db_${projectId}`;

for (const testFile of testFiles) {
  console.log(`Running ${testFile}`);

  const result = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "exec",
      "-i",
      databaseContainer,
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      input: readFileSync(path.join(testsDirectory, testFile), "utf8"),
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(`Unable to run Docker for ${testFile}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`Supabase SQL regression tests passed (${testFiles.length}/${testFiles.length}).`);
