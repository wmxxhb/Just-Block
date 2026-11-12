import { request } from "./shared.js";

const $ = id => document.getElementById(id);
const number = value => Number(value || 0).toLocaleString("zh-CN");
const formatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
});
const date = value => value ? formatter.format(new Date(value)) : "—";
const labels = {
  pending: "进行中", passed: "通过验证", canceled: "主动放弃", closed: "关闭验证页",
  left: "离开验证页", interrupted: "未完成", reused: "沿用已有放行"
};
let page = 0;
let pages = 1;
let busy = false;

function controls() {
  $("refresh").disabled = busy;
  $("kind").disabled = busy;
  $("previous").disabled = busy || page === 0;
  $("next").disabled = busy || page >= pages - 1;
}

async function load() {
  if (busy) return;
  busy = true;
  controls();
  $("history-error").hidden = true;
  try {
    const data = await request("get-history", { kind: $("kind").value, page });
    page = data.page;
    pages = data.pages;
    const summary = data.summary;
    $("since").textContent = summary.since
      ? `自 ${new Date(summary.since).toLocaleDateString("zh-CN")} 开始记录 · ${data.kind === "site" ? "网站访问" : "设置解锁"}`
      : "暂无可用记录。";
    for (const [id, key] of [["total-triggered", "triggered"], ["total-passed", "passed"], ["total-ended", "endedWithoutPass"], ["total-pending", "pending"]]) {
      $(id).textContent = summary.available ? number(summary[key]) : "—";
    }
    $("breakdown").textContent = summary.available ? `主动放弃 ${number(summary.canceled)} · 关闭页面 ${number(summary.closed)} · 离开页面 ${number(summary.left)} · 未完成 ${number(summary.interrupted)} · 沿用放行 ${number(summary.reused)}` : "";
    const rows = document.createDocumentFragment();
    for (const item of data.items) {
      const row = document.createElement("tr");
      for (const value of [date(item.startedAt), item.kind === "site" ? item.site : "修改屏蔽名单", labels[item.status] || item.status, date(item.finishedAt)]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      if (item.status === "interrupted") row.title = "未完成的流程在浏览器重启、扩展更新或超时后确认结束；结束时间为记录确认时间。";
      rows.append(row);
    }
    $("records").replaceChildren(rows);
    $("history-table").hidden = data.items.length === 0;
    $("empty").hidden = !summary.available || data.items.length !== 0;
    $("page-label").textContent = summary.available ? `第 ${page + 1} / ${pages} 页 · ${number(data.total)} 条明细` : "记录暂不可读取";
    if (summary.issue) {
      $("history-error").textContent = summary.issue;
      $("history-error").hidden = false;
    }
  } catch (error) {
    $("history-error").textContent = error.message;
    $("history-error").hidden = false;
  } finally {
    busy = false;
    controls();
  }
}

$("refresh").addEventListener("click", load);
$("kind").addEventListener("change", () => { page = 0; load(); });
$("previous").addEventListener("click", () => { page--; load(); });
$("next").addEventListener("click", () => { page++; load(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
load();
