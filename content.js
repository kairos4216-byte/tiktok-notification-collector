'use strict';

/* =====================================================================
 * TikTok 1TK 通知采集 — content script v0.9（常驻在 tiktok.com 页面内）
 *
 * v0.4 依据 2026-11-03 三轮真实诊断快照重写提取层，确认的真实结构：
 *  - 列表容器：div[data-e2e="inbox-list"]#header-inbox-list（面板没打开时
 *    也常驻 DOM 并预渲染首屏条目，只是隐藏）
 *  - 分类标签：button[data-e2e="likes"|"comments"|"followers"]
 *  - 条目行：div[data-e2e="inbox-list-item"]，行内：
 *      [data-e2e="inbox-title"] 里的 a = 互动者（文字是显示名，
 *        aria-label="<显示名> 的主页"，href="/@<用户名>" 相对地址！）
 *      [data-e2e="inbox-content"] = 动作短语 + " · " + 相对时间
 *        （评论分类里应为评论原文，仍需真实数据确认）
 *      行内另一个 a[href*="/video/"] = 帖子封面链接（相对地址）
 *      评论行：a[href*="business-suite/comments?..."] 带 comment_id/video_id
 *  - 所有 href 都是相对地址，必须用 a.href 属性取绝对地址，
 *    用 getAttribute('href') + 绝对地址正则匹配会一条都对不上（v0.3 的坑）
 *
 * 工作方式（用户定死的设计，不许偏离）：
 *  - 只在用户已经打开的 TikTok 首页标签页里就地工作，绝不导航、绝不新开页
 *  - 打开通知面板 → 依次读「评论 / 赞 / 粉丝」（不读「提及和标记」）
 *    → 读完关掉面板，页面恢复原样
 *  - 面板若打不开（隐藏 DOM），退而求其次：直接点隐藏的分类标签，
 *    读已渲染的首屏条目并给条目标记 panel-not-opened（深度有限，
 *    但 2 小时一轮的节奏下首屏通常就是全部新增）
 *  - 自动轮次有 5 分钟无操作守卫；手动轮次立即执行
 *  - 唯一允许的点击例外：点赞分类里的聚合行可以点开逐人读。
 *    其余任何单条通知、评论行、关注行、视频、私信入口，一律不点
 *  - 发现登录墙 / 滑块 / 验证码 / 核实 / 风险提示：立刻中止回报
 *    status='blocked: <看到什么>'，绝不尝试自己通过
 * ===================================================================== */

/* ======================= CONFIG：选择器集中区 ======================= */

