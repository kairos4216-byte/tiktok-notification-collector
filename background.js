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
const WATCHDOG_ALARM = 'tiktok-1tk-watchdog';
const MAX_PENDING_BATCHES = 100;
const MAX_PENDING_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_ITEMS = 2000;

// Restrict secret-bearing settings/pending queue to extension pages and service worker.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch((err) => console.error('无法限制扩展本地存储访问权限', err));
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
  return Array.isArray(pending) ? pending.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const { token, ...clean } = item;
    return clean;
  }).filter(Boolean) : [];
}

async function setPending(list) {
  await chrome.storage.local.set({ pending: list.map((item) => {
    const { token, ...safe } = item;
    return safe;
  }) });
}

// Pending writes and retries share one queue lock so flush cannot overwrite a newly queued batch.
let pendingMutex = Promise.resolve();
async function withPendingMutex(task) {
  const previous = pendingMutex;
  let release;
  pendingMutex = new Promise((resolve) => { release = resolve; });
  await previous;
  try { return await task(); } finally { release(); }
}
function pendingBytes(pending) { return JSON.stringify(pending).length * 2; }
async function enqueuePending(payload) {
  return withPendingMutex(async () => {
    const pending = await getPending();
    const { token, ...clean } = payload;
    const next = [...pending, clean];
    if (next.length > MAX_PENDING_BATCHES || pendingBytes(next) > MAX_PENDING_BYTES) {
      return { ok: false, error: '待补发队列容量已满；未存入新批次。请检查接收端并重新采集。' };
    }
    await setPending(next);
    return { ok: true };
  });
}

function isTrustedTikTokSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab ||
      !Number.isInteger(sender.tab.id) || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const url = new URL(sender.url || '');
    return url.protocol === 'https:' && url.hostname === 'www.tiktok.com';
  } catch (_) { return false; }
}
function getPublicUiSettings(settings) {
  return { showPageButton: settings.showPageButton !== false, mode: settings.mode || 'auto',
    accountOverride: settings.accountOverride || '' };
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
  const commentId = String(item.postHref || '').match(/[?&]comment_id=(\d+)/);
  const text = String(item.commentText || '').replace(/\s+/g, ' ').trim();
  if (item.category === '评论') return commentId ? 'C-ID|' + item.actorHref + '|' + commentId[1] : 'C|' + item.actorHref + '|' + v + '|' + text;
  if (item.category === '赞') return 'L|' + item.actorHref + '|' + v;
  if (item.category === '粉丝') return 'F|' + item.actorHref;
  return 'X|' + item.category + '|' + item.actorHref + '|' + v + '|' + text;
}

function targetKeyOf(src) {
  return (src.targetSpreadsheetId || 'default') + '#' + (src.targetSheetGid ?? '') + '#' +
    String(src.account?.username || '').toLowerCase();
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
    // Cap cache footprint (not the pending queue). Server-side dedup remains authoritative.
    delete map[tk];
    map[tk] = arr.slice(-SENT_CAP);
    let keys = Object.keys(map);
    while (keys.length > 15 || JSON.stringify(map).length * 2 > 3 * 1024 * 1024) {
      const oldest = keys[0];
      if (keys.length === 1) map[oldest] = map[oldest].slice(Math.floor(map[oldest].length / 2));
      else delete map[oldest];
      keys = Object.keys(map);
    }
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
  if (alarm.name === ALARM_NAME) startRun('auto');
  if (alarm.name === WATCHDOG_ALARM) {
    chrome.storage.local.get('captureTask').then(async ({ captureTask }) => {
      if (captureTask && Date.now() - captureTask.startedAt >= 9 * 60 * 1000) {
        await chrome.storage.local.remove('captureTask');
        runInProgress = false; expectedCaptureTabId = null; expectedRunId = null;
        await setState({ lastStatus: 'error', lastError: '采集任务超时，请刷新 TikTok 页面后重新采集' });
      }
    }).catch(console.error);
  }
});

// ---------- 找 TikTok 标签页 ----------

async function findTikTokTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
  if (!tabs || tabs.length === 0) return null;
  // 优先用当前窗口里激活的那个，其次任意一个
  const active = tabs.find((t) => t.active);
  return active || tabs[0];
}

