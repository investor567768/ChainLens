// Every test file imports this first, so tests write to a scratch ledger and never touch the real one.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.CHAINLENS_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "chainlens-test-"));