const CONFIG = {
  categories: [
    { key: '评论', tabSelector: '[data-e2e="comments"]', tabTexts: ['评论', 'Comments', 'Comment'] },
    { key: '赞', tabSelector: '[data-e2e="likes"]', tabTexts: ['赞', 'Likes', 'Like'] },
    { key: '粉丝', tabSelector: '[data-e2e="followers"]', tabTexts: ['粉丝', 'Followers', 'Follower', '关注者'] },
  ],

  inboxBarSelector: '[data-e2e="inbox-bar"]',
  listSelector: '[data-e2e="inbox-list"], #header-inbox-list',
  rowSelector: '[data-e2e="inbox-list-item"]',
  titleSelector: '[data-e2e="inbox-title"]',
  contentSelector: '[data-e2e="inbox-content"]',

  // 打开通知面板的按钮：aria-label / title / data-e2e / href 命中任一规律，
  // 且不能是面板内部的元素（标签栏/列表里的不算按钮）
  inboxButtonPatterns: [/inbox/i, /收件箱/, /通知/, /动态/, /notifications?/i],
  inboxButtonSelectors: [
    '[data-e2e*="inbox"]',
    '[data-e2e*="notification"]',
    'a[href*="inbox"]',
    'a[href*="notification"]',
  ],

  // 主页链接规律（对 a.href 绝对地址测试）
  actorHrefRe: /^https?:\/\/www\.tiktok\.com\/@[^/?#]+\/?$/,
  commentPostHrefRe: /(business-suite\/comments|comment_id=)/,
  likePostHrefRe: /\/video\/\d+/,

  // 相对时间文字（原文照抄；解析时兼容「35秒」这种不带「前」的写法）
  timeTextRe: /(\d+\s*秒前|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|昨天|刚刚|刚才|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d+\s*[smhdw]\s*ago|yesterday|just now)/i,

  maxAgeHours: 26,

  scrollStepRatio: 0.7,
  pauseMinMs: 1500,
  pauseMaxMs: 4000,
  maxScrollStepsPerCategory: 30,

  idleGuardMs: 5 * 60 * 1000,

  blockerTextPatterns: [
    /验证码/, /滑块/, /拖动.*完成拼图/, /请完成验证/,
    /核实.*是你本人|确认是你本人/,
    /账号存在风险|账户存在风险|风险提示/,
    /captcha/i, /verify (that )?it'?s you/i, /suspicious/i,
  ],
  blockerSelectors: [
    'iframe[src*="captcha"]', '[id*="captcha"]', '[class*="captcha"]',
    '[class*="secsdk"]', 'input[autocomplete="one-time-code"]',
  ],
  loginWallSelectors: [
    'input[type="password"]', '[data-e2e="login-modal"]', 'form[action*="login"]',
  ],
  loginWallTexts: [/使用手机号码.*登录/, /Log in to TikTok/i, /登录后即可/],

  actionPhrases: [
    '评论了你的视频', '回复了你的评论', '在评论中提及了你', '提及了你',
    '赞了你的视频', '点赞了你的视频', '喜欢了你的视频',
    '开始关注你', '关注了你',
    'commented on your video', 'liked your video', 'started following you',
    'mentioned you',
  ],

  aggregateRe: /(等\s*\d+\s*人|和其他\s*\d+\s*人|and\s+\d+\s+others?)/i,
};

/* ============================ 工具函数 ============================ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function randPause() {
  return CONFIG.pauseMinMs + Math.random() * (CONFIG.pauseMaxMs - CONFIG.pauseMinMs);
}

function visible(el) {
  if (!el || !(el instanceof Element)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function textOf(el) {
  return (el && (el.innerText || el.textContent) || '').trim();
}

/** 相对时间粗略换算成小时数；认不出返回 null。兼容「35秒」不带「前」 */
function parseRelHours(text) {
  if (!text) return null;
  let m;
  if (/(刚刚|刚才|just now)/i.test(text)) return 0;
  if ((m = text.match(/(\d+)\s*秒/))) return 0;
  if ((m = text.match(/(\d+)\s*分钟/))) return parseInt(m[1], 10) / 60;
  if ((m = text.match(/(\d+)\s*小时/))) return parseInt(m[1], 10);
  if (/昨天|yesterday/i.test(text)) return 24;
  if ((m = text.match(/(\d+)\s*天/))) return parseInt(m[1], 10) * 24;
  if ((m = text.match(/(\d+)\s*周/))) return parseInt(m[1], 10) * 24 * 7;
  if ((m = text.match(/(\d+)\s*s\s*ago/i))) return 0;
  if ((m = text.match(/(\d+)\s*m\s*ago/i))) return parseInt(m[1], 10) / 60;
  if ((m = text.match(/(\d+)\s*h\s*ago/i))) return parseInt(m[1], 10);
  if ((m = text.match(/(\d+)\s*d\s*ago/i))) return parseInt(m[1], 10) * 24;
  if ((m = text.match(/(\d+)\s*w\s*ago/i))) return parseInt(m[1], 10) * 24 * 7;
  if (/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(text)) return 999;
  return null;
}

/* ===================== 用户操作监测（无操作守卫） ===================== */

let lastInteractionAt = Date.now();
['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((evt) => {
  window.addEventListener(evt, () => { lastInteractionAt = Date.now(); },
    { passive: true, capture: true });
});

/* ============================ 安全检查 ============================ */

function detectBlocker() {
  for (const sel of CONFIG.blockerSelectors) {
    const el = document.querySelector(sel);
    if (el && visible(el)) return '疑似验证元素 ' + sel;
  }
  const bodyText = document.body ? document.body.innerText || '' : '';
  for (const re of CONFIG.blockerTextPatterns) {
    if (re.test(bodyText)) return '页面出现文字 ' + re.source;
  }
  for (const sel of CONFIG.loginWallSelectors) {
    const el = document.querySelector(sel);
    if (el && visible(el)) return '疑似登录墙 ' + sel;
  }
  for (const re of CONFIG.loginWallTexts) {
    if (re.test(bodyText)) return '页面出现登录提示 ' + re.source;
  }
  return null;
}

/* ============================ 面板定位 ============================ */

function findListEl() { return document.querySelector(CONFIG.listSelector); }
function findBarEl() { return document.querySelector(CONFIG.inboxBarSelector); }

/** 面板是否真的打开了：以收件箱按钮的 aria-expanded 为准（可见性判定在该面板上不可靠） */
function panelIsOpen() {
  const btn = document.querySelector('[data-e2e="inbox-icon"]');
  if (btn) {
    const holder = btn.closest('[aria-expanded]') || btn;
    if (holder && holder.getAttribute && holder.getAttribute('aria-expanded') !== null) {
      return holder.getAttribute('aria-expanded') === 'true';
    }
  }
  const bar = findBarEl();
  if (bar && visible(bar)) return true;
  const list = findListEl();
  return !!(list && visible(list));
}

