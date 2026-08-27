let copyEnabled = false;
const enabledTabs = new Set();

// ── 向指定标签页发送复制保护状态 ──────────────

function sendCopyState(tabId, enabled) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'copyGuard:set', enabled }, () => {
    void chrome.runtime.lastError;
  });
  if (enabled) {
    enabledTabs.add(tabId);
  } else {
    enabledTabs.delete(tabId);
  }
}

// ── 为当前活跃标签页启用，其余禁用 ────────────

function enableForActiveTab() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const activeId = tabs[0]?.id;
    for (const tabId of [...enabledTabs]) {
      if (tabId !== activeId) sendCopyState(tabId, false);
    }
    if (activeId) sendCopyState(activeId, true);
  });
}

// ── 全部禁用 ──────────────────────────────────

function disableEverywhere() {
  for (const tabId of [...enabledTabs]) {
    sendCopyState(tabId, false);
  }
  enabledTabs.clear();
}

// ── 侧边栏行为 ────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['savedJob', 'savedResumeText', 'savedResumeFileName']);
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('侧边栏设置失败：', error));
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ── 消息处理 ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'copyGuard:enable') {
    copyEnabled = true;
    enableForActiveTab();
    sendResponse({ enabled: true });
  }
  if (message.type === 'copyGuard:disable') {
    copyEnabled = false;
    disableEverywhere();
    sendResponse({ enabled: false });
  }
  if (message.type === 'copyGuard:ready' && copyEnabled) {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        sendCopyState(tabId, tabs[0]?.id === tabId);
      });
    }
  }
});

// ── 侧边栏关闭时自动禁用复制保护 ────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidePanel') {
    port.onDisconnect.addListener(() => {
      copyEnabled = false;
      disableEverywhere();
    });
  }
});

// ── 标签页切换 ────────────────────────────────

chrome.tabs.onActivated.addListener(() => {
  if (copyEnabled) enableForActiveTab();
});

// ── 同一标签页导航到新页面时补发状态 ──────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && copyEnabled && tab.active) {
    sendCopyState(tabId, true);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
});
