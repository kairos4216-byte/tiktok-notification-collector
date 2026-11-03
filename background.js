'use strict';

/*
 * TikTok 1TK 通知采集 — background service worker
 *
 * 职责：
 *  - 每约 2 小时由 alarm 触发一轮采集（chrome.alarms，periodInMinutes = 120）
 *  - 找到已打开的 tiktok.com 标签页，把「开始采集」消息发给该页面的 content script
 *    —— 本扩展绝不自己打开任何标签页或窗口；没有 TikTok 标签页时本轮直接跳过
 *  - 接收 content script 回传的采集结果，组装 payload 后 POST 到用户配置的
 *    Apps Script webhook；发送失败时把 payload 存入 chrome.storage.local，
 *    下一轮开始时先重试补发（popup 会显示待补发条数）
 *  - 维护最近一轮的状态（时间 / 各分类条数 / 状态文字），供 popup 显示
 *
 * 存储结构（chrome.storage.local）：
 *  settings: { webhookUrl, token, paused, diagnostic }
 *  pending:  [ payload, ... ]            待补发的 payload 队列
 *  state:    { lastRunAt, lastStatus, lastCounts: {评论,赞,粉丝}, lastError }
 */

// Only the official deployed Apps Script web-app endpoint may receive data.
function isAllowedWebhookUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' && u.hostname === 'script.google.com' &&
      u.port === '' && u.username === '' && u.password === '' &&
      /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u.pathname) &&
      u.search === '' && u.hash === '';
  } catch (_) { return false; }
}

const ALARM_NAME = 'tiktok-1tk-capture';
const CAPTURE_PERIOD_MINUTES = 120;

const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

// Time-zone selection lives only in the extension. Send a ready-to-write local
// timestamp to Apps Script so the receiver has no time-zone setting to manage.
function formatCapturedAtForSheet(isoTimestamp, selectedTimeZone) {
  if (!isoTimestamp) return '';
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return String(isoTimestamp).slice(0, 40);
  let timeZone = String(selectedTimeZone || '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch (_) {
    timeZone = DEFAULT_TIME_ZONE;
  }
  if (!timeZone) timeZone = DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (key) => parts.find((part) => part.type === key).value;
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
    get('hour') + ':' + get('minute') + ':' + get('second');
}

// ---------- 存储小工具 ----------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign(
    { webhookUrl: '', token: '', paused: false, diagnostic: false, mode: '', sheetUrl: '', accountOverride: '', timeZone: 'Asia/Ho_Chi_Minh' },
    settings || {}
  );
  if (!s.mode) s.mode = s.paused ? 'off' : 'auto';
  return s;
}

async function setState(patch) {
  const { state } = await chrome.storage.local.get('state');
  const next = Object.assign({}, state || {}, patch);
  await chrome.storage.local.set({ state: next });
  return next;
}

async function getPending() {
  const { pending } = await chrome.storage.local.get('pending');
  return Array.isArray(pending) ? pending : [];
}

async function setPending(list) {
  await chrome.storage.local.set({ pending: list });
}

// ---------- 防重复：已成功发送条目的指纹记忆（按目标表分开记） ----------
// 指纹按「平台本身的唯一性」定：赞=人+视频（一个人对一条视频只能赞一次）、
// 关注=人（对一个账号只能关注一次）、评论=人+视频+内容（同人可多次评论，靠内容区分）。
const SENT_CAP = 6000;

function videoIdOf(u) {
  const s = String(u || '');
  const m = s.match(/video_id=(\d+)/) || s.match(/\/video\/(\d+)/);
  return m ? m[1] : '';
}

function itemKey(item) {
  const v = videoIdOf(item.postHref);
  const text = String(item.commentText || '').replace(/\s+/g, ' ').trim();
  if (item.category === '评论') return 'C|' + item.actorHref + '|' + v + '|' + text;
  if (item.category === '赞') return 'L|' + item.actorHref + '|' + v;
  if (item.category === '粉丝') return 'F|' + item.actorHref;
  return 'X|' + item.category + '|' + item.actorHref + '|' + v + '|' + text;
}

