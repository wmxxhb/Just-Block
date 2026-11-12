import { PASSAGE, INPUT_PASSAGE, QUESTIONS, request, formatTime } from "./shared.js";

const $ = id => document.getElementById(id);
const target = location.hash.slice(1);
const settings = target === "settings";
const field = $("transcription");
const stages = ["questions", "typing", "waiting", "confirm", "available"];
let state;
let section;
let offset = 0;
let timer;
let busy = false;
let accepted = "";
let keyAt = -Infinity;
let composing = false;
let compositionAt = -Infinity;
let permittedInput = false;
let confirmRequested = false;
let questionBeingShown = null;
const drafts = new Map();
const questionButtons = QUESTIONS.map((question, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "question-link";
  const label = [["进去", "做什么"], ["为何", "现在做"], ["还有什么", "没做"], ["是否", "如实回答"], ["做完什么", "就退出"]][index];
  for (const part of label) {
    const span = document.createElement("span");
    span.textContent = part;
    button.append(span);
  }
  button.setAttribute("aria-label", question.title);
  button.disabled = true;
  button.addEventListener("click", event => {
    if (!event.isTrusted || state?.viewIndex === index) return;
    action(async () => {
      recordDraft();
      display(await request("view-question", { id: state.id, index }));
    });
  });
  $("question-nav").append(button);
  return button;
});

const letters = [...PASSAGE].map(letter => {
  const span = document.createElement("span");
  span.textContent = letter;
  $("passage").append(span);
  return span;
});
$("target").textContent = settings ? "屏蔽名单" : (() => {
  try { return new URL(target).hostname; } catch { return ""; }
})();
if (settings) {
  $("destination-label").textContent = "你正在尝试修改";
  $("confirm-title").textContent = "看完这些，你仍然决定修改名单吗？";
  $("access-rule").textContent = "本次允许修改 10 分钟。只修改刚才写明的项目。";
  $("enter").textContent = "仍要修改，限时 10 分钟";
  $("open-available").textContent = "进入设置";
}

function showError(error) {
  $("error").textContent = error.message || String(error);
  $("error").hidden = false;
}

