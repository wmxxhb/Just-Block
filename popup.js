import { request } from "./shared.js";
request("status").then(data => {
  const allowed = Object.values(data.grants).filter(until => until > data.now).length;
  document.getElementById("status").textContent = `已屏蔽 ${data.domains.length} 个网站${allowed ? `，${allowed} 个临时放行中` : ""}。`;
  document.getElementById("protection").textContent = data.guardianRequired
    ? data.guardianAvailable ? "系统保护已连接" : "系统保护连接失败，暂不可解锁"
    : "系统保护未连接";
  document.getElementById("attempts").textContent = data.historySummary.available ? data.historySummary.triggered.toLocaleString("zh-CN") : "—";
  document.getElementById("passes").textContent = data.historySummary.available ? data.historySummary.passed.toLocaleString("zh-CN") : "—";
  document.getElementById("ended").textContent = data.historySummary.available ? data.historySummary.endedWithoutPass.toLocaleString("zh-CN") : "—";
  if (data.historySummary.issue) document.querySelector(".popup-stats").title = data.historySummary.issue;
}).catch(error => { document.getElementById("status").textContent = error.message; });
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("history").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("history.html") }));
