(() => {
  "use strict";

  // Reopening the popup injects this file again. Keep one watcher per document.
  if (globalThis.__nolTicketWatcher) return;
  globalThis.__nolTicketWatcher = true;

  const interparkUrl = /^https:\/\/tickets\.interpark\.com\/gates\/ticket\/\d+(?:[/?#]|$)/;
  const practiceUrl = /^https:\/\/ticket\.ggul\.store\/(?:[?#]|$)/;
  function siteForUrl(url) {
    if (interparkUrl.test(url)) return "interpark";
    if (practiceUrl.test(url)) return "practice";
    return null;
  }
  const readyText = "예매 준비가 완료됐어요";
  const accessErrorText = "정상적인 접근이 아닙니다";
  const state = {
    phase: "idle",
    message: "감시 전",
    observer: null,
    routeTimer: null,
    startUrl: null,
    tabId: null,
    finishedByClick: false
  };

  function pageInfo() {
    const site = siteForUrl(location.href);
    const headings = [...document.querySelectorAll("h2")];
    const ready = headings.some((heading) => heading.textContent.trim() === readyText);
    const accessError = document.body?.textContent.includes(accessErrorText) || false;
    const candidates = site === "practice"
      ? [...document.querySelectorAll("#book")]
      : site === "interpark"
        ? [...document.querySelectorAll(".buttons > button")]
          .filter((button) => button.textContent.includes("예매하기"))
        : [];
    return {
      title: document.querySelector("h3")?.textContent.trim() || document.title,
      label: candidates.length === 1 ? candidates[0].textContent.trim() : "",
      ready,
      accessError,
      candidates
    };
  }

  function visible(button) {
    const style = getComputedStyle(button);
    return button.isConnected && button.getClientRects().length > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      !button.closest("[hidden], [inert]");
  }

  function enabled(button) {
    return visible(button) && !button.matches(":disabled") &&
      button.getAttribute("aria-disabled") !== "true";
  }

  function cleanup() {
    state.observer?.disconnect();
    state.observer = null;
    if (state.routeTimer !== null) clearInterval(state.routeTimer);
    state.routeTimer = null;
    state.startUrl = null;
  }

  function stop(message, finishedByClick = false) {
    cleanup();
    state.finishedByClick ||= finishedByClick;
    state.phase = "stopped";
    state.message = message;
  }

  function fail(message) {
    cleanup();
    state.phase = "error";
    state.message = message;
  }

  function check() {
    if (state.phase !== "watching") return;
    if (location.href !== state.startUrl || !siteForUrl(location.href)) {
      stop("페이지가 이동해 감시를 중지했습니다.");
      return;
    }

    const info = pageInfo();
    if (info.accessError) {
      fail("접근 오류 화면입니다. 감시를 중지했습니다.");
      return;
    }
    if (info.candidates.length > 1) {
      fail("예매 버튼이 여러 개라 감시를 중지했습니다.");
      return;
    }
    if (!info.ready || info.candidates.length === 0) {
      state.message = "예매 준비 화면 또는 버튼을 기다리는 중";
      return;
    }

    const button = info.candidates[0];
    if (!enabled(button)) {
      state.message = "버튼 활성화 대기 중";
      return;
    }

    const detectedAt = Date.now();
    const detectedTick = performance.now();
    // Lock and disconnect before click(), which may synchronously dispatch events.
    state.phase = "clicked";
    state.finishedByClick = true;
    state.message = "클릭 실행";
    cleanup();

    const clickedAt = Date.now();
    const latencyMs = Math.max(0, performance.now() - detectedTick);
    const lastClick = {
      tabId: state.tabId,
      url: location.href,
      title: info.title,
      label: info.label,
      detectedAt,
      clickedAt,
      latencyMs
    };
    try {
      button.click();
      // Send the record after click() so storage work cannot delay the action.
      chrome.storage.local.set({ lastClick }).catch(() => {});
    } catch {
      state.phase = "error";
      state.message = "버튼 클릭 호출에 실패했습니다.";
    }
  }

  function snapshot() {
    const info = pageInfo();
    let message = state.message;
    if (info.accessError) message = "접근 오류 화면입니다.";
    else if (!info.ready && state.phase !== "watching" && state.phase !== "clicked") message = "예매 준비 화면이 아닙니다.";
    else if (info.candidates.length > 1) message = "예매 버튼이 여러 개입니다.";
    else if (info.candidates.length === 0 && state.phase !== "watching" && state.phase !== "clicked") message = "예매 버튼을 찾지 못했습니다.";
    return {
      phase: state.phase,
      message,
      title: info.title,
      label: info.label,
      canStart: !state.finishedByClick && state.phase !== "watching" &&
        Boolean(siteForUrl(location.href)) && info.ready && !info.accessError &&
        info.candidates.length === 1
    };
  }

  function start(tabId) {
    if (state.phase === "watching" || state.finishedByClick) return snapshot();
    const info = pageInfo();
    if (!siteForUrl(location.href) || !info.ready || info.accessError || info.candidates.length !== 1) {
      state.phase = "error";
      state.message = "대상 예매 화면과 버튼을 확인할 수 없습니다.";
      return snapshot();
    }

    state.tabId = tabId;
    state.startUrl = location.href;
    state.phase = "watching";
    state.message = "버튼 활성화 대기 중";
    state.observer = new MutationObserver(check);
    state.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "class", "style", "hidden", "inert"],
      childList: true,
      characterData: true,
      subtree: true
    });
    state.routeTimer = setInterval(check, 250);
    check();
    return snapshot();
  }

  document.addEventListener("click", (event) => {
    if (state.phase !== "watching") return;
    const button = event.target.closest?.("button");
    if (button && pageInfo().candidates.includes(button)) {
      stop("사용자가 직접 클릭하여 감시를 중지했습니다.", true);
    }
  }, true);

  window.addEventListener("pagehide", () => {
    if (state.phase === "watching") stop("페이지가 종료되어 감시를 중지했습니다.");
  });
  window.addEventListener("popstate", check);
  window.addEventListener("hashchange", check);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "start") sendResponse(start(message.tabId));
    else if (message?.type === "stop") {
      if (state.phase === "watching") stop("사용자가 감시를 중지했습니다.");
      sendResponse(snapshot());
    } else if (message?.type === "status") sendResponse(snapshot());
  });
})();
