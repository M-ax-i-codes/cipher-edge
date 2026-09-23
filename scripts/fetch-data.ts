/**
 * Fetch the committed candle dataset from Bitget's PUBLIC spot REST API.
 *
 *   node scripts/fetch-data.ts --days 92 --granularities 5m,15m,1h
 *
 * Keyless and read-only. Writes data/candles/<SYMBOL>.<gran>.jsonl plus
 * data/INTEGRITY.md and data/provenance.json so the committed dataset is auditable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, resolveDataDir } from "../src/config.ts";
import { buildIntegrityMarkdown, fetchDataset } from "../src/data/fetch.ts";

function flag(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
}

const argv = process.argv.slice(2);
const cfg = loadConfig(flag(argv, "--config", undefined as unknown as string));
const dataDir = resolveDataDir(flag(argv, "--data-dir", cfg.backtest.dataDir));
const days = Number(flag(argv, "--days", "92"));
const concurrency = Number(flag(argv, "--concurrency", "4"));
const granularities = flag(argv, "--granularities", "5m,15m,1h").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const symbols = flag(argv, "--symbols", cfg.backtest.symbols.join(",")).split(",").map((s) => s.trim()).filter((s) => s.length > 0);

mkdirSync(dataDir, { recursive: true });
const started = Date.now();
const result = await fetchDataset({
  dataDir,
  symbols,
  granularities,
  days,
  concurrency,
  onProgress: (msg) => console.log(msg),
});

const notes = [
  "Native exchange candles: no resampling was applied to the committed files.",
  "`expected` bars = (last - first) / granularity + 1, so a series that simply starts later is not penalised.",
  "`missing` counts absent bars between consecutive timestamps (exchange downtime, delisting windows, or thin rToken quoting).",
  "A series is CLEAN only when it is sorted, duplicate-free, gap-free and has valid positive OHLC.",
  "The 15m + 1h pair is the validated MVP path (15m trigger execution, 1h primary structure).",
  "The 5m series is committed for the secondary 5m-trigger sensitivity run only; that path is NOT presented as validated.",
];

const integrityPath = resolve(dirname(dataDir), "INTEGRITY.md");
writeFileSync(integrityPath, buildIntegrityMarkdown(result, notes), "utf8");
const provenancePath = resolve(dirname(dataDir), "provenance.json");
writeFileSync(provenancePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const clean = result.entries.filter((e) => e.integrity.clean).length;
console.log("");
console.log(`fetched ${result.entries.length} series, ${clean} clean, ${result.errors.length} errors, ${result.requests} HTTP requests in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`integrity  -> ${integrityPath}`);
console.log(`provenance -> ${provenancePath}`);
if (result.errors.length > 0) {
  for (const e of result.errors) console.log(`  ERROR ${e}`);
  process.exitCode = 1;
}
