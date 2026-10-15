"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");
const ticketUrl = "https://tickets.interpark.com/gates/ticket/26014329?bc=61776";

function fixture({ active = false, count = 1, site = "interpark", label, legacyContainer = true,
  ready = site !== "ssg", heading = ready ? "예매 준비가 완료됐어요" : null,
  url, nested = false } = {}) {
  const listeners = new Map();
  const observers = [];
  const timers = new Map();
  const storage = {};
  let timerId = 0;
  let messageListener;
  let clickCount = 0;
  let tick = 0;
  let buttons = [];

  function makeButton(disabled = true) {
    const attrs = {};
    const button = {
      textContent: label ?? (site === "ssg"
        ? (active ? "예매하기" : "10.14(수) 11:00 오픈 예정")
        : (site === "practice" && !active ? "남은시간 00:05" : "10/12 19:00 예매하기")),
      disabled,
      isConnected: true,
      style: { display: "block", visibility: "visible" },
      rects: [{}],
      hiddenAncestor: false,
      getClientRects: () => button.rects,
      getAttribute: (name) => attrs[name] ?? null,
      setAttribute: (name, value) => { attrs[name] = value; },
      matches: (selector) => selector === ":disabled" && button.disabled,
      closest: (selector) => selector === "button" ? button
        : selector === "[hidden], [inert]" && button.hiddenAncestor ? {} : null,
      click() {
        if (button.disabled) return;
        for (const listener of listeners.get("click") || []) listener({ target: button });
        clickCount += 1;
      }
    };
    if (nested) {
      const child = { textContent: button.textContent, closest: (selector) => selector === "button" ? button : null };
      button.labelChild = child;
      Object.defineProperty(button, "textContent", {
        get: () => child.textContent,
        set: (value) => { child.textContent = value; }
      });
    }
    return button;
  }

  buttons = Array.from({ length: count }, () => makeButton(!active));
  const document = {
    title: "테스트 공연",
    documentElement: {},
    body: { textContent: heading ?? "" },
    querySelector: (selector) => selector === "h3" && site !== "ssg" ? { textContent: "테스트 공연" } : null,
    querySelectorAll(selector) {
      if (selector === "h2") return heading === null ? [] : [{ textContent: heading }];
      if (selector === ".buttons > button") return legacyContainer ? buttons : [];
      if (selector === "button") return buttons;
      if (selector === "#book") return site === "practice" ? buttons : [];
      return [];
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    }
  };
  const location = { href: url ?? (site === "ssg" ? "https://ticket.ssg.com/ticket"
    : site === "practice" ? "https://ticket.ggul.store/" : ticketUrl) };
  const chrome = {
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    storage: { local: {
      set(value) { Object.assign(storage, value); return Promise.resolve(); },
      remove(key) { delete storage[key]; return Promise.resolve(); }
    } }
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const sandbox = {
    chrome, document, location, MutationObserver,
    getComputedStyle: (element) => element.style,
    performance: { now: () => ++tick },
    setInterval(callback) { timers.set(++timerId, callback); return timerId; },
    clearInterval(id) { timers.delete(id); },
    window: { addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    } },
    Date: { now: () => 1000 }
  };
  vm.runInNewContext(source, sandbox);

  return {
    buttons: () => buttons,
    storage,
    location,
    document,
    get clickCount() { return clickCount; },
    get activeObservers() { return observers.filter((observer) => observer.active).length; },
    get activeTimers() { return timers.size; },
    mutate() { for (const observer of observers) if (observer.active) observer.callback(); },
    setHeading(value) {
      heading = value;
      document.body.textContent = value ?? "";
      this.mutate();
    },
    tickRoute() { for (const callback of timers.values()) callback(); },
    replace({ active: replacementActive = false, label: replacementLabel } = {}) {
      buttons.forEach((button) => { button.isConnected = false; });
      buttons = [makeButton(!replacementActive)];
      if (replacementLabel !== undefined) buttons[0].textContent = replacementLabel;
      this.mutate();
    },
    duplicate() { buttons.push(makeButton(false)); this.mutate(); },
    manualClick() {
      const button = buttons[0];
      if (button.disabled) return;
      for (const listener of listeners.get("click") || []) listener({ target: button.labelChild || button });
      clickCount += 1;
    },
    dispatch(type) { for (const listener of listeners.get(type) || []) listener(); },
    send(type) {
      let response;
      messageListener({ type, tabId: 42 }, {}, (value) => { response = value; });
      return response;
    },
    reinject() { vm.runInNewContext(source, sandbox); }
  };
}

