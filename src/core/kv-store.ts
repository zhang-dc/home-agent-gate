import fs from "node:fs";
import path from "node:path";

/** Tiny persisted string->string map (one JSON file). */
export class KVFile {
  private map = new Map<string, string>();

  constructor(private filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch {
      // Corrupt file — start empty.
    }
  }

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  entries(): Array<[string, string]> {
    return [...this.map.entries()];
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf-8");
  }
}
