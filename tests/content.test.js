"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");
const ticketUrl = "https://tickets.interpark.com/gates/ticket/26014329?bc=61776";

function fixture({ active = false, count = 1, site = "interpark", label, legacyContainer = true } = {}) {
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
      textContent: label ?? (site === "practice" && !active ? "남은시간 00:05" : "10/12 19:00 예매하기"),
      disabled,
      isConnected: true,
      style: { display: "block", visibility: "visible" },
      getClientRects: () => [{}],
      getAttribute: (name) => attrs[name] ?? null,
      setAttribute: (name, value) => { attrs[name] = value; },
      matches: (selector) => selector === ":disabled" && button.disabled,
      closest: (selector) => selector === "button" ? button : null,
      click() {
        if (button.disabled) return;
        for (const listener of listeners.get("click") || []) listener({ target: button });
        clickCount += 1;
      }
    };
    return button;
  }

  buttons = Array.from({ length: count }, () => makeButton(!active));
  const document = {
    title: "테스트 공연",
    documentElement: {},
    body: { textContent: "예매 준비가 완료됐어요" },
    querySelector: (selector) => selector === "h3" ? { textContent: "테스트 공연" } : null,
    querySelectorAll(selector) {
      if (selector === "h2") return [{ textContent: "예매 준비가 완료됐어요" }];
      if (selector === ".buttons > button") return legacyContainer ? buttons : [];
      if (selector === "button") return buttons;
      if (selector === "#book") return site === "practice" ? buttons : [];
      return [];
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    }
  };
  const location = { href: site === "practice" ? "https://ticket.ggul.store/" : ticketUrl };
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
    window: { addEventListener() {} },
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
    tickRoute() { for (const callback of timers.values()) callback(); },
    replace({ active: replacementActive = false, label: replacementLabel } = {}) {
      buttons.forEach((button) => { button.isConnected = false; });
      buttons = [makeButton(!replacementActive)];
      if (replacementLabel !== undefined) buttons[0].textContent = replacementLabel;
      this.mutate();
    },
    duplicate() { buttons.push(makeButton(false)); this.mutate(); },
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
