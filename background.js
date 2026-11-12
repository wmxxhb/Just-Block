import { WAIT_MS, ACCESS_MS, DEFAULT_DOMAINS, INPUT_PASSAGE, QUESTIONS, FLOW_VERSION, parseDomains, safeTarget, matchSite, gateURL, relatedSites } from "./shared.js";
import { VerificationHistory } from "./history-store.js";

let domains = [];
let session = { grants: {}, challenges: {}, manageUntil: 0 };
let chain = Promise.resolve();
let guardianRequired = false;
let guardianAvailable = false;
let guardianIssue = "";
const history = new VerificationHistory();
const pendingTabChecks = new Set();
let tabCheckQueued = false;
const ready = initialize();

async function guardian(command, data = {}) {
  try {
    const result = await chrome.runtime.sendNativeMessage("com.justblock.guardian", { command, ...data });
    if (result.error) throw new Error(result.error);
    if (result.protocol !== FLOW_VERSION) throw new Error("系统保护程序版本过旧，请以管理员身份运行 windows/Update-Guardian.cmd，然后重新加载扩展。");
    guardianAvailable = true;
    guardianIssue = "";
    return result;
  } catch (error) {
    guardianAvailable = false;
    guardianIssue = error.message || "保护程序连接失败。";
    throw new Error(error.message?.includes("版本过旧") ? error.message : `无法连接系统保护程序。请先安装并启动它。${error.message || ""}`);
  }
}

function serial(operation) {
  const result = chain.then(() => ready).then(operation);
  chain = result.catch(() => {});
  return result;
}

async function initialize() {
  const saved = await chrome.storage.local.get(["domains", "guardianRequired"]);
  guardianRequired = saved.guardianRequired === true;
  domains = Array.isArray(saved.domains) ? parseDomains(saved.domains.join("\n")) : [...DEFAULT_DOMAINS];
  if (guardianRequired) {
    try { domains = (await guardian("status")).domains; }
    catch { /* Keep the last blocking rules; never silently fall back on unlock. */ }
  }
  await chrome.storage.local.set({ domains });
  const stored = await chrome.storage.session.get("state");
  if (stored.state) session = stored.state;
  await history.initialize(session.challenges);
  const expired = prune();
  const reconcile = expired || !session.reconciled;
  session.reconciled = true;
  await updateRules();
  await saveSession();
  await scheduleExpiry();
  if (reconcile) await enforceOpenTabs();
}

function prune() {
  const now = Date.now();
  let expired = false;
  for (const [site, until] of Object.entries(session.grants)) {
    if (until <= now || !domains.includes(site)) {
      delete session.grants[site];
      expired = true;
    }
  }
  for (const [tab, challenge] of Object.entries(session.challenges)) {
    if (now - challenge.createdAt > 24 * 60 * 60 * 1000) {
      history.finish(challenge, "interrupted");
      delete session.challenges[tab];
      expired = true;
    }
  }
  if (session.manageUntil <= now) session.manageUntil = 0;
  return expired;
}

async function saveSession() {
  await chrome.storage.session.set({ state: session });
  await history.flush();
}

async function updateRules() {
  const current = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = domains.length ? [{
    id: 1,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution: gateURL("\\0") } },
    condition: { regexFilter: "^https?://.*$", requestDomains: domains, resourceTypes: ["main_frame"] }
  }] : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: current.map(rule => rule.id), addRules });
  const previous = await chrome.declarativeNetRequest.getSessionRules();
  const allowed = Object.entries(session.grants).filter(([site, until]) => domains.includes(site) && until > Date.now());
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: previous.map(rule => rule.id),
    addRules: allowed.map(([site], index) => ({
      id: index + 100,
      priority: 2,
      action: { type: "allow" },
      condition: { requestDomains: [site], resourceTypes: ["main_frame"] }
    }))
  });
}

async function scheduleExpiry() {
  await chrome.alarms.clear("access-expiry");
  const deadlines = Object.values(session.grants).filter(until => until > Date.now());
  if (deadlines.length) await chrome.alarms.create("access-expiry", { when: Math.min(...deadlines) });
}

function isAllowed(site) {
  return Object.entries(session.grants).some(([allowed, until]) =>
    until > Date.now() && (site === allowed || site.endsWith(`.${allowed}`)));
}

async function enforceOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.map(tab => enforceTab(tab.id)));
}