test("disabled to enabled clicks exactly once and records timing", () => {
  const app = fixture();
  assert.equal(app.send("start").phase, "watching");
  app.buttons()[0].disabled = false;
  app.mutate();
  app.mutate();
  assert.equal(app.clickCount, 1);
  assert.equal(app.send("status").phase, "clicked");
  assert.equal(app.storage.lastClick.tabId, 42);
  assert.equal(app.storage.lastClick.detectedAt, 1000);
  assert.equal(app.storage.lastClick.clickedAt, 1000);
  assert.equal(app.storage.lastClick.latencyMs, 1);
  assert.equal(app.activeObservers, 0);
  assert.equal(app.activeTimers, 0);
  assert.equal(app.send("start").canStart, false);
});

test("button replacement is observed", () => {
  const app = fixture();
  app.send("start");
  app.replace({ active: true });
  assert.equal(app.clickCount, 1);
});

test("aria-disabled and hidden buttons are not clicked", () => {
  const app = fixture();
  const button = app.buttons()[0];
  button.setAttribute("aria-disabled", "true");
  app.send("start");
  button.disabled = false;
  app.mutate();
  assert.equal(app.clickCount, 0);
  button.setAttribute("aria-disabled", "false");
  button.style.display = "none";
  app.mutate();
  assert.equal(app.clickCount, 0);
  button.style.display = "block";
  app.mutate();
  assert.equal(app.clickCount, 1);
});

test("already enabled button is clicked on start", () => {
  const app = fixture({ active: true });
  assert.equal(app.send("start").phase, "clicked");
  assert.equal(app.clickCount, 1);
});

test("repeated start and script injection do not add watchers", () => {
  const app = fixture();
  app.send("start");
  app.reinject();
  app.send("start");
  assert.equal(app.activeObservers, 1);
  assert.equal(app.activeTimers, 1);
  app.buttons()[0].disabled = false;
  app.mutate();
  assert.equal(app.clickCount, 1);
});

test("manual stop and manual click prevent automatic click", () => {
  const stopped = fixture();
  stopped.send("start");
  stopped.send("stop");
  stopped.buttons()[0].disabled = false;
  stopped.mutate();
  assert.equal(stopped.clickCount, 0);
  assert.equal(stopped.activeObservers, 0);

  const manual = fixture();
  manual.send("start");
  manual.buttons()[0].disabled = false;
  manual.buttons()[0].click();
  manual.mutate();
  assert.equal(manual.clickCount, 1);
  assert.equal(manual.send("status").canStart, false);
});

test("duplicate buttons and access error stop without clicking", () => {
  const duplicate = fixture();
  duplicate.send("start");
  duplicate.duplicate();
  assert.equal(duplicate.send("status").phase, "error");
  assert.equal(duplicate.clickCount, 0);

  const error = fixture();
  error.send("start");
  error.document.body.textContent = "정상적인 접근이 아닙니다";
  error.mutate();
  assert.equal(error.send("status").phase, "error");
  assert.equal(error.clickCount, 0);
});

test("navigation stops watcher; a new document does not rearm", () => {
  const app = fixture();
  app.send("start");
  app.location.href = "https://tickets.interpark.com/gates/ticket/26014330";
  app.tickRoute();
  assert.equal(app.send("status").phase, "stopped");
  assert.equal(app.activeObservers, 0);
  const reloaded = fixture();
  assert.equal(reloaded.send("status").phase, "idle");
  assert.equal(reloaded.activeObservers, 0);
});