// ---------- 发起一轮采集 ----------

let runInProgress = false;
let expectedCaptureTabId = null;
let expectedRunId = null;

async function startRun(mode, forcedTabId) {
  if (runInProgress) return { ok: false, error: '已有采集任务正在运行' };
  const settings = await getSettings();
  if (settings.mode === 'off') {
    await setState({ lastStatus: 'paused', lastRunAt: Date.now() });
    return { ok: false, error: '采集已暂停' };
  }
  if (mode === 'auto' && settings.mode !== 'auto') return { ok: false, error: '未启用自动模式' };
  const { captureTask } = await chrome.storage.local.get('captureTask');
  if (captureTask && Date.now() - captureTask.startedAt < 10 * 60 * 1000) {
    return { ok: false, error: '已有采集任务正在运行' };
  }
  runInProgress = true;
  try {
    await flushPending(settings);
    const pending = await getPending();
    if (pending.length >= MAX_PENDING_BATCHES || pendingBytes(pending) >= MAX_PENDING_BYTES) {
      await setState({ lastStatus: 'error', lastError: '待补发队列已满，请先处理发送失败的数据' });
      return { ok: false, error: '待补发队列已满' };
    }
    const tab = forcedTabId !== undefined ? await chrome.tabs.get(forcedTabId) : await findTikTokTab();
    if (!tab || !/^https:\/\/www\.tiktok\.com\//.test(tab.url || '')) {
      await setState({ lastStatus: 'no-tab', lastRunAt: Date.now(), lastError: '未检测到 TikTok 首页' });
      return { ok: false, error: '没有已打开的 TikTok 页面' };
    }
    const runId = crypto.randomUUID();
    expectedCaptureTabId = tab.id;
    expectedRunId = runId;
    await chrome.storage.local.set({ captureTask: { tabId: tab.id, runId, startedAt: Date.now() } });
    await setState({ lastStatus: 'running', lastRunAt: Date.now(), lastError: '' });
    broadcastRunState(tab.id, 'started', '');
    await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: 10 });
    await chrome.tabs.sendMessage(tab.id, { type: 'RUN_CAPTURE', runId, mode, diagnostic: settings.diagnostic });
    return { ok: true };
  } catch (_) {
    expectedCaptureTabId = null;
    expectedRunId = null;
    await chrome.storage.local.remove('captureTask');
    await chrome.alarms.clear(WATCHDOG_ALARM);
    await setState({ lastStatus: 'error', lastError: '页面脚本未就绪，请刷新 TikTok 标签页后重试' });
    return { ok: false, error: '页面脚本未就绪' };
  } finally {
    // The active task remains durable in chrome.storage.local until CAPTURE_RESULT.
    runInProgress = false;
  }
}

// 从 popup 里粘贴的表格链接解析目标（表格 ID + sheet gid）
function accountFromSettings(settings, detected) {
  const o = String((settings && settings.accountOverride) || '').trim().replace(/^@/, '');
  if (o) return { name: '', username: o, profileUrl: 'https://www.tiktok.com/@' + o };
  return detected || null;
}

