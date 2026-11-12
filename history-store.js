const KEY = "verificationHistory";
const KEEP_FINISHED = 2000;
const PAGE_SIZE = 50;
const OUTCOMES = ["passed", "canceled", "closed", "left", "interrupted", "reused"];

function counters() {
  return { triggered: 0, passed: 0, canceled: 0, closed: 0, left: 0, interrupted: 0, reused: 0 };
}

// Calls are serialized by the background worker. Write only on lifecycle changes.
export class VerificationHistory {
  constructor() {
    this.data = null;
    this.records = new Map();
    this.dirty = false;
    this.issue = "";
  }

  async initialize(challenges) {
    try {
      const stored = (await chrome.storage.local.get(KEY))[KEY];
      if (stored && stored.version !== 1) throw new Error("历史记录版本无法读取，原数据未改动。");
      if (stored && (!Array.isArray(stored.attempts) || !stored.totals?.site || !stored.totals?.settings)) throw new Error("历史记录格式不完整，原数据未改动。");
      if (stored) {
        for (const kind of ["site", "settings"]) {
          for (const key of Object.keys(counters())) {
            const count = stored.totals[kind][key];
            if (!Number.isSafeInteger(count) || count < 0) throw new Error("历史统计格式不正确，原数据未改动。");
          }
        }
        for (const item of stored.attempts) {
          if (!item || typeof item.id !== "string" || !["site", "settings"].includes(item.kind) ||
              !["pending", ...OUTCOMES].includes(item.status) || !Number.isFinite(item.startedAt) ||
              (item.status !== "pending" && !Number.isFinite(item.finishedAt)) ||
              (item.kind === "site" && typeof item.site !== "string")) throw new Error("历史明细格式不正确，原数据未改动。");
        }
      }
      this.data = stored || {
        version: 1, since: Date.now(), totals: { site: counters(), settings: counters() }, attempts: []
      };
      for (const item of this.data.attempts) this.records.set(item.id, item);
      const live = new Set(Object.values(challenges).map(challenge => challenge.id));
      for (const item of this.data.attempts) {
        if (item.status === "pending" && !live.has(item.id)) this.finish(item, "interrupted");
      }
    } catch (error) {
      this.data = null;
      this.issue = `历史记录暂不可读取：${error.message}`;
    }
  }

  start(challenge) {
    if (!this.data || this.records.has(challenge.id)) return;
    const item = {
      id: challenge.id,
      kind: challenge.kind,
      site: challenge.kind === "site" ? challenge.site : null,
      startedAt: Date.now(),
      finishedAt: null,
      status: "pending"
    };
    this.data.attempts.push(item);
    this.records.set(item.id, item);
    this.data.totals[item.kind].triggered++;
    this.dirty = true;
  }

  finish(challenge, outcome) {
    if (!this.data || !OUTCOMES.includes(outcome)) return;
    const item = this.records.get(challenge.id);
    if (!item || item.status !== "pending") return;
    item.status = outcome;
    item.finishedAt = Date.now();
    this.data.totals[item.kind][outcome]++;
    this.dirty = true;
  }

  async flush() {
    if (!this.data || !this.dirty) return;
    const pending = this.data.attempts.filter(item => item.status === "pending");
    const finished = this.data.attempts.filter(item => item.status !== "pending")
      .sort((a, b) => a.finishedAt - b.finishedAt).slice(-KEEP_FINISHED);
    this.data.attempts = [...pending, ...finished].sort((a, b) => a.startedAt - b.startedAt);
    this.records = new Map(this.data.attempts.map(item => [item.id, item]));
    try {
      await chrome.storage.local.set({ [KEY]: this.data });
      this.dirty = false;
      this.issue = "";
    } catch (error) {
      // Logging errors must not prevent normal blocking or leave a completed flow stuck.
      this.issue = `历史记录暂未保存：${error.message}`;
    }
  }

  summary(kind = "site") {
    const total = { ...counters(), ...this.data?.totals[kind] };
    const endedWithoutPass = total.canceled + total.closed + total.left + total.interrupted;
    return {
      ...total,
      endedWithoutPass,
      pending: Math.max(0, total.triggered - total.passed - endedWithoutPass - total.reused),
      since: this.data?.since || null,
      available: this.data !== null,
      issue: this.issue
    };
  }

  query(kind, page) {
    kind = kind === "settings" ? "settings" : "site";
    const items = (this.data?.attempts || []).filter(item => item.kind === kind).reverse();
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    page = Number.isInteger(page) ? Math.max(0, Math.min(page, pages - 1)) : 0;
    return {
      kind, page, pages, total: items.length,
      summary: this.summary(kind),
      items: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    };
  }
}