test("practice countdown button is selected before its label changes", () => {
  const app = fixture({ site: "practice" });
  assert.equal(app.send("status").label, "남은시간 00:05");
  assert.equal(app.send("start").phase, "watching");
  app.buttons()[0].textContent = "남은시간 00:00";
  app.mutate();
  assert.equal(app.clickCount, 0);
  app.buttons()[0].textContent = "예매하기";
  app.buttons()[0].disabled = false;
  app.mutate();
  app.mutate();
  assert.equal(app.clickCount, 1);
  assert.equal(app.send("status").phase, "clicked");
});

test("interpark countdown can start without the legacy container and waits for booking text", () => {
  const app = fixture({ label: "남은시간 02:45", legacyContainer: false });
  assert.equal(app.send("status").canStart, true);
  assert.equal(app.send("status").label, "남은시간 02:45");
  assert.equal(app.send("start").phase, "watching");
  const button = app.buttons()[0];
  for (const label of ["남은시간 02:44", "남은 시간\n00:00", "남은시간 01:00:00"]) {
    button.textContent = label;
    // Some pages only style the countdown as disabled, or enable before relabeling.
    button.disabled = false;
    app.mutate();
    app.tickRoute();
    assert.equal(app.clickCount, 0);
  }
  button.disabled = true;
  button.textContent = "예매하기";
  app.mutate();
  assert.equal(app.clickCount, 0);
  button.disabled = false;
  app.mutate();
  app.mutate();
  assert.equal(app.clickCount, 1);
  assert.equal(app.storage.lastClick.label, "예매하기");
  assert.equal(app.activeObservers, 0);
  assert.equal(app.activeTimers, 0);
});

test("interpark countdown replaced with an enabled booking button clicks once", () => {
  const app = fixture({ label: "남은시간 00:01", legacyContainer: false });
  assert.equal(app.send("start").phase, "watching");
  app.replace({ active: true, label: "예매하기" });
  app.mutate();
  assert.equal(app.clickCount, 1);
});

test("NOL screenshot heading and nested countdown allow monitoring until booking is enabled", () => {
  for (const order of ["label-first", "enabled-first"]) {
    const app = fixture({ heading: "예매는 오픈 시간부터 가능해요",
      label: "남은시간 15:17", nested: true, legacyContainer: false });
    assert.equal(app.send("status").label, "남은시간 15:17");
    assert.equal(app.send("status").canStart, true);
    assert.equal(app.send("start").phase, "watching");
    assert.equal(app.send("status").message, "예매 오픈 대기 중");
    const button = app.buttons()[0];
    button.labelChild.textContent = "남은시간 00:00";
    app.mutate();
    assert.equal(app.clickCount, 0);
    if (order === "label-first") button.labelChild.textContent = "예매하기";
    else button.disabled = false;
    app.mutate();
    app.tickRoute();
    assert.equal(app.clickCount, 0);
    button.labelChild.textContent = "예매하기";
    button.disabled = false;
    app.mutate();
    app.mutate();
    app.tickRoute();
    assert.equal(app.clickCount, 1);
    assert.equal(app.send("status").phase, "clicked");
    assert.equal(app.send("start").canStart, false);
    assert.equal(app.storage.lastClick.label, "예매하기");
    assert.equal(app.activeObservers, 0);
    assert.equal(app.activeTimers, 0);
  }
});

test("NOL accepts missing or arbitrary headings and survives heading changes while watching", () => {
  for (const heading of [null, "", "다른 안내 제목", "예매 준비가 완료됐어요"]) {
    const app = fixture({ heading, label: "남은시간 00:01" });
    assert.equal(app.send("status").canStart, true);
    assert.equal(app.send("start").phase, "watching");
    for (const changed of ["예매는 오픈 시간부터 가능해요", null, "변경된 안내"]) {
      app.setHeading(changed);
      app.tickRoute();
      assert.equal(app.send("status").phase, "watching");
      assert.equal(app.send("status").message, "예매 오픈 대기 중");
      assert.equal(app.clickCount, 0);
    }
    app.replace({ active: true, label: "예매하기" });
    assert.equal(app.clickCount, 1);

    const active = fixture({ heading, active: true, label: "예매하기" });
    assert.equal(active.send("start").phase, "clicked");
    assert.equal(active.clickCount, 1);
  }
});