async function enforceTab(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch { return; } // The tab may have closed or been replaced before this event was handled.
  // Read the current destination instead of using a stale navigation event URL.
  const target = tab.pendingUrl || tab.url;
  const site = matchSite(target, domains);
  if (site && !isAllowed(site)) await chrome.tabs.update(tabId, { url: gateURL(target) });
}

function queueTabCheck(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  pendingTabChecks.add(tabId);
  if (tabCheckQueued) return;
  tabCheckQueued = true;
  serial(async () => {
    tabCheckQueued = false;
    const ids = [...pendingTabChecks];
    pendingTabChecks.clear();
    if (prune()) {
      await updateRules();
      await saveSession();
      await scheduleExpiry();
      await enforceOpenTabs();
    } else {
      await Promise.allSettled(ids.map(enforceTab));
    }
  }).catch(error => {
    tabCheckQueued = false;
    console.error(error);
  });
}

function requirePage(sender, name) {
  const url = new URL(sender.url);
  const expected = new URL(chrome.runtime.getURL(name));
  if (sender.id !== chrome.runtime.id || url.protocol !== expected.protocol ||
      url.host !== expected.host || url.pathname !== expected.pathname) throw new Error("来源无效。");
}

function challengeFor(message, sender) {
  requirePage(sender, "gate.html");
  const challenge = session.challenges[sender.tab?.id];
  if (!challenge || challenge.id !== message.id || challenge.flowVersion !== FLOW_VERSION) throw new Error("流程已失效，请刷新页面重新开始。");
  if (challenge.kind === "site" && matchSite(challenge.target, domains) !== challenge.site) {
    throw new Error("网站名单已改变，请刷新页面。");
  }
  return challenge;
}

