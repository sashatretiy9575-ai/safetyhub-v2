import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const dockerExecutable = process.platform === "win32" ? "docker.exe" : "docker";

/**
 * Once `supabase link` has run, the CLI names the local containers after the
 * linked project ref rather than `project_id`, so the config-derived name alone
 * left every test reporting "No such container". Prefer the linked ref when it
 * exists, and fall back to whatever local database container Docker reports.
 */
function resolveDatabaseContainer() {
  const candidates = [];
  const linkedRefFile = path.join(supabaseDirectory, ".temp", "project-ref");
  if (existsSync(linkedRefFile)) {
    const linkedRef = readFileSync(linkedRefFile, "utf8").trim();
    if (linkedRef) candidates.push(`supabase_db_${linkedRef}`);
  }
  candidates.push(`supabase_db_${projectId}`);

  const running = spawnSync(
    dockerExecutable,
    ["ps", "--filter", "name=^supabase_db_", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  );
  const runningNames = (running.stdout ?? "")
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);

  const match = candidates.find((name) => runningNames.includes(name));
  if (match) return match;
  if (runningNames.length === 1) return runningNames[0];
  return candidates[0];
}

const databaseContainer = resolveDatabaseContainer();
console.log(`Using local database container ${databaseContainer}.`);
const failures = [];

for (const testFile of testFiles) {
  console.log(`Running ${testFile}`);

  const result = spawnSync(
    dockerExecutable,
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
    failures.push(testFile);
    break;
  }

  if (result.status !== 0) {
    failures.push(testFile);
  }
}

if (failures.length > 0) {
  console.error(
    `Supabase SQL regression tests failed (${failures.length}/${testFiles.length}): ${failures.join(', ')}`,
  );
  process.exit(1);
}

console.log(`Supabase SQL regression tests passed (${testFiles.length}/${testFiles.length}).`);
