export const WAIT_MS = 5 * 60 * 1000;
export const ACCESS_MS = 10 * 60 * 1000;
export const FLOW_VERSION = 3;
export const QUESTIONS = [
  {
    title: "你进去到底要做什么？",
    placeholder: "你封禁这个网站，是因为你容易沉迷、忘掉正事。写清楚这次要完成的具体任务，别用“随便看看”敷衍自己。",
    summary: "访问目的", minimum: 10,
    settingsTitle: "你为什么要修改屏蔽名单？",
    settingsPlaceholder: "这些网站是你主动封禁的。写清楚准备改哪些项目、为什么要改，别顺手取消其他屏蔽。"
  },
  {
    title: "这件事必须现在做吗？",
    placeholder: "为什么不能稍后？写清楚现在就进去的必要性。",
    summary: "现在处理的理由", minimum: 10,
    settingsTitle: "为什么必须现在修改？",
    settingsPlaceholder: "写清楚为什么必须现在修改、不能稍后处理。别用修改设置逃避封禁。"
  },
  {
    title: "你还有什么重要的事情没有完成？",
    placeholder: "继续刷下去，正事不会自己完成。把尚未完成的事写出来；确实没有，也请明确说明。",
    summary: "尚未完成的事情", minimum: 5
  },
  {
    title: "是真实理由，还是给自己找的借口？",
    placeholder: "你确定自己没有撒谎？检查刚才的理由，正面回答：你是在解决问题，还是在逃避正事？",
    summary: "对自己理由的判断", minimum: 5
  },
  {
    title: "做到什么程度，你就会关闭网站？",
    placeholder: "写下明确的退出条件，例如找到并保存链接后就关闭。完成目的就离开，别再寻找下一条内容。",
    summary: "退出条件", minimum: 5,
    settingsTitle: "修改到什么程度，你就会退出设置？",
    settingsPlaceholder: "写清楚具体修改范围和退出条件。完成就退出，不要顺手取消其他屏蔽。"
  }
];
export const DEFAULT_DOMAINS = ["x.com", "twitter.com"];
export function relatedSites(site, domains) {
  return ["x.com", "twitter.com"].includes(site)
    ? domains.filter(domain => ["x.com", "twitter.com"].includes(domain)) : [site];
}
export const PASSAGE = "你主动封禁这个网站，是因为你知道自己会在这里浪费时间。不要再用随便看看欺骗自己，也不要把逃避正事包装成查找资料。推荐内容没有终点，你的时间却不会回来。你写下的任务还没完成，继续刷下去，它们也不会自己消失。现在停下来，记住这次进入的目的和退出条件。你只有十分钟，完成目标就关闭页面，不点开无关推荐，不继续寻找下一条内容。如果你根本没有明确的目的，就承认自己只是在找借口，关掉这个页面，回去做重要的事情。";
export const INPUT_PASSAGE = PASSAGE.replaceAll("你", "我");

export function parseDomains(value) {
  const domains = [];
  for (const line of value.split(/\s+/).filter(Boolean)) {
    let url;
    try { url = new URL(line.includes("://") ? line : `https://${line}`); }
    catch { throw new Error(`网站格式不正确：${line}`); }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port ||
        url.pathname !== "/" || url.search || url.hash || host.length > 253 ||
        !host.includes(".") || host.split(".").some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
      throw new Error(`只填写网站域名，例如 x.com：${line}`);
    }
    if (!domains.includes(host)) domains.push(host);
  }
  if (domains.length > 200) throw new Error("最多添加 200 个网站。");
  return domains.sort();
}

export function safeTarget(value) {
  try {
    const url = new URL(value);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid destinations never become navigation targets. */ }
  return null;
}

export function matchSite(value, domains) {
  const target = safeTarget(value);
  if (!target) return null;
  const host = new URL(target).hostname.toLowerCase();
  return domains.filter(site => host === site || host.endsWith(`.${site}`))
    .sort((a, b) => b.length - a.length)[0] || null;
}

export function gateURL(target) {
  return chrome.runtime.getURL("gate.html") + "#" + target;
}

export async function request(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || "操作未完成，请重试。");
  return response.data;
}

export function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