function publicChallenge(challenge) {
  return { ...challenge, now: Date.now() };
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error("来源无效。");
  if (message.type === "status") {
    if (sender.url?.split("#")[0] !== chrome.runtime.getURL("options.html") &&
        sender.url?.split("#")[0] !== chrome.runtime.getURL("popup.html")) throw new Error("来源无效。");
    if (guardianRequired) {
      try { await guardian("status"); } catch { /* Report the live connection state below. */ }
    }
    return {
      domains, grants: session.grants, manageUntil: session.manageUntil, now: Date.now(),
      guardianRequired, guardianAvailable, guardianIssue,
      historySummary: history.summary()
    };
  }
  if (message.type === "get-history") {
    requirePage(sender, "history.html");
    await history.flush();
    return history.query(message.kind, message.page);
  }
  if (message.type === "connect-guardian") {
    requirePage(sender, "options.html");
    const native = await guardian("status");
    const merged = [...new Set([...native.domains, ...domains])];
    domains = (await guardian("configure", { domains: merged })).domains;
    guardianRequired = true;
    // Existing extension-only challenges must not become system unlock tickets.
    for (const challenge of Object.values(session.challenges)) history.finish(challenge, "interrupted");
    session.challenges = {};
    session.grants = {};
    session.manageUntil = 0;
    await chrome.storage.local.set({ domains, guardianRequired });
    await updateRules();
    await saveSession();
    await scheduleExpiry();
    await enforceOpenTabs();
    return { domains };
  }
  if (message.type === "save-domains") {
    requirePage(sender, "options.html");
    const next = parseDomains(String(message.value || ""));
    const removing = domains.some(site => !next.includes(site));
    if (removing && session.manageUntil <= Date.now()) throw new Error("删除或修改网站前，请先完成解锁流程。");
    if (guardianRequired) await guardian("configure", { domains: next });
    domains = next;
    prune();
    await chrome.storage.local.set({ domains });
    await updateRules();
    await saveSession();
    await scheduleExpiry();
    await enforceOpenTabs();
    return { domains };
  }
  if (message.type === "begin") {
    requirePage(sender, "gate.html");
    if (!sender.tab?.id) throw new Error("请在单独的标签页打开解锁页面。");
    const kind = message.target === "settings" ? "settings" : "site";
    const target = kind === "site" ? safeTarget(message.target) : "settings";
    const site = kind === "site" ? matchSite(target, domains) : null;
    if (!target) throw new Error("目标地址无效。");
    const previous = session.challenges[sender.tab.id];
    if ((kind === "site" && (!site || isAllowed(site))) || (kind === "settings" && session.manageUntil > Date.now())) {
      if (previous) {
        const sameSite = previous.kind === kind && (kind === "settings" || relatedSites(previous.site, domains).includes(site));
        history.finish(previous, sameSite ? "reused" : "left");
        delete session.challenges[sender.tab.id];
        await saveSession();
        if (guardianRequired) {
          try { await guardian("cancel", { id: previous.id }); } catch { /* Reusing a current grant must not keep an old flow pending. */ }
        }
      }
      return { stage: "available", target };
    }
    if (previous?.target === target && previous.kind === kind && previous.flowVersion === FLOW_VERSION) {
      history.start(previous);
      await history.flush();
      if (guardianRequired) {
        const native = await guardian("begin", { id: previous.id, kind, site: site || "" });
        previous.stage = native.stage;
        previous.readyAt = native.readyAt;
        previous.questionIndex = native.questionIndex;
        if (previous.viewIndex >= previous.questionIndex) previous.viewIndex = null;
        await saveSession();
      }
      return publicChallenge(previous);
    }
    const challenge = {
      id: crypto.randomUUID(), kind, target, site, stage: "questions", createdAt: Date.now(), readyAt: 0,
      flowVersion: FLOW_VERSION, questionIndex: 0, viewIndex: null, answers: QUESTIONS.map(() => "")
    };
    if (previous) history.finish(previous, "left");
    session.challenges[sender.tab.id] = challenge;
    history.start(challenge);
    await saveSession();
    if (guardianRequired) await guardian("begin", { id: challenge.id, kind, site: site || "" });
    return publicChallenge(challenge);
  }
  if (message.type === "answer") {
    const challenge = challengeFor(message, sender);
    if (challenge.stage !== "questions" || challenge.viewIndex !== null || message.index !== challenge.questionIndex) throw new Error("请按顺序回答当前问题。");
    const question = QUESTIONS[challenge.questionIndex];
    const text = String(message.text || "").trim();
    if ([...text].length < question.minimum || text.length > 500) {
      throw new Error(`请正面回答这个问题，至少 ${question.minimum} 字，最多 500 字。`);
    }
    if (guardianRequired) await guardian("answer", {
      id: challenge.id, index: challenge.questionIndex, text
    });
    // Session storage is memory-only; answers are discarded when this flow ends.
    challenge.answers[challenge.questionIndex] = text;
    challenge.questionIndex++;
    if (challenge.questionIndex === QUESTIONS.length) challenge.stage = "typing";
    await saveSession();
    return publicChallenge(challenge);
  }
  if (message.type === "view-question") {
    const challenge = challengeFor(message, sender);
    if (!Number.isInteger(message.index) || message.index < 0 || message.index >= challenge.questionIndex) {
      throw new Error("只能跳转到已经作答的题目，未答题目不能跳过。");
    }
    challenge.viewIndex = message.index;
    await saveSession();
    return publicChallenge(challenge);
  }
  if (message.type === "resume") {
    const challenge = challengeFor(message, sender);
    challenge.viewIndex = null;
    await saveSession();
    return publicChallenge(challenge);
  }
  if (message.type === "edit-answer") {
    const challenge = challengeFor(message, sender);
    const index = message.index;
    if (!Number.isInteger(index) || index < 0 || index >= challenge.questionIndex || challenge.viewIndex !== index) {
      throw new Error("请先打开已答过的题目，再提交修改。");
    }
    const text = String(message.text || "").trim();
    if ([...text].length < QUESTIONS[index].minimum || text.length > 500) throw new Error(`请正面回答，至少 ${QUESTIONS[index].minimum} 字，最多 500 字。`);
    if (text !== challenge.answers[index]) {
      if (guardianRequired) await guardian("edit-answer", { id: challenge.id, index, text });
      challenge.answers[index] = text;
      if (challenge.stage === "waiting") {
        challenge.stage = "typing";
        challenge.readyAt = 0;
      }
    }
    challenge.viewIndex = null;
    await saveSession();
    return publicChallenge(challenge);
  }
  if (message.type === "cancel") {
    requirePage(sender, "gate.html");
    const challenge = session.challenges[sender.tab?.id];
    if (challenge) {
      history.finish(challenge, "canceled");
      delete session.challenges[sender.tab.id];
      await saveSession();
      if (guardianRequired) {
        try { await guardian("cancel", { id: challenge.id }); } catch { /* Cancel locally even if the helper is unavailable. */ }
      }
    }
    return {};
  }
  if (message.type === "typed") {
    const challenge = challengeFor(message, sender);
    if (challenge.stage !== "typing" || challenge.viewIndex !== null || challenge.questionIndex !== QUESTIONS.length || message.text !== INPUT_PASSAGE || message.manual !== true) {
      throw new Error("请手动把原文中所有“你”换成“我”，其余文字和标点保持一致。");
    }
    let readyAt = Date.now() + WAIT_MS;
    if (guardianRequired) {
      const native = await guardian("typed", { id: challenge.id, text: message.text, manual: true });
      readyAt = native.readyAt;
    }
    challenge.stage = "waiting";
    challenge.readyAt = readyAt;
    await saveSession();
    return publicChallenge(challenge);
  }
  if (message.type === "enter") {
    const challenge = challengeFor(message, sender);
    if (challenge.stage !== "waiting" || challenge.viewIndex !== null || challenge.questionIndex !== QUESTIONS.length || Date.now() < challenge.readyAt) {
      throw new Error("还没有等满 5 分钟。");
    }
    const native = guardianRequired ? await guardian("enter", { id: challenge.id }) : null;
    if (challenge.kind === "site") {
      const until = native?.until || Date.now() + ACCESS_MS;
      for (const site of relatedSites(challenge.site, domains)) session.grants[site] = until;
      await updateRules();
    } else {
      session.manageUntil = native?.until || Date.now() + ACCESS_MS;
    }
    history.finish(challenge, "passed");
    delete session.challenges[sender.tab.id];
    await saveSession();
    await scheduleExpiry();
    return { target: challenge.kind === "site" ? challenge.target : chrome.runtime.getURL("options.html") };
  }
  throw new Error("不支持的操作。");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial(() => handle(message, sender)).then(
    data => respond({ ok: true, data }),
    error => respond({ ok: false, error: error.message })
  );
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== "access-expiry") return;
  serial(async () => {
    prune();
    await updateRules();
    await saveSession();
    await scheduleExpiry();
    await enforceOpenTabs();
  }).catch(console.error);
});