function targetKeyOf(src) {
  return (src.targetSpreadsheetId || 'default') + '#' + (src.targetSheetGid || '');
}

async function getSentMap() {
  const { sentMap } = await chrome.storage.local.get('sentMap');
  return (sentMap && typeof sentMap === 'object') ? sentMap : {};
}

async function markSent(payload) {
  try {
    const map = await getSentMap();
    const tk = targetKeyOf(payload);
    const arr = Array.isArray(map[tk]) ? map[tk] : [];
    const have = new Set(arr);
    for (const item of (payload.items || [])) {
      const k = itemKey(item);
      if (!have.has(k)) { have.add(k); arr.push(k); }
    }
    map[tk] = arr.slice(-SENT_CAP);
    await chrome.storage.local.set({ sentMap: map });
  } catch (e) { /* 记忆失败不阻塞发送 */ }
}

// ---------- 定时任务 ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1,
    periodInMinutes: CAPTURE_PERIOD_MINUTES,
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: CAPTURE_PERIOD_MINUTES,
        periodInMinutes: CAPTURE_PERIOD_MINUTES,
      });
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    startRun('auto');
  }
});

// ---------- 找 TikTok 标签页 ----------

async function findTikTokTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.tiktok.com/*' });
  if (!tabs || tabs.length === 0) return null;
  // 优先用当前窗口里激活的那个，其次任意一个
  const active = tabs.find((t) => t.active);
  return active || tabs[0];
}

// ---------- 发起一轮采集 ----------

let runInProgress = false;
let expectedCaptureTabId = null;

async function startRun(mode) {
  if (runInProgress) return;
  const settings = await getSettings();

  if (settings.mode === 'off') {
    await setState({ lastStatus: 'paused', lastRunAt: Date.now() });
    return;
  }
  if (mode === 'auto' && settings.mode !== 'auto') {
    return; // 手动模式下自动轮次直接跳过，不打扰用户
  }

  // 先尝试补发之前失败的 payload（不依赖 TikTok 标签页）
  await flushPending(settings);

  const tab = await findTikTokTab();
  if (!tab) {
    await setState({
      lastStatus: 'no-tab',
      lastRunAt: Date.now(),
      lastError: '未检测到 TikTok 首页',
    });
    return;
  }

  runInProgress = true;
  expectedCaptureTabId = tab.id;
  await setState({ lastStatus: 'running', lastRunAt: Date.now(), lastError: '' });
  broadcastRunState(tab.id, 'started', '');
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'RUN_CAPTURE',
      mode, // 'auto' | 'manual'
      diagnostic: settings.diagnostic,
    });
    // content script 受理后会立即回一个 ack；真正的 结果通过
    // CAPTURE_RESULT 消息异步回传（滚动读取需要几分钟，不能阻塞消息通道）
  } catch (err) {
    runInProgress = false;
    expectedCaptureTabId = null;
    await setState({
      lastStatus: 'error',
      lastError: '页面脚本未就绪，请刷新一下 TikTok 标签页后重试',
    });
  }
}

// 从 popup 里粘贴的表格链接解析目标（表格 ID + sheet gid）
function accountFromSettings(settings, detected) {
  const o = String((settings && settings.accountOverride) || '').trim().replace(/^@/, '');
  if (o) return { name: '', username: o, profileUrl: 'https://www.tiktok.com/@' + o };
  return detected || null;
}

function targetFromSettings(settings) {
  const s = String(settings.sheetUrl || '');
  const mid = s.match(/spreadsheets\/d\/([A-Za-z0-9-_]+)/);
  const mgid = s.match(/[#?&]gid=(\d+)/);
  return {
    targetSpreadsheetId: mid ? mid[1] : '',
    targetSheetGid: mgid ? mgid[1] : '',
  };
}

// ---------- 接收 content script 的结果 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'MANUAL_RUN') {
    if (sender.tab || sender.id !== chrome.runtime.id) return;
    startRun('manual');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'CAPTURE_RESULT') {
    const trustedTikTokTab = sender.id === chrome.runtime.id && sender.tab &&
      Number.isInteger(sender.tab.id) &&
      /^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//i.test(sender.url || '');
    const expectedRun = runInProgress && sender.tab && sender.tab.id === expectedCaptureTabId;
    const pageManualRun = !runInProgress && msg.mode === 'manual';
    if (!trustedTikTokTab || (!expectedRun && !pageManualRun)) {
      sendResponse({ ok: false, error: 'unexpected capture sender' });
      return;
    }
    runInProgress = false;
    expectedCaptureTabId = null;
    const tabId = sender && sender.tab ? sender.tab.id : null;
    handleCaptureResult(msg, tabId).then(() => sendResponse({ ok: true }));
    return true; // 异步回复
  }
});

// ---------- 页面按钮状态广播 + 系统通知（v0.6） ----------

function broadcastRunState(tabId, state, summary) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: 'RUN_STATE', state, summary }).catch(() => {});
}

function notifyUser(title, message) {
  try {
    chrome.notifications.create('tiktok-1tk-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icon.png',
      title,
      message,
    });
  } catch (e) { /* 通知失败不影响采集本身 */ }
}

