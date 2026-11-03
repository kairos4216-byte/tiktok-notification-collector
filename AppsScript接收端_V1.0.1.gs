/**
 * TikTok通知采集 — V1.0.1 接收端安全加固版
 * 与 Chrome 扩展 1.0.1 配套使用；Token 和表格白名单由脚本属性配置。
 * 修复：公式注入、跨批/重试重复入库、评论双写局部失败的补写。
 * 保留：账号工作表按 gid 定位、评论双写、第三行新数据置顶、插件负责时区。
 *
 * 【首次部署前必须配置】Google Apps Script -> 项目设置 -> 脚本属性：
 *   TOKEN                  您自己设置的随机长口令（必须与插件中的口令相同）
 *   DEFAULT_SPREADSHEET_ID 可选：插件没有指定表格时使用的 Google 表格 ID
 *   ALLOWED_SPREADSHEET_IDS 允许写入的表格 ID 列表（英文逗号分隔）
 *   默认表格 ID 自动视为允许目标；其他表格需明确列入白名单。
 * 不再在公开代码中包含真实 Token 或默认表格 ID。
 *
 * 默认拒绝任何未授权的目标表格；不会再允许请求任意指定可编辑的表格。
 */

const STAGING_SHEET_NAME = '原始采集';
const DIAG_SHEET_NAME = '诊断快照';
const COMMENT_SHEET_NAME = '评论收集';
const STAGING_HEADERS = ['采集时间', '分类', '账号', '互动者链接', '贴文链接', '评论内容（原文）'];
const COMMENT_HEADERS = ['采集时间', '账号', '互动者链接', '贴文链接', '评论内容（原文）', '评论中文翻译', '分类'];
const DIAG_HEADERS = ['采集时间', '采集批次', '匿名结构诊断'];
const MAX_REQUEST_CHARS = 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_DIAG_CHARS = 12000;

function readConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    token: String(props.getProperty('TOKEN') || ''),
    defaultSpreadsheetId: String(props.getProperty('DEFAULT_SPREADSHEET_ID') || '').trim(),
    allowedSpreadsheetIds: String(props.getProperty('ALLOWED_SPREADSHEET_IDS') || '')
  };
}

function asText(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Apps Script 的 Range.setValues() 会把以 = 开头的字符串当成公式。
 * 为保持原文可见且阻止执行，用单引号作为表格的文字转义前缀。
 * 这里仅处理公式触发符，不修改已经存储的历史行。
 */
function safeSheetText(value) {
  const text = asText(value);
  return text.charAt(0) === '=' ? "'" + text : text;
}

function normalizeSheetText(value) {
  const text = asText(value);
  return text.charAt(0) === "'" && text.charAt(1) === '=' ? text.slice(1) : text;
}

function capturedAt(data) {
  return asText(data.displayCapturedAt || data.capturedAt || '').slice(0, 40);
}

function ensureHeaders(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/** 新记录从第3行插入；全列设为文字；不覆盖历史行与人工翻译/分类。 */
function insertRowsAtThird(sheet, rows) {
  if (!rows.length) return;
  if (sheet.getMaxRows() < 3) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 3 - sheet.getMaxRows());
  }
  sheet.insertRowsBefore(3, rows.length);
  const range = sheet.getRange(3, 1, rows.length, rows[0].length);
  range.setNumberFormat('@');
  range.setValues(rows.map(function(row) { return row.map(safeSheetText); }));
}

function normalizeActor(value) {
  return asText(value).trim().replace(/\/$/, '');
}

function postIdentity(value) {
  const href = asText(value);
  // 对同一视频的不同链接形式使用一致的视频 ID。
  const videoId = href.match(/[?&]video_id=(\d+)/) || href.match(/\/video\/(\d+)/);
  return videoId ? 'video:' + videoId[1] : href.trim();
}

function commentIdentity(value) {
  const href = asText(value);
  const match = href.match(/[?&]comment_id=(\d+)/);
  return match ? match[1] : '';
}

/**
 * 仅在关键字段足以识别同一事件时去重，避免把信息不足的通知误删。
 * 同账号 + 同用户 + 同视频 + 同评论文本为保守的评论回退规则；
 * 有 comment_id 时优先使用它，支持相同内容的不同评论。
 */