// History/cache restores and switching to existing tabs may make no network request.
// Check the current tab on browser events as well as using the native network rules.
function onNavigate(details) {
  if (details.frameId !== 0) return;
  queueTabCheck(details.tabId);
}
function checkFlowDeparture(tabId) {
  serial(async () => {
    const challenge = session.challenges[tabId];
    if (!challenge) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const current = tab.pendingUrl || tab.url;
    if (!current || current.startsWith(chrome.runtime.getURL("gate.html") + "#")) return;
    const site = matchSite(current, domains);
    const reused = challenge.kind === "site"
      ? site && isAllowed(site) && relatedSites(challenge.site, domains).includes(site)
      : current === chrome.runtime.getURL("options.html") && session.manageUntil > Date.now();
    history.finish(challenge, reused ? "reused" : "left");
    delete session.challenges[tabId];
    await saveSession();
    if (guardianRequired) {
      try { await guardian("cancel", { id: challenge.id }); } catch { /* Navigation away must still finalize its local record. */ }
    }
  }).catch(console.error);
}
const navigationFilter = { url: [{ schemes: ["http", "https"] }] };
chrome.webNavigation.onBeforeNavigate.addListener(onNavigate, navigationFilter);
chrome.webNavigation.onCommitted.addListener(onNavigate, navigationFilter);
chrome.webNavigation.onHistoryStateUpdated.addListener(onNavigate, navigationFilter);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onNavigate, navigationFilter);
chrome.webNavigation.onTabReplaced.addListener(details => queueTabCheck(details.tabId));
chrome.tabs.onActivated.addListener(info => queueTabCheck(info.tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url !== undefined || change.status === "complete") checkFlowDeparture(tabId);
  if (change.url !== undefined || change.pendingUrl !== undefined || change.status !== undefined ||
      change.discarded === false || change.frozen === false) queueTabCheck(tabId);
});
chrome.tabs.onReplaced.addListener(addedTabId => queueTabCheck(addedTabId));
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ windowId, active: true }).then(tabs => {
    for (const tab of tabs) queueTabCheck(tab.id);
  }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  serial(enforceOpenTabs).catch(console.error);
});
chrome.runtime.onInstalled.addListener(details => {
  serial(async () => {
    await enforceOpenTabs();
    if (details.reason === "install") await chrome.runtime.openOptionsPage();
  }).catch(console.error);
});
chrome.tabs.onRemoved.addListener(tabId => {
  serial(async () => {
    const challenge = session.challenges[tabId];
    if (!challenge) return;
    history.finish(challenge, "closed");
    delete session.challenges[tabId];
    await saveSession();
    if (guardianRequired) {
      try { await guardian("cancel", { id: challenge.id }); } catch { /* Closing a tab must still clear its local answers. */ }
    }
  }).catch(console.error);
});