async function handleCaptureResult(result, tabId) {
  const settings = await getSettings();

  if (result.status && result.status.indexOf('blocked') === 0) {
    await setState({
      lastStatus: 'blocked',
      lastRunAt: Date.now(),
      lastError: result.status,
    });
    broadcastRunState(tabId, 'error', result.status);
    notifyUser('TikTok 采集被拦截，已停止', result.status);
    return;
  }

  if (result.status && result.status.indexOf('skipped') === 0) {
    await setState({
      lastStatus: 'skipped',
      lastRunAt: Date.now(),
      lastError: '',
    });
    return;
  }

  if (result.status !== 'ok') {
    await setState({
      lastStatus: 'error',
      lastRunAt: Date.now(),
      lastError: result.status || 'unknown error',
    });
    broadcastRunState(tabId, 'error', result.status || 'unknown error');
    notifyUser('TikTok 采集未成功', result.status || 'unknown error');
    // 出错时也要把诊断快照发到表格——修选择器就靠它（v0.2 的教训：
    // 出错轮次的快照被直接丢弃，等于盲修）
    if (result.diagnosticHtml) {
      const payload = Object.assign({
        token: settings.token,
        batchId: result.batchId,
        capturedAt: result.capturedAt,
        displayCapturedAt: formatCapturedAtForSheet(result.capturedAt, settings.timeZone),
        source: 'chrome-extension',
        account: accountFromSettings(settings, result.account),
        kind: 'diagnostic',
        items: Array.isArray(result.items) ? result.items : [],
        diagnosticHtml: result.diagnosticHtml,
      }, targetFromSettings(settings));
      const pending = await getPending();
      pending.push(payload);
      await setPending(pending);
      await flushPending(settings);
    }
    return;
  }

  const rawItems = Array.isArray(result.items) ? result.items : [];
  const target = targetFromSettings(settings);
  // 防重复第一道关：本目标表已成功发送过的条目、以及本批内部重复的，不再发送
  const sentMap = await getSentMap();
  const sentSet = new Set(sentMap[targetKeyOf(target)] || []);
  const batchSeen = new Set();
  const items = [];
  let dupSkipped = 0;
  for (const item of rawItems) {
    const k = itemKey(item);
    if (sentSet.has(k) || batchSeen.has(k)) { dupSkipped += 1; continue; }
    batchSeen.add(k);
    items.push(item);
  }
  const counts = { '评论': 0, '赞': 0, '粉丝': 0 };
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(counts, item.category)) {
      counts[item.category] += 1;
    }
  }

  const payload = Object.assign({
    token: settings.token,
    batchId: result.batchId,
    capturedAt: result.capturedAt,
    displayCapturedAt: formatCapturedAtForSheet(result.capturedAt, settings.timeZone),
    source: 'chrome-extension',
    account: accountFromSettings(settings, result.account),
    items,
  }, target);
  if (result.diagnosticHtml) {
    payload.diagnosticHtml = result.diagnosticHtml;
  }

  // 入队后统一走补发逻辑（成功即出队）；本批没有新条目就不发空包
  let flushed;
  if (items.length === 0) {
    flushed = { ok: true, error: '' };
  } else {
    const pending = await getPending();
    pending.push(payload);
    await setPending(pending);
    flushed = await flushPending(settings);
  }
  const sent = flushed.ok;

  await setState({
    lastStatus: sent ? 'ok' : 'ok-unsent',
    lastRunAt: Date.now(),
    lastCounts: counts,
    lastError: sent ? '' : '已采集，但发送到表格失败，已暂存待补发。服务器原话：' + (flushed.error || '未知'),
  });
  const summary = '评论 ' + counts['评论'] + ' · 赞 ' + counts['赞'] + ' · 粉丝 ' + counts['粉丝'] +
    (typeof dupSkipped === 'number' && dupSkipped > 0 ? ' · 去重跳过 ' + dupSkipped : '');
  const modeLabel = result.mode === 'auto' ? '自动' : '手动';
  broadcastRunState(tabId, 'done', modeLabel + '采集完成：' + summary);
  notifyUser(
    (sent ? 'TikTok 互动采集完成（' : 'TikTok 已采集但发送失败（') + modeLabel + '）',
    sent ? summary + '，已发送到表格' : summary + '，已暂存，下一轮自动补发'
  );
}