function noticeKey(category, account, actor, post, comment) {
  category = normalizeSheetText(category).trim();
  account = normalizeSheetText(account).trim();
  actor = normalizeActor(normalizeSheetText(actor));
  post = normalizeSheetText(post);
  comment = normalizeSheetText(comment);
  // 账号未识别时不冒险跨账号去重，优先避免漏掉不同账号的数据。
  if (!account || account === '未知账号（待确认）' || !actor) return null;
  const base = JSON.stringify([account, actor]);
  if (category === '粉丝') return 'F|' + base;
  if (category === '赞') {
    const video = postIdentity(post);
    return video ? 'L|' + base + '|' + JSON.stringify(video) : null;
  }
  if (category === '评论') {
    const id = commentIdentity(post);
    if (id) return 'C-ID|' + base + '|' + id;
    const video = postIdentity(post);
    if (!video || !comment.trim()) return null;
    return 'C|' + base + '|' + JSON.stringify([video, comment.replace(/\s+/g, ' ').trim()]);
  }
  return null;
}

function keysFromAccountSheet(sheet) {
  const keys = new Set();
  const rowsCount = Math.max(0, sheet.getLastRow() - 2);
  if (!rowsCount) return keys;
  // B:F = 分类、账号、互动者、贴文、评论原文。
  const existing = sheet.getRange(3, 2, rowsCount, 5).getValues();
  existing.forEach(function(row) {
    const key = noticeKey(row[0], row[1], row[2], row[3], row[4]);
    if (key) keys.add(key);
  });
  return keys;
}

function keysFromCommentSheet(sheet) {
  const keys = new Set();
  const rowsCount = Math.max(0, sheet.getLastRow() - 2);
  if (!rowsCount) return keys;
  // B:E = 账号、互动者、贴文、评论原文。
  const existing = sheet.getRange(3, 2, rowsCount, 4).getValues();
  existing.forEach(function(row) {
    const key = noticeKey('评论', row[0], row[1], row[2], row[3]);
    if (key) keys.add(key);
  });
  return keys;
}

function existingDiagnosticBatchIds(sheet) {
  const ids = new Set();
  const count = Math.max(0, sheet.getLastRow() - 2);
  if (!count) return ids;
  sheet.getRange(3, 2, count, 1).getValues().forEach(function(row) {
    if (row[0]) ids.add(asText(row[0]));
  });
  return ids;
}

function isValidSpreadsheetId(value) {
  return /^[A-Za-z0-9_-]{20,}$/.test(asText(value));
}

