'use strict';

/* TikTok 1TK 通知采集 — popup
 * - 显示：TikTok 首页是否检测到、上次采集时间与各分类条数、待补发数
 * - 设置：接收地址（webhook URL）、口令（token）、诊断模式
 * - 按钮：立即采集、暂停/恢复
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

const $ = (id) => document.getElementById(id);
const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const TIME_ZONE_OPTIONS = new Set([
  'Asia/Ho_Chi_Minh', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Europe/Madrid', 'Europe/Lisbon', 'America/New_York', 'UTC',
]);

function isValidTimeZone(value) {
  if (!value || typeof value !== 'string' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch (_) { return false; }
}

function showTimeZoneSettings(settings) {
  const zone = isValidTimeZone(settings.timeZone) ? settings.timeZone : DEFAULT_TIME_ZONE;
  const custom = !TIME_ZONE_OPTIONS.has(zone);
  $('timeZoneChoice').value = custom ? 'custom' : zone;
  $('customTimeZone').style.display = custom ? '' : 'none';
  if (document.activeElement !== $('customTimeZone')) {
    $('customTimeZone').value = custom ? zone : '';
  }
  $('timeZoneHint').textContent = '当前时区：' + zone + '。新采集记录在 Google 表格里显示为 YYYY-MM-DD HH:mm:ss。';
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign(
    { webhookUrl: '', token: '', paused: false, diagnostic: false, mode: '', sheetUrl: '', accountOverride: '', showPageButton: true, timeZone: DEFAULT_TIME_ZONE },
    settings || {}
  );
  if (!s.mode) s.mode = s.paused ? 'off' : 'auto';
  return s;
}

async function saveSettings(patch) {
  const current = await loadSettings();
  const next = Object.assign({}, current, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

function parseSheetUrl(url) {
  if (!String(url || '').trim()) return { spreadsheetId: '', sheetGid: '', valid: false };
  try {
    const u = new URL(String(url).trim());
    const match = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/);
    const gid = (u.hash + '&' + u.search).match(/[#?&]gid=(\d+)/);
    if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !match) throw new Error();
    return { spreadsheetId: match[1], sheetGid: gid ? gid[1] : '', valid: true };
  } catch (_) { return { spreadsheetId: '', sheetGid: '', valid: false }; }
}

function fmtTime(ts, timeZone) {
  if (!ts) return '暂无';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '未知时间';
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const field = (key) => parts.find((p) => p.type === key).value;
  return field('year') + '-' + field('month') + '-' + field('day') +
    ' ' + field('hour') + ':' + field('minute') + ':' + field('second');
}

async function refresh() {
  const settings = await loadSettings();
  const { state, pending } = await chrome.storage.local.get(['state', 'pending']);

  // TikTok 标签页检测
  const tabs = await chrome.tabs.query({ url: 'https://www.tiktok.com/*' });
  const tabStatus = $('tabStatus');
  if (tabs && tabs.length > 0) {
    tabStatus.textContent = '已检测到 TikTok 首页';
    tabStatus.className = 'status ok';
  } else {
    tabStatus.textContent = '未检测到 TikTok 首页';
    tabStatus.className = 'status warn';
  }

  // 上次采集
  const st = state || {};
  const lastRun = $('lastRun');
  if (st.lastRunAt) {
    let text = '上次采集：' + fmtTime(st.lastRunAt, settings.timeZone);
    if (st.lastCounts) {
      const c = st.lastCounts;
      text += '（评论 ' + (c['评论'] || 0) + '、赞 ' + (c['赞'] || 0) +
              '、粉丝 ' + (c['粉丝'] || 0) + '）';
    }
    const statusText = {
      ok: '发送成功',
      'ok-unsent': '已采集，待补发',
      running: '正在采集…',
      blocked: '被验证/登录拦截，已停止',
      'no-tab': '没有打开 TikTok 首页，已跳过',
      paused: '已暂停',
      skipped: '页面有人在用，已跳过本轮',
      error: '出错',
    }[st.lastStatus] || st.lastStatus || '';
    if (statusText) text += ' · ' + statusText;
    lastRun.textContent = text;
  } else {
    lastRun.textContent = '上次采集：暂无';
  }

  // 错误行
  const errorRow = $('errorRow');
  if (st.lastError) {
    errorRow.style.display = '';
    errorRow.textContent = st.lastError;
    errorRow.className = 'row err';
  } else {
    errorRow.style.display = 'none';
  }

  // 待补发
  const pendingList = Array.isArray(pending) ? pending : [];
  const totalItems = pendingList.reduce(
    (sum, p) => sum + (Array.isArray(p.items) ? p.items.length : 0), 0
  );
  $('pendingRow').textContent =
    '待补发：' + pendingList.length + ' 批（' + totalItems + ' 条）';

  // 设置回填（不覆盖正在输入的内容：仅在与存储不一致且未聚焦时回填）
  if (document.activeElement !== $('webhookUrl')) {
    $('webhookUrl').value = settings.webhookUrl || '';
  }
  if (document.activeElement !== $('token')) {
    $('token').value = settings.token || '';
  }
  $('diagnostic').checked = !!settings.diagnostic;
  $('showPageButton').checked = settings.showPageButton !== false;
  if (document.activeElement !== $('timeZoneChoice') && document.activeElement !== $('customTimeZone')) {
    showTimeZoneSettings(settings);
  }
  if (document.activeElement !== $('accountOverride')) {
    $('accountOverride').value = settings.accountOverride || '';
  }
  if (document.activeElement !== $('sheetUrl')) {
    $('sheetUrl').value = settings.sheetUrl || '';
  }
  const hint = $('sheetHint');
  const parsed = parseSheetUrl(settings.sheetUrl);
  if (!settings.sheetUrl) {
    hint.textContent = '未填：写入接收脚本内置的默认表格';
  } else if (parsed.valid) {
    hint.textContent = '将写入：表格 ' + parsed.spreadsheetId.slice(0, 10) + '…' +
      (parsed.sheetGid ? ' · sheet gid ' + parsed.sheetGid : ' · 未带 gid（按 sheet 名定位）');
  } else {
    hint.textContent = '链接无法解析：请粘贴完整的表格链接（docs.google.com/spreadsheets/d/…）';
    hint.className = 'row err';
  }

  // 运行模式显示
  const mode = settings.mode || 'auto';
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === mode;
  });
  const modeStatus = $('modeStatus');
  const modeHint = $('modeHint');
  if (mode === 'auto') {
    modeStatus.textContent = '自动（约每 2 小时）';
    modeStatus.className = 'status ok';
    modeHint.textContent = '自动模式：到点自己采集，你开着首页离开就行；也可以随时手动点采集。';
  } else if (mode === 'manual') {
    modeStatus.textContent = '手动（点按钮才采集）';
    modeStatus.className = 'status warn';
    modeHint.textContent = '手动模式：不会自动跑。想让它自己跑，切到「自动」。';
  } else {
    modeStatus.textContent = '暂停（不采集）';
    modeStatus.className = 'status err';
    modeHint.textContent = '暂停模式：自动和手动都不跑。';
  }
  $('runNow').disabled = mode === 'off';
  chrome.alarms.get('tiktok-1tk-capture', (alarm) => {
    const el = $('nextAuto');
    if (!el) return;
    if (mode === 'auto' && alarm && alarm.scheduledTime) {
      el.textContent = '下一次自动采集：约 ' + fmtTime(alarm.scheduledTime, settings.timeZone);
    } else {
      el.textContent = '';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  refresh();
  // popup 开着时状态可能变化（采集完成/补发），轻量轮询刷新
  setInterval(refresh, 2000);

  $('webhookUrl').addEventListener('input', (e) => e.target.setCustomValidity(''));
  $('webhookUrl').addEventListener('change', (e) => {
    const value = e.target.value.trim();
    if (value && !isAllowedWebhookUrl(value)) {
      e.target.setCustomValidity('只允许 https://script.google.com/macros/s/部署ID/exec');
      e.target.reportValidity();
      return;
    }
    e.target.setCustomValidity('');
    saveSettings({ webhookUrl: value });
  });
  // Only toggle the presentation; do not modify or re-save the token.
  $('toggleToken').addEventListener('click', () => {
    const tokenInput = $('token');
    const showing = tokenInput.type === 'password';
    tokenInput.type = showing ? 'text' : 'password';
    $('toggleToken').textContent = showing ? '隐藏' : '显示';
    $('toggleToken').setAttribute('aria-pressed', String(showing));
    $('toggleToken').setAttribute('aria-label', showing ? '隐藏口令' : '显示口令');
  });
  $('token').addEventListener('change', (e) => {
    saveSettings({ token: e.target.value.trim() });
  });
  $('showPageButton').addEventListener('change', (e) => {
    saveSettings({ showPageButton: e.target.checked });
  });
  $('diagnostic').addEventListener('change', (e) => {
    saveSettings({ diagnostic: e.target.checked });
  });
  $('timeZoneChoice').addEventListener('change', async (e) => {
    if (e.target.value === 'custom') {
      $('customTimeZone').style.display = '';
      $('customTimeZone').focus();
      $('timeZoneHint').textContent = '请输入有效的 IANA 时区名称，例如 Asia/Bangkok；保存后对新采集记录生效。';
      return;
    }
    $('customTimeZone').style.display = 'none';
    const zone = e.target.value;
    if (!isValidTimeZone(zone)) return;
    await saveSettings({ timeZone: zone });
    $('timeZoneHint').textContent = '当前时区：' + zone + '。新采集记录在 Google 表格里显示为 YYYY-MM-DD HH:mm:ss。';
  });
  $('customTimeZone').addEventListener('input', (e) => e.target.setCustomValidity(''));
  $('customTimeZone').addEventListener('change', async (e) => {
    const zone = e.target.value.trim();
    if (!isValidTimeZone(zone)) {
      e.target.setCustomValidity('请输入有效的 IANA 时区，例如 Asia/Bangkok');
      e.target.reportValidity();
      return;
    }
    e.target.setCustomValidity('');
    await saveSettings({ timeZone: zone });
    $('timeZoneHint').textContent = '当前时区：' + zone + '。新采集记录在 Google 表格里显示为 YYYY-MM-DD HH:mm:ss。';
  });
  $('sheetUrl').addEventListener('change', (e) => {
    saveSettings({ sheetUrl: e.target.value.trim() }).then(refresh);
  });
  $('accountOverride').addEventListener('change', (e) => {
    saveSettings({ accountOverride: e.target.value.trim().replace(/^@/, '') });
  });

  $('runNow').addEventListener('click', async () => {
    if ($('timeZoneChoice').value === 'custom') {
      const input = $('customTimeZone');
      const zone = input.value.trim();
      if (!isValidTimeZone(zone)) {
        input.setCustomValidity('请输入有效的 IANA 时区，例如 Asia/Bangkok');
        input.reportValidity();
        return;
      }
      await saveSettings({ timeZone: zone });
    }
    const webhook = $('webhookUrl');
    if (!isAllowedWebhookUrl(webhook.value)) {
      webhook.setCustomValidity('请填写有效的 Google Apps Script /exec 地址');
      webhook.reportValidity();
      return;
    }
    webhook.setCustomValidity('');
    if ($('sheetUrl').value.trim() && !parseSheetUrl($('sheetUrl').value).valid) {
      $('sheetHint').textContent = '目标表格链接不合法，请粘贴 https://docs.google.com/spreadsheets/d/...';
      $('sheetHint').className = 'row err';
      return;
    }
    await saveSettings({
      webhookUrl: $('webhookUrl').value.trim(),
      token: $('token').value.trim(),
      diagnostic: $('diagnostic').checked,
      sheetUrl: $('sheetUrl').value.trim(),
      accountOverride: $('accountOverride').value.trim().replace(/^@/, ''),
    });
    chrome.runtime.sendMessage({ type: 'MANUAL_RUN' });
    $('lastRun').textContent = '已发出采集指令，页面空闲时会马上开始…';
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      await saveSettings({ mode: r.value, paused: r.value === 'off' });
      refresh();
    });
  });
});