// ---------- 发送 / 补发 ----------

async function flushPending(settings) {
  const url = (settings.webhookUrl || '').trim();
  if (!url || !isAllowedWebhookUrl(url)) {
    const pending = await getPending();
    return { ok: pending.length === 0, error: url ? '接收地址不合法：只允许 https://script.google.com/macros/s/部署ID/exec' : '未填接收地址' };
  }
  let pending = await getPending();
  if (pending.length === 0) return { ok: true, error: '' };

  const remaining = [];
  let lastErr = '';
  for (const payload of pending) {
    const body = Object.assign({}, payload, { token: settings.token });
    // Upgrade old queued batches (which only had capturedAt + timeZone) before
    // posting, without changing their stored original capture time.
    if (!body.displayCapturedAt) {
      body.displayCapturedAt = formatCapturedAtForSheet(
        body.capturedAt, body.timeZone || settings.timeZone
      );
    }
    // The receiver never needs to interpret a time zone.
    delete body.timeZone;
    const r = await postPayload(url, body);
    if (!r.ok) { remaining.push(payload); lastErr = r.error || lastErr; }
    else if (payload.kind !== 'diagnostic') { await markSent(payload); }
  }
  await setPending(remaining);
  return { ok: remaining.length === 0, error: lastErr };
}

async function postPayload(url, payload) {
  if (!isAllowedWebhookUrl(url)) return { ok: false, error: '接收地址不合法' };
  try {
    // Apps Script 的 doPost 读取 e.postData.contents；用 text/plain 避免
    // CORS 预检（Apps Script 不处理 OPTIONS），正文仍然是 JSON 字符串
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const data = await resp.json().catch(() => null);
    if (data && data.ok) return { ok: true, error: '' };
    // 把服务器的原话带出来（如 bad token / 具体异常），弹窗直接显示，不用再猜
    return { ok: false, error: (data && data.error) ? String(data.error) : '服务器返回了无法识别的内容' };
  } catch (err) {
    return { ok: false, error: '网络错误：' + String((err && err.message) || err) };
  }
}