function controls() {
  $("gate").setAttribute("aria-busy", String(busy));
  $("answer").disabled = busy;
  field.disabled = busy;
  for (const button of document.querySelectorAll(".forward, .back, .leave")) button.disabled = busy;
  const currentQuestion = Number.isInteger(state?.viewIndex) ? state.viewIndex : state?.stage === "questions" ? state.questionIndex : null;
  questionButtons.forEach((button, index) => {
    const answered = state && index < state.questionIndex;
    button.disabled = busy || !answered;
    button.classList.toggle("answered", Boolean(answered));
    button.classList.toggle("selected", index === currentQuestion);
    button.title = `第 ${index + 1} 题：${QUESTIONS[index].summary}${answered ? "，已作答，点击回看" : "，尚未作答"}`;
    if (index === currentQuestion) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  $("start-wait").disabled = busy || accepted !== INPUT_PASSAGE || field.value !== accepted || composing;
  const shownQuestion = QUESTIONS[questionBeingShown];
  const answer = $("answer").value.trim();
  $("submit-answer").disabled = busy || !shownQuestion || [...answer].length < shownQuestion.minimum || answer.length > 500;
  $("wait-next").disabled = busy || state?.stage !== "waiting" || Number.isInteger(state.viewIndex) || state.readyAt > Date.now() + offset;
}

async function action(operation) {
  if (busy) return;
  busy = true;
  $("error").hidden = true;
  controls();
  try { await operation(); }
  catch (error) { showError(error); }
  finally { busy = false; controls(); }
}

function step(number, name) {
  $("step-label").textContent = `第 ${number} 步，共 8 步`;
  $("step-name").textContent = name;
}

function showSection(name, focus = true) {
  const changed = section !== name;
  section = name;
  document.body.dataset.stage = name;
  for (const id of stages) $(id).hidden = id !== name;
  $("flow").hidden = name === "available";
  if (changed && focus && !document.hidden) focusHeading();
}

function focusHeading() {
  $("gate-scroll").scrollTop = 0;
  $(section)?.querySelector("h1")?.focus({ preventScroll: true });
}

function recordDraft() {
  if (questionBeingShown !== null) drafts.set(questionBeingShown, $("answer").value);
}

function currentStep() {
  if (state.stage === "questions") return state.questionIndex + 1;
  if (state.stage === "typing") return 6;
  return confirmRequested && state.readyAt <= Date.now() + offset ? 8 : 7;
}

function answerCount() {
  const size = [...$("answer").value.trim()].length;
  const question = QUESTIONS[questionBeingShown];
  $("answer-count").textContent = `${size} / 500`;
  if (question) {
    const complete = size >= question.minimum;
    $("answer-hint").textContent = complete ? "已达到字数要求" : `至少 ${question.minimum} 字`;
    $("answer-hint").classList.toggle("status", complete);
  }
  controls();
}

function summary() {
  const list = $("answer-summary");
  list.replaceChildren();
  QUESTIONS.forEach((question, index) => {
    const title = document.createElement("dt");
    const text = document.createElement("dd");
    title.textContent = question.summary;
    text.textContent = state.answers?.[index] || "未填写";
    list.append(title, text);
  });
  for (const prefix of ["wait", "confirm"]) {
    $(`${prefix}-purpose`).textContent = state.answers?.[0] || "尚未填写访问目的";
    $(`${prefix}-exit`).textContent = state.answers?.[4] || "尚未填写退出条件";
  }
}

function clearPrivateContent() {
  $("answer-summary").replaceChildren();
  $("answer").value = "";
  for (const id of ["wait-purpose", "wait-exit", "confirm-purpose", "confirm-exit"]) $(id).textContent = "";
  state = null;
  drafts.clear();
}

function display(next) {
  state = next;
  if (state.stage !== "waiting") confirmRequested = false;
  offset = (next.now || Date.now()) - Date.now();
  clearTimeout(timer);
  $("answer-error").hidden = true;
  $("answer").removeAttribute("aria-invalid");
  const reviewing = Number.isInteger(state.viewIndex);
  questionBeingShown = state.stage === "questions" || reviewing ? reviewing ? state.viewIndex : state.questionIndex : null;
  $("question-nav").hidden = state.stage === "available";
  if (questionBeingShown !== null) {
    const question = QUESTIONS[questionBeingShown];
    $("question-title").textContent = settings && question.settingsTitle ? question.settingsTitle : question.title;
    const guidance = settings && question.settingsPlaceholder ? question.settingsPlaceholder : question.placeholder;
    $("answer").placeholder = guidance;
    $("question-guidance").textContent = guidance;
    $("answer").value = drafts.get(questionBeingShown) ?? state.answers?.[questionBeingShown] ?? "";
    $("resume-flow").hidden = !reviewing;
    $("question-back").hidden = questionBeingShown === 0;
    $("submit-answer").textContent = reviewing ? "保存回答，返回当前进度" : questionBeingShown === 4 ? "继续，手写声明" : "继续回答";
    $("review-note").hidden = !reviewing;
    $("review-note").textContent = state.stage === "waiting"
      ? "回看不影响等待。保存不同的答案后，需要重新打字并等待 5 分钟。"
      : state.stage === "typing"
        ? "保存不同的答案后，会清空本次打字内容。仅回看不影响输入进度。"
        : "修改后提交保存，再回到当前进度。未答题目仍需按顺序完成。";
    answerCount();
    step(currentStep(), reviewing ? `回看第 ${questionBeingShown + 1} 题` : "回答问题");
    showSection("questions", false);
  } else if (state.stage === "typing") {
    step(6, "手打 200 字");
    showSection("typing", false);
    progress();
  } else if (state.stage === "waiting") {
    summary();
    tick();
  } else {
    showSection("available", false);
  }
  focusHeading();
  controls();
}

function tick() {
  clearTimeout(timer);
  if (state?.stage !== "waiting" || Number.isInteger(state.viewIndex)) return;
  const remaining = state.readyAt - (Date.now() + offset);
  $("countdown").textContent = formatTime(remaining);
  $("wait-label").textContent = remaining > 0 ? "距离可以进入" : "等待已结束";
  $("wait-next").textContent = remaining > 0 ? "等待结束后继续" : "继续，确认进入";
  $("wait-next").disabled = busy || remaining > 0;
  if (remaining > 0) {
    confirmRequested = false;
    step(7, "等待 5 分钟");
    showSection("waiting");
    if (!document.hidden) timer = setTimeout(tick, 1000);
  } else if (confirmRequested) {
    step(8, "最后确认");
    showSection("confirm");
  } else {
    step(7, "等待已结束");
    showSection("waiting");
  }
}

function progress() {
  const actual = [...accepted];
  const expected = [...INPUT_PASSAGE];
  const original = [...PASSAGE];
  let matched = 0;
  while (matched < actual.length && actual[matched] === expected[matched]) matched++;
  const incorrect = matched < actual.length;
  if (incorrect) {
    $("progress").textContent = matched >= expected.length
      ? "正文已经完整，请删除末尾多余的文字。"
      : original[matched] === "你" && actual[matched] === "你"
        ? `第 ${matched + 1} 字：原文「你」必须输入为「我」。`
        : `第 ${matched + 1} 字不一致，应输入「${expected[matched]}」。`;
  } else {
    $("progress").textContent = matched === expected.length ? "全部匹配。" : original[matched] === "你" ? "当前「你」，请输入「我」。" : "";
  }
  $("match-count").textContent = `${matched} / 200`;
  $("progress").classList.toggle("field-error", incorrect);
  $("progress").classList.toggle("status", !incorrect);
  letters.forEach((span, index) => {
    const name = index < matched ? "matched" : index === matched ? incorrect ? "incorrect" : "position" : "";
    if (span.className !== name) span.className = name;
  });
  const current = letters[matched];
  if (current && section === "typing" && !document.hidden) {
    const box = $("passage");
    const boxRect = box.getBoundingClientRect();
    const markRect = current.getBoundingClientRect();
    if (markRect.bottom > boxRect.bottom - 12 || markRect.top < boxRect.top) {
      box.scrollTop += markRect.top - boxRect.top - box.clientHeight / 2;
    }
  }
  controls();
}

for (const name of ["paste", "drop", "dragover"]) {
  field.addEventListener(name, event => {
    event.preventDefault();
    showError(new Error("禁止粘贴或拖入。请亲手把文字打完。"));
  });
}
field.addEventListener("keydown", event => {
  if (!event.isTrusted) return;
  keyAt = performance.now();
  if (field.value !== accepted) field.value = accepted;
  if (((event.ctrlKey || event.metaKey) && ["v", "z", "y"].includes(event.key.toLowerCase())) ||
      (event.shiftKey && event.key === "Insert")) event.preventDefault();
});
field.addEventListener("compositionstart", event => {
  if (!event.isTrusted) return;
  composing = true;
  compositionAt = performance.now();
  controls();
});
field.addEventListener("compositionend", event => {
  if (!event.isTrusted) return;
  composing = false;
  compositionAt = performance.now();
  setTimeout(progress, 0);
});
field.addEventListener("beforeinput", event => {
  const ime = composing || performance.now() - compositionAt < 1500;
  const recentKey = performance.now() - keyAt < 1500;
  const type = event.inputType || "";
  const insert = ["insertText", "insertCompositionText", "insertFromComposition"].includes(type);
  const deletion = type.startsWith("delete") && !type.includes("Drag");
  permittedInput = event.isTrusted && (ime || recentKey) && (insert || deletion) &&
    (ime || !event.data || [...event.data].length === 1) && field.value === accepted;
  if (!permittedInput) {
    event.preventDefault();
    field.value = accepted;
    showError(new Error("这里只接受手动键盘输入，请逐字输入。"));
  }
});
field.addEventListener("input", event => {
  if (!event.isTrusted || !permittedInput) field.value = accepted;
  else {
    accepted = field.value;
    if (!composing) progress();
  }
  permittedInput = false;
});

// Textareas retain normal Enter/newline behavior; only an explicit button advances.
$("questions-form").addEventListener("submit", event => event.preventDefault());
$("answer").addEventListener("input", () => {
  answerCount();
  $("answer-error").hidden = true;
  $("answer").removeAttribute("aria-invalid");
});
$("submit-answer").addEventListener("click", event => {
  if (!event.isTrusted || busy) return;
  const index = questionBeingShown;
  const question = QUESTIONS[index];
  const text = $("answer").value.trim();
  if ([...text].length < question.minimum || text.length > 500) {
    $("answer-error").textContent = `请把理由写清楚，至少 ${question.minimum} 字，最多 500 字。`;
    $("answer-error").hidden = false;
    $("answer").setAttribute("aria-invalid", "true");
    $("answer").focus();
    return;
  }
  action(async () => {
    const editing = Number.isInteger(state.viewIndex);
    const changed = editing && text !== state.answers[index];
    const next = await request(editing ? "edit-answer" : "answer", { id: state.id, index, text });
    drafts.delete(index);
    if (changed) { accepted = ""; field.value = ""; }
    display(next);
  });
});
$("resume-flow").addEventListener("click", event => {
  if (!event.isTrusted) return;
  action(async () => {
    drafts.delete(questionBeingShown);
    display(await request("resume", { id: state.id }));
  });
});
$("question-back").addEventListener("click", event => {
  if (!event.isTrusted || questionBeingShown <= 0) return;
  action(async () => {
    recordDraft();
    display(await request("view-question", { id: state.id, index: questionBeingShown - 1 }));
  });
});
$("typing-back").addEventListener("click", event => {
  if (!event.isTrusted) return;
  action(async () => display(await request("view-question", { id: state.id, index: QUESTIONS.length - 1 })));
});
$("wait-next").addEventListener("click", event => {
  if (!event.isTrusted || busy || state?.stage !== "waiting" || state.readyAt > Date.now() + offset) return;
  confirmRequested = true;
  tick();
});
$("start-wait").addEventListener("click", event => {
  if (!event.isTrusted || composing || accepted !== INPUT_PASSAGE || field.value !== accepted) return;
  action(async () => {
    display(await request("typed", { id: state.id, text: accepted, manual: true }));
    accepted = "";
    field.value = "";
  });
});
$("enter").addEventListener("click", event => {
  if (!event.isTrusted) return;
  action(async () => {
    const result = await request("enter", { id: state.id });
    clearPrivateContent();
    location.replace(result.target);
  });
});
$("open-available").addEventListener("click", event => {
  if (!event.isTrusted) return;
  location.replace(settings ? chrome.runtime.getURL("options.html") : state.target);
});
for (const button of document.querySelectorAll(".leave")) {
  button.addEventListener("click", event => {
    if (!event.isTrusted) return;
    action(async () => {
      await request("cancel");
      clearTimeout(timer);
      clearPrivateContent();
      field.value = "";
      const tab = await chrome.tabs.getCurrent();
      if (tab) await chrome.tabs.remove(tab.id);
    });
  });
}
document.addEventListener("visibilitychange", tick);
window.addEventListener("pageshow", tick);
window.addEventListener("pagehide", () => clearTimeout(timer));
window.addEventListener("hashchange", () => location.reload());
action(async () => display(await request("begin", { target })));