function findPanelRoot() {
  const list = findListEl();
  const bar = findBarEl();
  if (list) {
    let node = list;
    while (node && node !== document.body) {
      if (!bar || node.contains(bar)) return node;
      node = node.parentElement;
    }
    return list.parentElement || list;
  }
  if (bar) return bar.parentElement || bar;
  return null;
}

function inPanel(el) {
  return !!(el && el.closest && el.closest('#header-inbox-list, [data-e2e="inbox-bar"], [data-e2e="inbox-list"]'));
}

function findInboxButton() {
  const candidates = new Set();
  for (const sel of CONFIG.inboxButtonSelectors) {
    document.querySelectorAll(sel).forEach((el) => candidates.add(el));
  }
  document.querySelectorAll('button, a, [role="button"]').forEach((el) => candidates.add(el));
  for (const el of candidates) {
    if (inPanel(el)) continue; // 面板内部的元素不是开关按钮
    const hay = [
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('data-e2e') || '',
      el.getAttribute('href') || '',
    ].join(' ');
    if (/message|私信|消息/i.test(hay) && !/notification/i.test(hay)) continue;
    if (CONFIG.inboxButtonPatterns.some((re) => re.test(hay))) return el;
  }
  return null;
}

function fullClick(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

/**
 * 打开面板：已经开着就不点（再点会关掉）；点一次不行就补一次
 * 完整的鼠标事件序列，再不行试父元素。全过程记 clickLog 供诊断。
 */
async function openPanel(clickLog) {
  if (panelIsOpen()) { clickLog.push('already-open'); return true; }
  const btn = findInboxButton();
  if (!btn) { clickLog.push('inbox-button-not-found'); return false; }
  clickLog.push('btn=' + (btn.outerHTML || '').slice(0, 300));

  btn.click();
  await sleep(1500);
  if (panelIsOpen()) { clickLog.push('open-after-click'); return true; }

  fullClick(btn);
  await sleep(1500);
  if (panelIsOpen()) { clickLog.push('open-after-fullclick'); return true; }

  if (btn.parentElement) {
    btn.parentElement.click();
    await sleep(1500);
    if (panelIsOpen()) { clickLog.push('open-after-parent-click'); return true; }
  }
  clickLog.push('still-closed');
  return false;
}

/** 找分类标签（不要求可见——隐藏 DOM 里也要能点，让 React 换内容） */
function findCategoryTab(panel, category) {
  if (category.tabSelector) {
    const bySel = document.querySelector(category.tabSelector);
    if (bySel) return bySel;
  }
  const root = panel || document;
  const els = root.querySelectorAll('button, a, [role="tab"], div, span');
  for (const el of els) {
    const t = textOf(el);
    if ((category.tabTexts || []).includes(t)) {
      return el.closest('button, a, [role="tab"]') || el;
    }
  }
  return null;
}

async function waitForCategoryTab(panel, category, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  while (Date.now() < deadline) {
    const tab = findCategoryTab(panel, category);
    if (tab) return tab;
    await sleep(400);
  }
  return null;
}

/** 滚动容器：列表自身或其可滚动祖先；隐藏时返回列表本身（滚不动就只读首屏） */
function findScrollContainer(panel) {
  const list = findListEl();
  if (list) {
    let node = list;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 20) {
        const style = window.getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY)) return node;
      }
      if (panel && node === panel) break;
      node = node.parentElement;
    }
    return list;
  }
  return panel;
}

/* ============================ 条目提取 ============================ */

/** 行内所有「主页锚点」（用 a.href 绝对地址判定，兼容相对 href） */
function actorAnchorsIn(root) {
  return Array.from(root.querySelectorAll('a[href]')).filter((a) =>
    CONFIG.actorHrefRe.test(a.href || '')
  );
}

function findRows(scrollContainer) {
  const list = findListEl();
  const scope = list || scrollContainer;
  if (!scope) return [];
  const bySel = scope.querySelectorAll(CONFIG.rowSelector);
  if (bySel.length) return Array.from(bySel);
  // 兜底：锚点爬升法（旧逻辑）
  const rows = [];
  const seen = new Set();
  for (const a of actorAnchorsIn(scope)) {
    let el = a;
    while (el.parentElement && el.parentElement !== scope) {
      const parent = el.parentElement;
      if (actorAnchorsIn(parent).length > actorAnchorsIn(el).length) break;
      el = parent;
    }
    if (!seen.has(el)) { seen.add(el); rows.push(el); }
  }
  return rows;
}