function targetFromSettings(settings) {
  const raw = String(settings.sheetUrl || '').trim();
  if (!raw) return { targetSpreadsheetId: '', targetSheetGid: '' };
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/);
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !match) {
      throw new Error('invalid spreadsheet URL');
    }
    const gidMatch = (url.hash + '&' + url.search).match(/(?:[#?&])gid=(\d+)/);
    return { targetSpreadsheetId: match[1], targetSheetGid: gidMatch ? gidMatch[1] : '' };
  } catch (_) { throw new Error('目标表格链接无效，请使用 docs.google.com 的完整表格网址'); }
}

// ---------- Trusted message routing: only content script on top-level TikTok tab ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'MANUAL_RUN') {
    if (sender.tab || sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('popup.html')) return;
    startRun('manual').then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'GET_UI_SETTINGS') {
    if (!isTrustedTikTokSender(sender)) return;
    getSettings().then((settings) => sendResponse({ ok: true, settings: getPublicUiSettings(settings) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'HIDE_PAGE_BUTTON') {
    if (!isTrustedTikTokSender(sender)) return;
    getSettings().then(async (settings) => {
      await chrome.storage.local.set({ settings: { ...settings, showPageButton: false } });
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'PAGE_MANUAL_RUN') {
    if (!isTrustedTikTokSender(sender)) return;
    startRun('manual', sender.tab.id).then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: '启动失败' }));
    return true;
  }

  if (msg.type === 'CAPTURE_RESULT') {
    if (!isTrustedTikTokSender(sender)) return;
    (async () => {
      const { captureTask } = await chrome.storage.local.get('captureTask');
      if (!captureTask || captureTask.tabId !== sender.tab.id || msg.runId !== captureTask.runId ||
          Date.now() - captureTask.startedAt > 10 * 60 * 1000) {
        sendResponse({ ok: false, error: 'unexpected capture result' });
        return;
      }
      // Claim the task before processing; a second result for the same run cannot be accepted.
      await chrome.storage.local.remove('captureTask');
      await chrome.alarms.clear(WATCHDOG_ALARM);
      expectedCaptureTabId = null; expectedRunId = null;
      try { await handleCaptureResult(msg, sender.tab.id); sendResponse({ ok: true }); }
      catch (err) {
        await setState({ lastStatus: 'error', lastError: '处理采集结果失败，请查看扩展控制台' });
        broadcastRunState(sender.tab.id, 'error', '处理采集结果失败');
        sendResponse({ ok: false });
      }
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// Send only nonsecret settings to trusted TikTok content scripts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  chrome.tabs.query({ url: 'https://www.tiktok.com/*' }).then((tabs) => {
    tabs.forEach((tab) => chrome.tabs.sendMessage(tab.id, { type: 'UI_SETTINGS_CHANGED' }).catch(() => {}));
  }).catch(() => {});
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

function sanitizedItems(items) {
  if (!Array.isArray(items) || items.length > MAX_BATCH_ITEMS) throw new Error('采集条目数量超过安全上限');
  return items.map((item) => ({
    category: String(item.category || '').slice(0, 8),
    actorHref: String(item.actorHref || '').slice(0, 1024),
    postHref: String(item.postHref || '').slice(0, 4096),
    commentText: String(item.commentText || '').slice(0, 10000),
  }));
}
function safeDiagnostic(value) {
  if (!value) return '';
  const s = String(value);
  // Legacy queue snapshots contained raw HTML; do not transmit those after upgrade.
  return s.trimStart().startsWith('<') || /<\/?(?:div|span|a|!--LIST)/i.test(s)
    ? JSON.stringify({ notice: '已移除旧版含私人页面内容的HTML诊断快照' })
    : s.slice(0, 12000);
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
    broadcastRunState(tabId, 'done', '本轮自动采集跳过：页面正在使用');
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
        batchId: result.batchId,
        capturedAt: result.capturedAt,
        displayCapturedAt: formatCapturedAtForSheet(result.capturedAt, settings.timeZone),
        source: 'chrome-extension',
        account: accountFromSettings(settings, result.account),
        kind: 'diagnostic',
        items: sanitizedItems(result.items || []),
        diagnosticHtml: safeDiagnostic(result.diagnosticHtml),
      }, targetFromSettings(settings));
      const queued = await enqueuePending(payload);
      if (queued.ok) await flushPending(settings);
      else await setState({ lastStatus: 'error', lastError: queued.error });
    }
    return;
  }

  const rawItems = sanitizedItems(result.items || []);
  const target = targetFromSettings(settings);
  // 防重复第一道关：本目标表已成功发送过的条目、以及本批内部重复的，不再发送
  const sentMap = await getSentMap();
  const account = accountFromSettings(settings, result.account);
  const sentSet = new Set(sentMap[targetKeyOf({ ...target, account })] || []);
  const batchSeen = new Set();
  const items = [];
  let dupSkipped = 0;
  for (const item of rawItems) {
    const k = item.actorHref && (item.category === '粉丝' || (videoIdOf(item.postHref) &&
      (item.category === '赞' || item.commentText || /[?&]comment_id=\d+/.test(item.postHref)))) ? itemKey(item) : null;
    if (k && (sentSet.has(k) || batchSeen.has(k))) { dupSkipped += 1; continue; }
    if (k) batchSeen.add(k);
    items.push(item);
  }
  const counts = { '评论': 0, '赞': 0, '粉丝': 0 };
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(counts, item.category)) {
      counts[item.category] += 1;
    }
  }

  const payload = Object.assign({
    batchId: result.batchId,
    capturedAt: result.capturedAt,
    displayCapturedAt: formatCapturedAtForSheet(result.capturedAt, settings.timeZone),
    source: 'chrome-extension',
    account,
    items,
  }, target);
  if (result.diagnosticHtml) {
    payload.diagnosticHtml = safeDiagnostic(result.diagnosticHtml);
  }

  // 入队后统一走补发逻辑（成功即出队）；本批没有新条目就不发空包
  let flushed;
  if (items.length === 0) {
    flushed = { ok: true, error: '' };
  } else {
    const queued = await enqueuePending(payload);
    flushed = queued.ok ? await flushPending(settings) : queued;
  }
  const sent = flushed.ok;
  const unsaved = !flushed.ok && String(flushed.error || '').includes('未存入新批次');

  await setState({
    lastStatus: sent ? 'ok' : (unsaved ? 'error' : 'ok-unsent'),
    lastRunAt: Date.now(),
    lastCounts: counts,
    lastError: sent ? '' : unsaved ? flushed.error : '已采集，但发送到表格失败，已暂存待补发。服务器原话：' + (flushed.error || '未知'),
  });
  const summary = '评论 ' + counts['评论'] + ' · 赞 ' + counts['赞'] + ' · 粉丝 ' + counts['粉丝'] +
    (typeof dupSkipped === 'number' && dupSkipped > 0 ? ' · 去重跳过 ' + dupSkipped : '');
  const modeLabel = result.mode === 'auto' ? '自动' : '手动';
  broadcastRunState(tabId, sent ? 'done' : 'error', modeLabel + (sent ? '发送成功：' : '发送未成功：') + summary +
    (unsaved ? ' · 队列已满，本批未保存' : sent ? '' : ' · 已保存待补发')); 
  notifyUser(
    (sent ? 'TikTok 互动采集完成（' : 'TikTok 已采集但发送失败（') + modeLabel + '）',
    sent ? summary + '，已发送到表格' : unsaved ? summary + '，队列已满，本批未保存，请尽快处理' : summary + '，已暂存，下一轮自动补发'
  );
}

