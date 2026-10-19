// Shared test doubles (no side effects at import time).

// In-memory Cloudflare KV double used by bookings and route tests.
export class MemKV {
  constructor({ pageSize = 1000, yieldBetween = false } = {}) {
    this.m = new Map(); this.afterPut = null; this.pageSize = pageSize; this.yieldBetween = yieldBetween;
    this.puts = []; this.getCount = new Map(); this.stalePuts = 0;
    this.version = new Map(); this.lastRead = new Map();
  }
  async get(key, type) {
    this.getCount.set(key, (this.getCount.get(key) ?? 0) + 1);
    const ver = this.version.get(key) ?? 0;
    this.lastRead.set(key, ver);
    const v = this.m.get(key);
    await Promise.resolve();
    if (this.yieldBetween) for (let i = 0; i < 5; i++) await Promise.resolve();
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value, opts) {
    await Promise.resolve(); await Promise.resolve();
    if ((this.version.get(key) ?? 0) !== (this.lastRead.get(key) ?? 0)) this.stalePuts += 1;
    this.puts.push({ key, opts });
    this.m.set(key, value);
    this.version.set(key, (this.version.get(key) ?? 0) + 1);
    if (this.afterPut) await this.afterPut(key);
  }
  async delete(key) { this.m.delete(key); this.version.set(key, (this.version.get(key) ?? 0) + 1); }
  async list({ prefix = '', cursor } = {}) {
    const all = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0;
    const page = all.slice(from, from + this.pageSize);
    const done = from + this.pageSize >= all.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, ...(done ? {} : { cursor: String(from + this.pageSize) }) };
  }
}