function extractRow(rowEl, categoryKey) {
  const rawText = textOf(rowEl);
  const titleEl = rowEl.querySelector(CONFIG.titleSelector);
  const contentEl = rowEl.querySelector(CONFIG.contentSelector);

  // 互动者：标题里的锚点为准；其次头像锚点（aria-label="<名> 的主页"）
  let actorName = '';
  let actorHref = '';
  const titleAnchor = titleEl ? titleEl.querySelector('a[href]') : null;
  if (titleAnchor && CONFIG.actorHrefRe.test(titleAnchor.href || '')) {
    actorHref = titleAnchor.href;
    actorName = textOf(titleAnchor);
  }
  if (!actorHref) {
    const anchors = actorAnchorsIn(rowEl);
    if (!anchors.length) return null;
    actorHref = anchors[0].href;
    for (const a of anchors) {
      const label = a.getAttribute('aria-label') || '';
      const m = label.match(/^(.+?)\s*的主页$/);
      if (m) { actorName = m[1]; actorHref = a.href; break; }
      const t = textOf(a);
      if (t.length > actorName.length) { actorName = t; actorHref = a.href; }
    }
  }
  if (!actorName) {
    const lines = rawText.split('\n').map((s) => s.trim()).filter(Boolean);
    actorName = lines.length ? lines[0] : '';
  }

  // 内容区文字：动作/评论 + " · " + 相对时间
  const contentText = contentEl ? textOf(contentEl) : '';
  let relativeTime = '';
  let mainText = contentText;
  if (contentText.includes('·')) {
    const parts = contentText.split('·').map((s) => s.trim());
    const last = parts[parts.length - 1];
    if (parseRelHours(last) !== null || CONFIG.timeTextRe.test(last)) {
      relativeTime = last;
      mainText = parts.slice(0, -1).join(' · ').trim();
    }
  }
  if (!relativeTime) {
    const m = rawText.match(CONFIG.timeTextRe);
    relativeTime = m ? m[0] : '';
  }

  // 帖子链接（a.href 绝对地址）
  let postHref = '';
  const allLinks = Array.from(rowEl.querySelectorAll('a[href]'));
  for (const a of allLinks) {
    const href = a.href || '';
    if (categoryKey === '评论' && CONFIG.commentPostHrefRe.test(href)) { postHref = href; break; }
    if (categoryKey === '赞' && CONFIG.likePostHrefRe.test(href)) { postHref = href; break; }
  }
  if (!postHref && categoryKey !== '粉丝') {
    for (const a of allLinks) {
      const href = a.href || '';
      if (CONFIG.likePostHrefRe.test(href)) { postHref = href; break; }
    }
  }

  // 评论文本：评论分类的内容区在剔除动作短语后剩下的部分；
  // 若内容区就是动作短语（如"评论了你的视频"），则回退到行文本逐行剔除
  let commentText = '';
  if (categoryKey === '评论') {
    let candidate = mainText;
    for (const p of CONFIG.actionPhrases) {
      if (candidate === p) { candidate = ''; break; }
    }
    if (!candidate) {
      const lines = rawText.split('\n').map((s) => s.trim()).filter(Boolean);
      const kept = lines.filter((line) => {
        if (actorName && line === actorName) return false;
        if (relativeTime && line === relativeTime) return false;
        if (CONFIG.actionPhrases.some((p) => line.includes(p))) return false;
        return true;
      });
      candidate = kept.join(' ').trim();
    }
    commentText = candidate.replace(/^发表了评论[：:]\s*/, '').trim();
  }

  const anchors = actorAnchorsIn(rowEl);
  const flags = [];
  if (anchors.length > 1) flags.push('multi-anchor-row');
  if (CONFIG.aggregateRe.test(rawText)) flags.push('aggregate-text');

  return {
    category: categoryKey,
    actorName, actorHref, postHref, commentText, relativeTime,
    flags, rawText,
    _rowEl: rowEl,
    _actorCount: anchors.length,
  };
}

function itemKey(item) {
  return [item.category, item.actorHref, item.postHref,
    item.commentText || '', item.actorName].join('|');
}

/* ===================== 聚合点赞行的展开（唯一例外） ===================== */