test("NOL without a heading still rejects missing, ambiguous, error and unsupported targets", () => {
  const blocked = [
    fixture({ heading: null, count: 0 }),
    fixture({ heading: null, count: 2, label: "남은시간 00:01" }),
    fixture({ heading: null, active: true, label: "뒤로가기" }),
    fixture({ heading: null, active: true, url: "https://example.com/" }),
    fixture({ heading: null, active: true, url: "http://tickets.interpark.com/gates/ticket/26014329" }),
    fixture({ heading: null, active: true, url: "https://tickets.interpark.com/gates/ticket/not-a-number" })
  ];
  const accessError = fixture({ heading: "정상적인 접근이 아닙니다", active: true });
  blocked.push(accessError);
  for (const app of blocked) {
    assert.equal(app.send("status").canStart, false);
    assert.equal(app.send("start").phase, "error");
    assert.equal(app.clickCount, 0);
    assert.equal(app.activeObservers, 0);
    assert.equal(app.activeTimers, 0);
  }
  assert.equal(accessError.send("status").message, "접근 오류 화면입니다.");
});

test("NOL without a heading preserves manual stop, manual click, navigation and access error cleanup", () => {
  for (const action of ["stop", "manual-click", "route", "pagehide", "access-error", "duplicate"]) {
    const app = fixture({ heading: null, label: "남은시간 00:01", nested: true });
    assert.equal(app.send("start").phase, "watching");
    if (action === "stop") app.send("stop");
    else if (action === "manual-click") {
      app.buttons()[0].textContent = "예매하기";
      app.buttons()[0].disabled = false;
      app.manualClick();
    } else if (action === "route") {
      app.location.href += "#changed";
      app.tickRoute();
    } else if (action === "pagehide") app.dispatch("pagehide");
    else if (action === "access-error") app.setHeading("정상적인 접근이 아닙니다");
    else app.duplicate();
    app.replace({ active: true, label: "예매하기" });
    app.tickRoute();
    assert.equal(app.clickCount, action === "manual-click" ? 1 : 0);
    assert.equal(app.activeObservers, 0);
    assert.equal(app.activeTimers, 0);
    assert.equal(app.send("status").phase,
      ["access-error", "duplicate"].includes(action) ? "error" : "stopped");
  }
});

test("unrelated buttons cannot start watching and ambiguous countdowns are rejected", () => {
  for (const label of ["뒤로가기", "알림 신청", "남은시간 안내"]) {
    const app = fixture({ active: true, label, legacyContainer: false });
    assert.equal(app.send("status").canStart, false);
    assert.equal(app.send("start").phase, "error");
    assert.equal(app.clickCount, 0);
  }
  const duplicate = fixture({ count: 2, label: "남은시간 02:45", legacyContainer: false });
  assert.equal(duplicate.send("start").canStart, false);
  assert.equal(duplicate.clickCount, 0);
});

test("practice page locks after manual click and does not rearm", () => {
  const app = fixture({ site: "practice" });
  app.send("start");
  app.buttons()[0].disabled = false;
  app.buttons()[0].click();
  app.mutate();
  assert.equal(app.clickCount, 1);
  assert.equal(app.send("start").canStart, false);
  const newDocument = fixture({ site: "practice" });
  assert.equal(newDocument.send("status").phase, "idle");
});