function validateRequest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid payload');
  if (!Array.isArray(data.items) || data.items.length > MAX_ITEMS) throw new Error('invalid items');
  if (asText(data.diagnosticHtml).length > MAX_DIAG_CHARS) throw new Error('diagnostic too large');
  if (asText(data.batchId).length > 128) throw new Error('invalid batch id');
  if (asText(data.displayCapturedAt || data.capturedAt).length > 40) throw new Error('invalid time');
  const account = data.account && typeof data.account === 'object' ? data.account : {};
  if (!/^[A-Za-z0-9._]{0,60}$/.test(asText(account.username).replace(/^@/, ''))) throw new Error('invalid username');
  data.items.forEach(function(item) {
    if (!item || typeof item !== 'object' || !['评论', '赞', '粉丝'].includes(item.category)) throw new Error('invalid category');
    const actor = asText(item.actorHref);
    const post = asText(item.postHref);
    const comment = asText(item.commentText);
    if (actor.length > 1024 || post.length > 4096 || comment.length > 10000) throw new Error('field too large');
    if (actor && !/^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._]+\/?(?:[?#].*)?$/.test(actor)) throw new Error('invalid actor URL');
    if (post && !/^https:\/\/www\.tiktok\.com\//.test(post)) throw new Error('invalid post URL');
  });
}

function authorizedSpreadsheetIds(config) {
  const ids = asText(config.allowedSpreadsheetIds).split(/[,;\s]+/).filter(Boolean);
  if (config.defaultSpreadsheetId) ids.push(config.defaultSpreadsheetId);
  return new Set(ids.filter(isValidSpreadsheetId));
}

function resolveTargetSpreadsheet(data, config) {
  const targetId = asText(data.targetSpreadsheetId).trim();
  if (targetId && !isValidSpreadsheetId(targetId)) {
    throw new Error('invalid target spreadsheet ID');
  }
  const id = targetId || config.defaultSpreadsheetId;
  if (!id || !isValidSpreadsheetId(id)) {
    throw new Error('未配置目标表格：请在插件填写表格链接，或在脚本属性设置 DEFAULT_SPREADSHEET_ID');
  }
  if (!authorizedSpreadsheetIds(config).has(id)) throw new Error('target spreadsheet not allowlisted');
  return SpreadsheetApp.openById(id);
}

function resolveTargetSheet(ss, data) {
  if (data.targetSheetGid !== null && data.targetSheetGid !== undefined && data.targetSheetGid !== '') {
    const gid = Number(data.targetSheetGid);
    if (!Number.isSafeInteger(gid) || gid < 0) throw new Error('invalid sheet gid');
    const found = ss.getSheets().find(function(s) { return s.getSheetId() === gid; });
    if (!found) throw new Error('sheet gid not found');
    if ([COMMENT_SHEET_NAME, DIAG_SHEET_NAME].includes(found.getName())) throw new Error('reserved destination sheet');
    return found;
  }
  return ss.getSheetByName(STAGING_SHEET_NAME) || ss.insertSheet(STAGING_SHEET_NAME);
}

function doPost(e) {
  let lock = null;
  try {
    const config = readConfig();
    if (!config.token || config.token.length < 24) return jsonOut({ ok: false, error: '服务端 TOKEN 未配置或长度不足 24 字符' });
    if (!e || !e.postData || typeof e.postData.contents !== 'string' ||
        e.postData.contents.length > MAX_REQUEST_CHARS) return jsonOut({ ok: false, error: 'invalid request' });
    const data = JSON.parse(e.postData.contents);
    if (!data || typeof data !== 'object' || !data.token || data.token !== config.token) {
      return jsonOut({ ok: false, error: 'bad token' });
    }

    validateRequest(data);
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    const ss = resolveTargetSpreadsheet(data, config);
    const sheet = resolveTargetSheet(ss, data);
    ensureHeaders(sheet, STAGING_HEADERS);
    const dateText = capturedAt(data);
    const user = data.account && typeof data.account === 'object' ? asText(data.account.username).replace(/^@/, '').trim() : '';
    const accountLabel = user ? '@' + user : '未知账号（待确认）';
    const items = Array.isArray(data.items) ? data.items : [];

    // 不必额外新建隐藏表。比对现存账号工作表，覆盖旧版写入过的记录。
    const seenAccount = keysFromAccountSheet(sheet);
    const accountRows = [];
    items.forEach(function(item) {
      if (!item || typeof item !== 'object') return;
      const category = asText(item.category);
      const actor = asText(item.actorHref);
      const post = asText(item.postHref);
      const comment = asText(item.commentText);
      const key = noticeKey(category, accountLabel, actor, post, comment);
      if (key && seenAccount.has(key)) return;
      if (key) seenAccount.add(key);
      accountRows.push([dateText, category, accountLabel, actor, post, comment]);
    });
    insertRowsAtThird(sheet, accountRows);

    // 评论汇总单独检查，能补齐“账号表已写入、评论表尚未写入”的局部失败。
    const commentItems = items.filter(function(item) { return item && item.category === '评论'; });
    let commentRows = [];
    if (commentItems.length) {
      const csheet = ss.getSheetByName(COMMENT_SHEET_NAME) || ss.insertSheet(COMMENT_SHEET_NAME);
      ensureHeaders(csheet, COMMENT_HEADERS);
      const seenComments = keysFromCommentSheet(csheet);
      commentItems.forEach(function(item) {
        const actor = asText(item.actorHref);
        const post = asText(item.postHref);
        const comment = asText(item.commentText);
        const key = noticeKey('评论', accountLabel, actor, post, comment);
        if (key && seenComments.has(key)) return;
        if (key) seenComments.add(key);
        commentRows.push([dateText, accountLabel, actor, post, comment, '', '']);
      });
      insertRowsAtThird(csheet, commentRows);
    }

    let diagnosticWritten = 0;
    if (data.diagnosticHtml) {
      const diag = ss.getSheetByName(DIAG_SHEET_NAME) || ss.insertSheet(DIAG_SHEET_NAME);
      ensureHeaders(diag, DIAG_HEADERS);
      const batchId = asText(data.batchId);
      const alreadySaved = batchId && existingDiagnosticBatchIds(diag).has(batchId);
      if (!alreadySaved) {
        insertRowsAtThird(diag, [[dateText, batchId, asText(data.diagnosticHtml).slice(0, MAX_DIAG_CHARS)]]);
        diagnosticWritten = 1;
      }
    }
    SpreadsheetApp.flush();
    return jsonOut({
      ok: true,
      written: accountRows.length,
      comments: commentRows.length,
      duplicatesSkipped: Math.max(0, items.length - accountRows.length),
      diagnosticWritten: diagnosticWritten,
      spreadsheetId: ss.getId(),
      sheet: sheet.getName(),
    });
  } catch (err) {
    // 避免把工作表内部异常详情回传给任意知道 /exec 地址的人。
    console.error('TikTok接收端失败：' + asText(err && err.message).slice(0, 160));
    return jsonOut({ ok: false, error: '写入失败，请检查 Apps Script 执行日志、配置和表格权限' });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (_) {} }
  }
}

function doGet() {
  return jsonOut({ ok: true, info: 'TikTok 通知采集接收端 V1.0.1 安全加固版已部署，请通过插件 POST 数据。' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