async function expandAggregateRow(item, collected) {
  const rowEl = item._rowEl;
  try {
    rowEl.scrollIntoView({ block: 'center' });
    await sleep(600);
    rowEl.click();
    await sleep(2500);
    const blocker = detectBlocker();
    if (blocker) throw new Error('blocked: ' + blocker);
    const anchors = actorAnchorsIn(document.body).filter((a) => visible(a));
    let added = 0;
    for (const a of anchors) {
      let el = a;
      while (el.parentElement && el.parentElement !== document.body) {
        const parent = el.parentElement;
        if (actorAnchorsIn(parent).length > actorAnchorsIn(el).length) break;
        el = parent;
      }
      const sub = extractRow(el, '赞');
      if (!sub) continue;
      sub.postHref = sub.postHref || item.postHref;
      sub.flags = ['aggregate-expanded'];
      const key = itemKey(sub);
      if (!collected.has(key)) { collected.set(key, sub); added += 1; }
    }
    const backBtn = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .find((el) => {
        const hay = (el.getAttribute('aria-label') || '') + ' ' + textOf(el);
        return /返回|back/i.test(hay) && visible(el);
      });
    if (backBtn) { backBtn.click(); await sleep(1500); }
    return added;
  } catch (err) {
    return -1;
  }
}

/* ============================ 分类读取 ============================ */

async function readCategory(panel, category, panelOpened) {
  const tab = await waitForCategoryTab(panel, category);
  if (!tab) return { items: [], error: '找不到分类标签 ' + category.key };
  tab.click();
  await sleep(2000);

  let scrollContainer = findScrollContainer(panel);
  try { scrollContainer.scrollTop = 0; } catch (e) { /* 隐藏时滚不动无妨 */ }
  await sleep(800);

  const collected = new Map();
  let stagnantRounds = 0;

  for (let step = 0; step < CONFIG.maxScrollStepsPerCategory; step++) {
    const blocker = detectBlocker();
    if (blocker) throw new Error('blocked: ' + blocker);

    scrollContainer = findScrollContainer(panel);
    const rows = findRows(scrollContainer);
    let newCount = 0;
    let oldestHours = null;

    for (const rowEl of rows) {
      const item = extractRow(rowEl, category.key);
      if (!item) continue;
      const hours = parseRelHours(item.relativeTime);
      if (hours !== null && (oldestHours === null || hours > oldestHours)) {
        oldestHours = hours;
      }
      const key = itemKey(item);
      if (!collected.has(key)) { collected.set(key, item); newCount += 1; }
    }

    if (category.key === '赞') {
      for (const item of Array.from(collected.values())) {
        if (item._expanded) continue;
        if (item.flags.includes('aggregate-text') && item._actorCount <= 2) {
          item._expanded = true;
          const added = await expandAggregateRow(item, collected);
          if (added === 0) item.flags.push('aggregate-partial');
        }
      }
    }

    if (oldestHours !== null && oldestHours > CONFIG.maxAgeHours) break;

    const beforeTop = scrollContainer.scrollTop;
    const beforeHeight = scrollContainer.scrollHeight;
    try {
      // v0.7：直接滚到底触发懒加载，并补发 wheel 事件（有的实现只认 wheel）
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: 800, bubbles: true, cancelable: true }));
    } catch (e) { /* ignore */ }
    await sleep(1800 + Math.floor(Math.random() * 800));
    lastScrollDiag.push({ cat: category.key, step, top: scrollContainer.scrollTop, h: scrollContainer.scrollHeight, ch: scrollContainer.clientHeight, n: collected.size });

    // 用户规则（2026-11-03）：取不到新内容就停下去下一个分类，
    // 不再因为容器高度变化而继续空拉。
    void beforeHeight; void beforeTop;
    if (newCount === 0) {
      stagnantRounds += 1;
      if (stagnantRounds >= 3) break;
    } else {
      stagnantRounds = 0;
    }
  }

  const items = Array.from(collected.values()).map((item) => {
    const pub = { ...item };
    delete pub._rowEl; delete pub._actorCount; delete pub._expanded;
    if (!panelOpened) pub.flags = [...pub.flags, 'panel-not-opened'];
    return pub;
  });
  return { items, error: null };
}

/* ============================ 关闭面板 ============================ */