test("SSG scheduled opening starts without the NOL heading and never clicks a pending label", () => {
  const app = fixture({ site: "ssg", active: true, label: "10.14(수) 11:00 오픈 예정" });
  assert.equal(app.document.querySelectorAll("h2").length, 0);
  assert.equal(app.send("status").canStart, true);
  assert.equal(app.send("start").phase, "watching");
  assert.equal(app.send("status").message, "예매 오픈 대기 중");
  for (const label of ["10.14(수)\n11:00\u00a0오픈   예정", "남은시간 00:01",
    "남은 시간\n00:00", "남은시간 01:00:00"]) {
    app.buttons()[0].textContent = label;
    app.mutate();
    app.tickRoute();
    assert.equal(app.clickCount, 0);
    assert.equal(app.send("status").phase, "watching");
  }
  assert.equal(app.send("status").title, "테스트 공연");
});

test("SSG waits for both booking text and activation in either order", () => {
  for (const order of ["label-first", "enabled-first"]) {
    const app = fixture({ site: "ssg" });
    app.send("start");
    app.reinject();
    app.send("start");
    assert.equal(app.activeObservers, 1);
    assert.equal(app.activeTimers, 1);
    const button = app.buttons()[0];
    if (order === "label-first") button.textContent = "예매하기";
    else button.disabled = false;
    app.mutate();
    assert.equal(app.clickCount, 0);
    button.textContent = "예매하기";
    button.disabled = false;
    app.mutate();
    app.mutate();
    app.tickRoute();
    assert.equal(app.clickCount, 1);
    assert.equal(app.send("status").phase, "clicked");
    assert.equal(app.send("start").canStart, false);
    assert.equal(app.activeObservers, 0);
    assert.equal(app.activeTimers, 0);
    assert.equal(app.storage.lastClick.url, "https://ticket.ssg.com/ticket");
    assert.equal(app.storage.lastClick.label, "예매하기");
    assert.equal(app.storage.lastClick.latencyMs, 1);
  }
});

test("SSG nested label changes and whole button replacement click once", () => {
  const nested = fixture({ site: "ssg", nested: true, active: true, label: "10.14(수) 11:00 오픈 예정" });
  nested.send("start");
  nested.buttons()[0].labelChild.textContent = "\n 예매하기\u00a0 ";
  nested.mutate();
  nested.mutate();
  assert.equal(nested.clickCount, 1);
  assert.equal(nested.storage.lastClick.label, "예매하기");

  const replaced = fixture({ site: "ssg", label: "남은시간 00:01" });
  replaced.send("start");
  replaced.replace({ active: true, label: "예매" });
  replaced.mutate();
  assert.equal(replaced.clickCount, 1);
  assert.equal(replaced.storage.lastClick.label, "예매");
});

test("SSG already active booking labels click immediately, while unknown and closed labels never click", () => {
  for (const label of ["예매", "예매하기", "\n 예매하기 \t"]) {
    const app = fixture({ site: "ssg", active: true, label });
    assert.equal(app.send("start").phase, "clicked");
    assert.equal(app.clickCount, 1);
  }
  for (const label of ["매진", "예매 마감", "예매하기 마감", "오픈 예정", "다른 버튼", "예매 안내", "예매하기 취소"]) {
    const idle = fixture({ site: "ssg", active: true, label });
    assert.equal(idle.send("status").canStart, false);
    assert.equal(idle.send("start").phase, "error");
    assert.equal(idle.clickCount, 0);

    const watching = fixture({ site: "ssg" });
    watching.send("start");
    watching.buttons()[0].textContent = label;
    watching.buttons()[0].disabled = false;
    watching.mutate();
    watching.tickRoute();
    assert.equal(watching.clickCount, 0);
    assert.equal(watching.send("status").phase, "watching");
  }
});