// ---------- 发送 / 补发 ----------

async function flushPending(settings) {
  return withPendingMutex(async () => {
    const url = (settings.webhookUrl || '').trim();
    if (!url || !isAllowedWebhookUrl(url)) {
      const pending = await getPending();
      return { ok: pending.length === 0, error: url ? '接收地址无效：仅允许官方 Apps Script /exec' : '未填接收地址' };
    }
    const pending = await getPending();
    if (!pending.length) return { ok: true, error: '' };
    const remaining = [];
    let lastErr = '';
    for (const payload of pending) {
      const body = Object.assign({}, payload, { token: settings.token });
      if (!body.displayCapturedAt) body.displayCapturedAt = formatCapturedAtForSheet(body.capturedAt, body.timeZone || settings.timeZone);
      delete body.timeZone;
      if (body.diagnosticHtml) body.diagnosticHtml = safeDiagnostic(body.diagnosticHtml);
      body.items = sanitizedItems(body.items || []);
      const result = await postPayload(url, body);
      if (!result.ok) { remaining.push(payload); lastErr = result.error || lastErr; }
      else if (payload.kind !== 'diagnostic') await markSent(payload);
    }
    await setPending(remaining);
    return { ok: remaining.length === 0, error: lastErr };
  });
}

async function postPayload(url, payload) {
  if (!isAllowedWebhookUrl(url)) return { ok: false, error: '接收地址不合法' };
  try {
    // Apps Script 的 doPost 读取 e.postData.contents；用 text/plain 避免
    // CORS 预检（Apps Script 不处理 OPTIONS），正文仍然是 JSON 字符串
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const data = await resp.json().catch(() => null);
    if (data && data.ok) return { ok: true, error: '' };
    // 把服务器的原话带出来（如 bad token / 具体异常），弹窗直接显示，不用再猜
    return { ok: false, error: (data && data.error) ? String(data.error) : '服务器返回了无法识别的内容' };
  } catch (err) {
    return { ok: false, error: '网络错误：' + String((err && err.message) || err) };
  }
}