async function closePanel(panel, wasOpened) {
  if (!wasOpened) return; // 没打开过就别碰按钮，免得反而把它打开
  try {
    const btn = findInboxButton();
    if (btn) { btn.click(); await sleep(600); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(600);
  } catch (err) { /* 关不掉也不强求 */ }
}

/* ============================ 诊断快照 ============================ */

function diagnosticSnapshot(clickLog, panelOpened) {
  try {
    const list = findListEl();
    const bar = findBarEl();
    // Only structural diagnostics: never upload outerHTML, comment text, URLs or usernames.
    return JSON.stringify({
      version: '1.0.1', panelOpened: !!panelOpened,
      events: (clickLog || []).map((event) => String(event).startsWith('btn=') ? 'button-found' : String(event)).slice(0, 15),
      scroll: lastScrollDiag.slice(-40),
      listExists: !!list, listVisible: list ? visible(list) : false,
      visibleRowCount: list ? list.querySelectorAll(CONFIG.rowSelector).length : 0,
      barExists: !!bar, barVisible: bar ? visible(bar) : false,
    }).slice(0, 12000);
  } catch (_) { return ''; }
}

/* ============ 当前登录账号识别（多账号总库：每批盖账号戳） ============ */

const ACCOUNT_CACHE_KEY = 'tk1tk_self_account_v1';
let accountCache = null;
try {
  const raw = sessionStorage.getItem(ACCOUNT_CACHE_KEY);
  if (raw) accountCache = JSON.parse(raw);
} catch (e) { /* 忽略 */ }

function detectAccount() {
  const cands = [];
  const seen = new Set();
  document.querySelectorAll('a[href^="/@"]').forEach((a) => {
    const m = (a.getAttribute('href') || '').match(/^\/@([\w.]+)\/?$/);
    if (!m) return;
    // 排除通知面板里的他人链接（面板挂在页眉区域，旧逻辑会误抓通知行里的头像链接）
    if (a.closest('[data-e2e="inbox-list"], [data-e2e="inbox-bar"], #header-inbox-bar, #header-inbox-list')) return;
    // 排除主信息流里的作者/评论者链接
    if (a.closest('main')) return;
    const username = m[1];
    const label = ((a.getAttribute('aria-label') || '') + ' ' + textOf(a)).trim();
    let score = 0;
    if (/个人主页|个人资料|我的主页|Profile/i.test(label)) score += 5;
    if (a.closest('header, nav, aside, [class*="SideNav"], [class*="DivHeader"]')) score += 2;
    // 真实用户名（如 giesutrongtoi0）优先于 user+数字 的系统默认形式
    if (!/^user\d+$/i.test(username) && !/^\d+$/.test(username)) score += 4;
    const key = username + '|' + score;
    if (score > 0 && !seen.has(key)) {
      seen.add(key);
      cands.push({ name: '', username, profileUrl: a.href, score, label: label.slice(0, 60) });
    }
  });
  cands.sort((x, y) => y.score - x.score);
  const top = cands.length ? cands[0] : null;
  const numericForm = (u) => /^user\d+$/i.test(u || '') || /^\d+$/.test(u || '');
  let best = null;
  if (accountCache && accountCache.username) {
    // 已锁定真实账号：后续重扫（面板打开、页面重渲染）不再改判
    best = { name: '', username: accountCache.username, profileUrl: accountCache.profileUrl };
    if (top && !numericForm(top.username) && top.username !== accountCache.username &&
        /个人主页|个人资料|我的主页|Profile/i.test(top.label)) {
      // 出现带明确「个人主页」标签的不同真实用户名（真换号了）才更新锁定
      accountCache = { username: top.username, profileUrl: top.profileUrl };
      try { sessionStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(accountCache)); } catch (e) { /* 忽略 */ }
      best = { name: '', username: top.username, profileUrl: top.profileUrl };
    }
  } else if (top) {
    best = { name: '', username: top.username, profileUrl: top.profileUrl };
    if (!numericForm(top.username)) {
      accountCache = { username: top.username, profileUrl: top.profileUrl };
      try { sessionStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(accountCache)); } catch (e) { /* 忽略 */ }
    }
  }
  return { best, cands: cands.slice(0, 5) };
}

/* ============================ 主流程 ============================ */

let lastScrollDiag = [];

let captureRunning = false;
let captureStartedAt = 0;

async function runCapture(mode, diagnostic) {
  if (captureRunning) {
    // 看门狗：上一轮卡住超过 4 分钟就自动放行，避免永远 busy
    if (Date.now() - captureStartedAt > 4 * 60 * 1000) {
      captureRunning = false;
    } else {
      return { status: 'busy' };
    }
  }
  captureRunning = true;
  captureStartedAt = Date.now();
  const batchId = 'batch-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + mode;
  const result = { status: 'ok', batchId, capturedAt: new Date().toISOString(), items: [], mode };
  result.account = detectAccount().best;
  const clickLog = [];
  lastScrollDiag = [];
  let panelOpened = false;

  try {
    if (mode === 'auto' && Date.now() - lastInteractionAt < CONFIG.idleGuardMs) {
      result.status = 'skipped: user active';
      return result;
    }
    let blocker = detectBlocker();
    if (blocker) { result.status = 'blocked: ' + blocker; return result; }

    panelOpened = await openPanel(clickLog);
    const panel = findPanelRoot();
    if (!panel && !findListEl()) {
      result.status = 'error: notification panel not found';
      if (diagnostic) result.diagnosticHtml = diagnosticSnapshot(clickLog, panelOpened);
      return result;
    }

    blocker = detectBlocker();
    if (blocker) {
      result.status = 'blocked: ' + blocker;
      if (diagnostic) result.diagnosticHtml = diagnosticSnapshot(clickLog, panelOpened);
      await closePanel(panel, panelOpened);
      return result;
    }

    for (const category of CONFIG.categories) {
      const one = await readCategory(panel, category, panelOpened);
      if (one.error) { result.status = 'error: ' + one.error; break; }
      result.items.push(...one.items);
      await sleep(randPause());
    }

    if (diagnostic) result.diagnosticHtml = diagnosticSnapshot(clickLog, panelOpened);
    await closePanel(panel, panelOpened);
    return result;
  } catch (err) {
    if (err && typeof err.message === 'string' && err.message.indexOf('blocked:') === 0) {
      result.status = err.message;
    } else {
      result.status = 'error: ' + (err && err.message ? err.message : String(err));
    }
    if (diagnostic && !result.diagnosticHtml) {
      result.diagnosticHtml = diagnosticSnapshot(clickLog, panelOpened);
    }
    return result;
  } finally {
    captureRunning = false;
  }
}

