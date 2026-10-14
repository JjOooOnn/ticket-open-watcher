"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");

async function openPopup(url) {
  const elements = new Map();
  const injections = [];
  const messages = [];
  for (const id of ["show-title", "button-label", "status", "click-record", "start", "stop"]) {
    elements.set(id, { textContent: "", disabled: true, hidden: true, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
  }
  const sandbox = {
    document: { getElementById: (id) => elements.get(id) },
    chrome: {
      tabs: {
        query: async () => [{ id: 42, url, title: "연습 공연" }],
        sendMessage: async (_tabId, message) => {
          messages.push(message);
          return { phase: message.type === "start" ? "watching" : "idle", title: "연습 공연", label: "남은시간 00:05", message: "대기 중", canStart: true };
        }
      },
      scripting: { executeScript: async (options) => { injections.push(options); } },
      storage: { local: { get: async () => ({}), remove: async () => {} } }
    },
    setInterval: () => 1
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(setImmediate);
  return { elements, injections, messages };
}

test("popup accepts the practice site and starts monitoring its tab", async () => {
  const popup = await openPopup("https://ticket.ggul.store/");
  assert.equal(popup.injections.length, 1);
  assert.equal(popup.elements.get("button-label").textContent, "남은시간 00:05");
  assert.equal(popup.elements.get("start").disabled, false);
  await popup.elements.get("start").listeners.click();
  assert.equal(popup.messages.at(-1).type, "start");
  assert.equal(popup.messages.at(-1).tabId, 42);
});

test("popup still accepts Interpark and rejects unrelated sites", async () => {
  const interpark = await openPopup("https://tickets.interpark.com/gates/ticket/26014329?bc=61776");
  assert.equal(interpark.injections.length, 1);
  const unrelated = await openPopup("https://example.com/");
  assert.equal(unrelated.injections.length, 0);
  assert.equal(unrelated.elements.get("start").disabled, true);
});

test("popup accepts SSG ticket URLs and can send start to the selected tab", async () => {
  for (const suffix of ["", "/", "?event=1", "#tickets", "/?event=1#tickets"]) {
    const popup = await openPopup(`https://ticket.ssg.com/ticket${suffix}`);
    assert.equal(popup.injections.length, 1);
    assert.equal(popup.elements.get("start").disabled, false);
    await popup.elements.get("start").listeners.click();
    assert.equal(popup.messages.at(-1).type, "start");
    assert.equal(popup.messages.at(-1).tabId, 42);
  }
});

test("popup rejects unsupported SSG paths and similar hosts", async () => {
  for (const url of ["http://ticket.ssg.com/ticket", "https://ticket.ssg.com/",
    "https://ticket.ssg.com/tickets", "https://ticket.ssg.com/ticket/detail",
    "https://ticket.ssg.com/ticket//", "https://ticket.ssg.com.evil.test/ticket"]) {
    const popup = await openPopup(url);
    assert.equal(popup.injections.length, 0);
    assert.equal(popup.elements.get("start").disabled, true);
    assert.equal(popup.messages.length, 0);
  }
});
