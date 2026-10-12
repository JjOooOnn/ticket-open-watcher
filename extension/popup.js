(() => {
  "use strict";

  const urlPatterns = [
    /^https:\/\/tickets\.interpark\.com\/gates\/ticket\/\d+(?:[/?#]|$)/,
    /^https:\/\/ticket\.ggul\.store\/(?:[?#]|$)/
  ];
  const titleElement = document.getElementById("show-title");
  const labelElement = document.getElementById("button-label");
  const statusElement = document.getElementById("status");
  const recordElement = document.getElementById("click-record");
  const startButton = document.getElementById("start");
  const stopButton = document.getElementById("stop");
  let tabId = null;
  let busy = false;
  let latestStatus = null;

  function render(status) {
    latestStatus = status;
    titleElement.textContent = status.title || "공연명 확인 불가";
    labelElement.textContent = status.label || "예매 버튼 확인 불가";
    statusElement.textContent = status.message;
    startButton.disabled = busy || status.phase === "watching" || !status.canStart;
    stopButton.disabled = busy || status.phase !== "watching";
  }

  async function send(type) {
    return chrome.tabs.sendMessage(tabId, { type, tabId });
  }

  async function showRecord() {
    const { lastClick } = await chrome.storage.local.get("lastClick");
    if (!lastClick || lastClick.tabId !== tabId) {
      recordElement.hidden = true;
      return;
    }
    const detected = new Date(lastClick.detectedAt).toLocaleTimeString("ko-KR", { hour12: false, fractionalSecondDigits: 3 });
    const clicked = new Date(lastClick.clickedAt).toLocaleTimeString("ko-KR", { hour12: false, fractionalSecondDigits: 3 });
    recordElement.textContent = `최근 클릭 실행: 감지 ${detected} · 클릭 ${clicked} · 지연 ${lastClick.latencyMs.toFixed(3)}ms`;
    recordElement.hidden = false;
  }

  async function refresh() {
    if (tabId === null || busy) return;
    try {
      render(await send("status"));
      await showRecord();
    } catch {
      render({ phase: "error", title: latestStatus?.title, label: "", message: "탭에 연결할 수 없습니다. 페이지를 확인해 주세요.", canStart: false });
    }
  }

  async function run(type) {
    if (busy || tabId === null) return;
    busy = true;
    startButton.disabled = true;
    stopButton.disabled = true;
    try {
      if (type === "start") {
        const { lastClick } = await chrome.storage.local.get("lastClick");
        if (lastClick?.tabId === tabId) await chrome.storage.local.remove("lastClick");
      }
      render(await send(type));
      await showRecord();
    } catch (error) {
      render({ phase: "error", title: latestStatus?.title, label: "", message: `명령 실패: ${error.message}`, canStart: false });
    } finally {
      busy = false;
      if (latestStatus) render(latestStatus);
    }
  }

  startButton.addEventListener("click", () => run("start"));
  stopButton.addEventListener("click", () => run("stop"));

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !urlPatterns.some((pattern) => pattern.test(tab.url || ""))) {
        render({ phase: "error", title: tab?.title, label: "", message: "지원하는 예매 또는 연습 탭에서 열어 주세요.", canStart: false });
        return;
      }
      tabId = tab.id;
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await refresh();
      setInterval(refresh, 250);
    } catch (error) {
      render({ phase: "error", title: "", label: "", message: `페이지 확인 실패: ${error.message}`, canStart: false });
    }
  })();
})();