/* ===================== 页面右上角采集按钮（用户 2026-11-03 要求） ===================== */

let fabEl = null;
let fabWrapEl = null;
let fabToastEl = null;
let fabBusy = false;
let fabResetTimer = null;
// UI visibility is independent of capture scheduling. Default visible for existing users.
let pageButtonVisible = true;

function removeFabElements() {
  for (const id of ['tiktok-1tk-fab-wrap', 'tiktok-1tk-fab', 'tiktok-1tk-fab-mode', 'tiktok-1tk-fab-toast']) {
    document.getElementById(id)?.remove();
  }
  if (fabToastEl) clearTimeout(fabToastEl._hideTimer);
  fabWrapEl = null;
  fabEl = null;
  fabModeEl = null;
  fabToastEl = null;
}

async function hideFabFromPage() {
  // Hide synchronously; persistence also updates the popup's showPageButton checkbox.
  pageButtonVisible = false;
  removeFabElements();
  try {
    const result = await chrome.runtime.sendMessage({ type: 'HIDE_PAGE_BUTTON' });
    if (!result || !result.ok) throw new Error('隐藏设置未保存');
  } catch (err) {
    // Restore the UI if saving fails, so this preference cannot silently reset on refresh.
    pageButtonVisible = true;
    injectFab();
    refreshFabMode();
    fabToast('隐藏设置保存失败，请在插件弹窗中重试。', 6000);
  }
}

async function syncPageButtonVisibility() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_UI_SETTINGS' });
    if (!result || !result.ok) return;
    pageButtonVisible = result.settings.showPageButton !== false;
    if (!pageButtonVisible) {
      removeFabElements();
    } else {
      injectFab();
      refreshFabMode();
    }
  } catch (_) { /* keep last known state */ }
}

function fabSet(text, bg) {
  if (!fabEl) return;
  fabEl.textContent = text;
  if (bg) fabEl.style.background = bg;
}
function fabToast(text, ms) {
  if (!pageButtonVisible) return;
  if (!fabToastEl) {
    fabToastEl = document.createElement('div');
    fabToastEl.id = 'tiktok-1tk-fab-toast';
    fabToastEl.style.cssText = 'position:fixed;top:150px;right:16px;z-index:2147483000;max-width:300px;padding:10px 12px;border-radius:10px;background:rgba(20,20,20,.92);color:#fff;font-size:12.5px;line-height:1.5;box-shadow:0 4px 14px rgba(0,0,0,.35);font-family:inherit;display:none;';
    (document.body || document.documentElement).appendChild(fabToastEl);
  }
  fabToastEl.textContent = text;
  fabToastEl.style.display = 'block';
  clearTimeout(fabToastEl._hideTimer);
  fabToastEl._hideTimer = setTimeout(() => { fabToastEl.style.display = 'none'; }, ms || 6000);
}
function fabResetLater() {
  clearTimeout(fabResetTimer);
  fabResetTimer = setTimeout(() => fabSet('📥 采集互动', '#fe2c55'), 8000);
}
function injectFab() {
  if (!pageButtonVisible) return;
  const existing = document.getElementById('tiktok-1tk-fab-wrap');
  if (existing) {
    fabWrapEl = existing;
    fabEl = document.getElementById('tiktok-1tk-fab');
    return;
  }
  if (!document.body) return;
  const wrap = document.createElement('div');
  wrap.id = 'tiktok-1tk-fab-wrap';
  wrap.style.cssText = 'position:fixed;top:72px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:6px;font-family:inherit;';

  const btn = document.createElement('button');
  btn.id = 'tiktok-1tk-fab';
  btn.textContent = '📥 采集互动';
  btn.style.cssText = 'padding:9px 14px;border:none;border-radius:999px;background:#fe2c55;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);font-family:inherit;';
  btn.addEventListener('click', onFabClick);

  const closeBtn = document.createElement('button');
  closeBtn.id = 'tiktok-1tk-fab-hide';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.title = '隐藏采集悬浮框（在插件设置中可重新开启）';
  closeBtn.setAttribute('aria-label', '隐藏采集悬浮框');
  closeBtn.style.cssText = 'width:30px;height:30px;padding:0;border:0;border-radius:50%;background:rgba(35,35,35,.86);color:#fff;font-size:23px;line-height:30px;text-align:center;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.3);font-family:inherit;';
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    return hideFabFromPage();
  });
  wrap.appendChild(btn);
  wrap.appendChild(closeBtn);
  document.body.appendChild(wrap);
  fabWrapEl = wrap;
  fabEl = btn;
}

