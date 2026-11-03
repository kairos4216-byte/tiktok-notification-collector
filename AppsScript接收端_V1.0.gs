/**
 * TikTok 通知采集 —— Google Apps Script 接收端 V1.0（沿用 v8 数据写入逻辑）
 * 2026-11-03：每批新数据插入第 3 行，已有第 3 行及以下的数据整体向下移动。
 * 写入时区只在 Chrome 插件内设置；脚本直接写入插件发送的显示时间。
 * 第 1、2 行保持原样。
 *
 * 部署：将本文件粘贴至原 Apps Script 项目，并把 TOKEN 替换为原口令；
 * 「部署」>「管理部署」> 编辑现有部署 > 选「新版本」>「部署」。
 * 使用原有部署时 /exec URL 不变，Chrome 插件不用重新填。
 *
 * 安全提示：不要把含真实 TOKEN 的 Apps Script 源码上传到公开仓库。
 */

// 请填入接收端与 Chrome 扩展设置中一致的口令。
const TOKEN = 'REPLACE_WITH_YOUR_TOKEN';

// 插件没指定目标表格时，使用当前默认表格。
const DEFAULT_SPREADSHEET_ID = '1zDe4cChaseELhd1m63XKpNx6S0JTKvd0LMjZFDd43N8';
const STAGING_SHEET_NAME = '原始采集';
const DIAG_SHEET_NAME = '诊断快照';
const COMMENT_SHEET_NAME = '评论收集';

const STAGING_HEADERS = ['采集时间', '分类', '账号', '互动者链接', '贴文链接', '评论内容（原文）'];
const COMMENT_HEADERS = ['采集时间', '账号', '互动者链接', '贴文链接', '评论内容（原文）', '评论中文翻译', '分类'];
const DIAG_HEADERS = ['采集时间', '采集批次', '面板HTML快照'];
// 此接收端不设置时区：插件发送 displayCapturedAt（已转换好的本地时间）。
// 为兼容尚未升级的发送端，缺少 displayCapturedAt 时原样保留 UTC 时间戳。
function getCapturedAtForSheet(data) {
  return String(data.displayCapturedAt || data.capturedAt || '').slice(0, 40);
}

/** 仅当整个 sheet 没有内容时，在第一行建立表头，第二行保留不动。 */
function ensureHeaders(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

/**
 * 新数据始终写在第 3 行起：一次插入与本批数据行数相同的空白行，
 * 原有第 3 行及其以下的内容、人工回填的翻译/分类随整行下移。
 * 第 1 行表头、第 2 行留空/备注均不受影响。
 * 由 doPost 的脚本锁保护，避免同时到达的请求交叉插行。
 */
function insertRowsAtThird(sheet, rows) {
  if (!rows.length) return;
  // 兼容人为将空白工作表删除到不足 3 行的情况。
  if (sheet.getMaxRows() < 3) {
    sheet.insertRowsAfter(sheet.getMaxRows(), 3 - sheet.getMaxRows());
  }
  sheet.insertRowsBefore(3, rows.length);
  // 明确设为文本，阻止 Google 表格按自身时区再次解释采集时间。
  sheet.getRange(3, 1, rows.length, 1).setNumberFormat('@');
  sheet.getRange(3, 1, rows.length, rows[0].length).setValues(rows);
}

function doPost(e) {
  let lock = null;
  try {
    const data = JSON.parse(e.postData.contents);
    if (!data || data.token !== TOKEN) {
      return jsonOut({ ok: false, error: 'bad token' });
    }

    // 防止不同采集批次同时插入并覆盖行；锁住整次写入。
    lock = LockService.getScriptLock();
    lock.waitLock(30000);

    // 插件指定表格优先；否则使用内置默认表格。
    const targetId = String(data.targetSpreadsheetId || '').trim();
    const ss = (targetId && /^[A-Za-z0-9-_]{20,}$/.test(targetId))
      ? SpreadsheetApp.openById(targetId)
      : SpreadsheetApp.openById(DEFAULT_SPREADSHEET_ID);

    // 目标 sheet 首先按 gid 定位，找不到再使用默认名字。
    let sheet = null;
    if (data.targetSheetGid !== null && data.targetSheetGid !== undefined && data.targetSheetGid !== '') {
      const gid = Number(data.targetSheetGid);
      const all = ss.getSheets();
      for (let i = 0; i < all.length; i++) {
        if (all[i].getSheetId() === gid) { sheet = all[i]; break; }
      }
    }
    if (!sheet) {
      sheet = ss.getSheetByName(STAGING_SHEET_NAME);
      if (!sheet) sheet = ss.insertSheet(STAGING_SHEET_NAME);
    }
    ensureHeaders(sheet, STAGING_HEADERS);

    // 同一批次的三张表直接使用插件生成的时间字符串，不做时区转换。
    const displayCapturedAt = getCapturedAtForSheet(data);

    // 账号戳只使用 @用户名。
    const account = data.account || {};
    const accountLabel = account.username ? '@' + account.username : '未知账号（待确认）';
    const items = Array.isArray(data.items) ? data.items : [];
    const rows = items.map(function (item) {
      return [
        displayCapturedAt,
        item.category || '',
        accountLabel,
        item.actorHref || '',
        item.postHref || '',
        item.commentText || '',
      ];
    });
    insertRowsAtThird(sheet, rows);

    // 评论双写：写入同一表格里的「评论收集」sheet。
    const commentRows = items
      .filter(function (item) { return item.category === '评论'; })
      .map(function (item) {
        return [
          displayCapturedAt,
          accountLabel,
          item.actorHref || '',
          item.postHref || '',
          item.commentText || '',
          '', // 评论中文翻译：后续回填
          '', // 分类：后续回填
        ];
      });

    if (commentRows.length) {
      let csheet = ss.getSheetByName(COMMENT_SHEET_NAME);
      if (!csheet) csheet = ss.insertSheet(COMMENT_SHEET_NAME);
      ensureHeaders(csheet, COMMENT_HEADERS);
      insertRowsAtThird(csheet, commentRows);
    }

    // 诊断快照同样从第三行写入（仅诊断开关开启时）。
    if (data.diagnosticHtml) {
      let diag = ss.getSheetByName(DIAG_SHEET_NAME);
      if (!diag) diag = ss.insertSheet(DIAG_SHEET_NAME);
      ensureHeaders(diag, DIAG_HEADERS);
      insertRowsAtThird(diag, [[
        displayCapturedAt,
        data.batchId || '',
        String(data.diagnosticHtml).slice(0, 45000),
      ]]);
    }

    return jsonOut({
      ok: true,
      written: rows.length,
      comments: commentRows.length,
      spreadsheetId: ss.getId(),
      sheet: sheet.getName(),
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

function doGet() {
  return jsonOut({ ok: true, info: 'TikTok 采集接收端 V1.0 已部署。请用插件 POST 数据。' });
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
