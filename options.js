import { request, gateURL } from "./shared.js";
const list = document.getElementById("domains");
const status = document.getElementById("status");
const save = document.getElementById("save");

async function load() {
  try {
    const data = await request("status");
    list.value = data.domains.join("\n");
    status.textContent = data.manageUntil > data.now
      ? `可删改至 ${new Date(data.manageUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "新增网站无需解锁。";
    document.getElementById("guardian-status").textContent = data.guardianRequired
      ? data.guardianAvailable ? "系统保护已连接。" : `系统保护暂不可用。${data.guardianIssue || "请检查 Windows 服务。"}`
      : "尚未连接系统保护程序。仅使用扩展时仍可直接停用。";
    document.getElementById("connect-guardian").hidden = data.guardianRequired;
    const summary = data.historySummary;
    document.getElementById("history-summary").textContent = summary.issue || `累计触发 ${summary.triggered} 次，通过 ${summary.passed} 次，未通过即结束 ${summary.endedWithoutPass} 次。`;
  } catch (error) { status.textContent = error.message; }
}
save.addEventListener("click", async () => {
  save.disabled = true;
  try {
    const data = await request("save-domains", { value: list.value });
    list.value = data.domains.join("\n");
    status.textContent = "已保存。";
  } catch (error) { status.textContent = error.message; }
  finally { save.disabled = false; }
});
document.getElementById("unlock").addEventListener("click", () => {
  location.href = gateURL("settings");
});
document.getElementById("connect-guardian").addEventListener("click", async event => {
  event.target.disabled = true;
  try { await request("connect-guardian"); await load(); }
  catch (error) { document.getElementById("guardian-status").textContent = error.message; }
  finally { event.target.disabled = false; }
});
load();