async function onFabClick() {
  if (fabBusy || captureRunning) { fabToast('正在采集中，请勿重复点击。', 3000); return; }
  fabBusy = true;
  try {
    fabSet('⏳ 准备采集…', '#666');
    const result = await chrome.runtime.sendMessage({ type: 'PAGE_MANUAL_RUN' });
    if (!result || !result.ok) {
      fabSet('⚠ 未启动', '#c9184a');
      fabToast('无法开始采集：' + String(result?.error || '请在插件弹窗检查设置'), 7000);
      fabResetLater();
    }
    // Actual success is shown only when background has confirmed the server response.
  } catch (_) {
    fabSet('⚠ 未启动', '#c9184a');
    fabToast('无法连接插件后台，请刷新页面后重试。', 6000);
    fabResetLater();
  } finally { fabBusy = false; }
}

/* 模式提示条：常驻在按钮下方，显示当前是自动/手动/暂停（用户 2026-11-03 要求） */
let fabModeEl = null;
function fabModeInfo(mode) {
  if (mode === 'manual') return { text: '🟡 手动模式 · 需点按钮才采集', bg: 'rgba(146,108,0,.94)' };
  if (mode === 'off') return { text: '⏸ 已暂停 · 在插件弹窗切换模式', bg: 'rgba(90,90,90,.94)' };
  return { text: '🟢 自动模式 · 约每2小时，离开即可', bg: 'rgba(18,110,52,.94)' };
}
async function refreshFabMode() {
  if (!pageButtonVisible) return;
  try {
    if (!document.body) return;
    if (!fabModeEl) {
      fabModeEl = document.createElement('div');
      fabModeEl.id = 'tiktok-1tk-fab-mode';
      fabModeEl.style.cssText = 'position:fixed;top:116px;right:16px;z-index:2147483000;padding:5px 10px;border-radius:999px;color:#fff;font-size:11.5px;box-shadow:0 2px 8px rgba(0,0,0,.3);font-family:inherit;pointer-events:none;';
      document.body.appendChild(fabModeEl);
    }
    const result = await chrome.runtime.sendMessage({ type: 'GET_UI_SETTINGS' });
    if (!result || !result.ok || !pageButtonVisible) return;
    const s = result.settings || {};
    const info = fabModeInfo(s.mode || (s.paused ? 'off' : 'auto'));
    const override = String(s.accountOverride || '').trim().replace(/^@/, '');
    const acct = override ? { username: override } : detectAccount().best;
    fabModeEl.textContent = info.text + (acct ? ' · @' + acct.username : ' · 账号未识别');
    fabModeEl.style.background = info.bg;
  } catch (e) { /* 忽略 */ }
}
setInterval(refreshFabMode, 15000);

syncPageButtonVisibility();
setInterval(() => { if (pageButtonVisible) injectFab(); }, 5000);

/* ============================ 消息入口 ============================ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'UI_SETTINGS_CHANGED') { syncPageButtonVisibility(); return; }
  if (msg.type === 'RUN_STATE') {
    if (msg.state === 'started') { fabSet('⏳ 采集中…', '#666'); }
    else if (msg.state === 'done') { fabSet('✓ 已发送', '#25a244'); if (msg.summary) fabToast(msg.summary, 8000); fabResetLater(); }
    else if (msg.state === 'error') { fabSet('⚠ 未成功', '#c9184a'); if (msg.summary) fabToast('自动采集未成功：' + msg.summary, 9000); fabResetLater(); }
    return;
  }
  if (msg.type !== 'RUN_CAPTURE') return;
  sendResponse({ accepted: true });
  runCapture(msg.mode || 'auto', !!msg.diagnostic).then((result) => {
    chrome.runtime.sendMessage({ type: 'CAPTURE_RESULT', runId: msg.runId, ...result }).catch(() => {});
  });
});