test("SSG does not click hidden, disconnected, or aria-disabled booking buttons", () => {
  const blocks = [
    (button) => { button.style.display = "none"; },
    (button) => { button.style.visibility = "hidden"; },
    (button) => { button.hiddenAncestor = true; },
    (button) => { button.rects = []; },
    (button) => { button.isConnected = false; },
    (button) => { button.setAttribute("aria-disabled", "true"); }
  ];
  for (const block of blocks) {
    const app = fixture({ site: "ssg", active: true });
    const button = app.buttons()[0];
    block(button);
    assert.equal(app.send("start").phase, "watching");
    app.mutate();
    assert.equal(app.clickCount, 0);
    button.style.display = "block";
    button.style.visibility = "visible";
    button.hiddenAncestor = false;
    button.rects = [{}];
    button.isConnected = true;
    button.setAttribute("aria-disabled", "false");
    app.mutate();
    assert.equal(app.clickCount, 1);
  }
});

test("SSG refuses multiple pending candidates and stops if a candidate is added", () => {
  const multiple = fixture({ site: "ssg", count: 2 });
  multiple.buttons()[1].textContent = "예매하기";
  assert.equal(multiple.send("status").canStart, false);
  assert.equal(multiple.send("start").phase, "error");
  assert.equal(multiple.clickCount, 0);

  const app = fixture({ site: "ssg" });
  app.send("start");
  app.buttons()[0].textContent = "예매하기";
  app.buttons()[0].disabled = false;
  app.duplicate();
  assert.equal(app.send("status").phase, "error");
  assert.equal(app.clickCount, 0);
  assert.equal(app.activeObservers, 0);
  assert.equal(app.activeTimers, 0);
});

test("SSG manual stop, nested manual click, navigation and pagehide clean up monitoring", () => {
  const stopped = fixture({ site: "ssg" });
  stopped.send("start");
  stopped.send("stop");
  stopped.replace({ active: true, label: "예매하기" });
  assert.equal(stopped.clickCount, 0);
  assert.equal(stopped.activeObservers, 0);
  assert.equal(stopped.activeTimers, 0);

  const manual = fixture({ site: "ssg", nested: true });
  manual.send("start");
  manual.buttons()[0].textContent = "예매하기";
  manual.buttons()[0].disabled = false;
  manual.manualClick();
  manual.mutate();
  assert.equal(manual.clickCount, 1);
  assert.equal(manual.send("status").phase, "stopped");
  assert.equal(manual.send("start").canStart, false);
  assert.equal(manual.activeObservers, 0);
  assert.equal(manual.activeTimers, 0);

  for (const event of ["route-timer", "hashchange", "popstate", "pagehide"]) {
    const app = fixture({ site: "ssg" });
    app.send("start");
    if (event !== "pagehide") app.location.href += "#changed";
    if (event === "route-timer") app.tickRoute();
    else app.dispatch(event);
    app.replace({ active: true, label: "예매하기" });
    assert.equal(app.send("status").phase, "stopped");
    assert.equal(app.clickCount, 0);
    assert.equal(app.activeObservers, 0);
    assert.equal(app.activeTimers, 0);
  }
  const reloaded = fixture({ site: "ssg" });
  assert.equal(reloaded.send("status").phase, "idle");
  assert.equal(reloaded.activeObservers, 0);
});

test("SSG content URL matching allows only the ticket page with optional slash, query or hash", () => {
  for (const suffix of ["", "/", "?event=1", "#tickets", "/?event=1#tickets"]) {
    const app = fixture({ site: "ssg", url: `https://ticket.ssg.com/ticket${suffix}` });
    assert.equal(app.send("start").phase, "watching");
  }
  for (const url of ["http://ticket.ssg.com/ticket", "https://ticket.ssg.com/",
    "https://ticket.ssg.com/tickets", "https://ticket.ssg.com/ticket/detail",
    "https://ticket.ssg.com/ticket//", "https://ticket.ssg.com.evil.test/ticket",
    "https://example.com/ticket"]) {
    const app = fixture({ site: "ssg", active: true, url });
    assert.equal(app.send("status").canStart, false);
    assert.equal(app.send("start").phase, "error");
    assert.equal(app.clickCount, 0);
  }
  const practice = fixture({ site: "practice", ready: false });
  assert.equal(practice.send("status").canStart, false);
  assert.equal(practice.send("start").phase, "error");
});
