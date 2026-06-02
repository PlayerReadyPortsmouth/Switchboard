import { readFileSync } from "fs"
/** Load KEY=value lines from a .env file into process.env (real env wins). */
export function config(path: string): void {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch { /* no .env — rely on real env */ }
}
