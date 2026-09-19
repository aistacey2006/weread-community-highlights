// ==UserScript==
// @name         WeRead Popular Highlights
// @namespace    s-weread
// @version      0.7.1
// @license      MIT
// @description  Show popular WeRead highlights in the desktop web reader.
// @match        https://weread.qq.com/web/reader/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      i.weread.qq.com
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict';
// Capture the reader before Vue drops its DOM instance references. No credentials
// enter this page-world adapter; GM storage and API requests remain sandboxed.
function readerBridgeBootstrap() {
  'use strict';
  if (window.__wrphReader?.version === 1) return window.__wrphReader;
  let requireModule;
  let decrypt;
  let cache;
  const readers = new Set();
  const hooked = new WeakSet();
  const capture = function() {
    if (typeof this.scrollTo === 'function' && /^(reader|HorizontalReader)$/i.test(this.$options?.name || '')) readers.add(this);
  };
  function inspect(value) {
    if (!value || hooked.has(value)) return;
    if (value.cid === 0 && /^2\./.test(value.version || '') && typeof value.prototype?._init === 'function') {
      hooked.add(value);
      const original = value.prototype._init;
      value.prototype._init = function(...args) {
        const result = original.apply(this, args);
        capture.call(this);
        return result;
      };
    }
    if (typeof value.decryption === 'function') decrypt = value.decryption.bind(value);
  }
  function inspectExports(exports) {
    try {
      inspect(exports);
      if (exports && typeof exports === 'object') {
        for (const key of Object.keys(exports)) {
          try { inspect(exports[key]); } catch (_) { /* optional export */ }
        }
      }
    } catch (_) { /* never interrupt the site's module initialization */ }
  }
  function wrapChunk(chunk) {
    if (!chunk?.[1] || readers.size) return chunk;
    for (const id of Object.keys(chunk[1])) {
      const original = chunk[1][id];
      if (typeof original !== 'function') continue;
      chunk[1][id] = function(module, exports, require) {
        if (!requireModule) {
          requireModule = require;
          for (const entry of Object.values(require.c || {})) inspectExports(entry.exports);
        }
        // Each module factory needs interception only once.
        require.m[id] = original;
        const result = original.apply(this, arguments);
        inspectExports(module.exports);
        return result;
      };
    }
    return chunk;
  }
  const queue = window.webpackJsonp = window.webpackJsonp || [];
  queue.forEach(wrapChunk);
  let nextPush = queue.push;
  let pushing = false;
  const push = function(...chunks) {
    // The webpack runtime calls the old array push after processing its chunk.
    if (pushing) return Array.prototype.push.apply(this, chunks);
    pushing = true;
    try { return nextPush.apply(this, chunks.map(wrapChunk)); }
    finally { pushing = false; }
  };
  Object.defineProperty(queue, 'push', {
    configurable: true,
    get() { return push; },
    set(fn) { nextPush = fn; }
  });
  function reader() {
    for (const r of readers) {
      if (r._isDestroyed) readers.delete(r);
      else if (r.$el?.isConnected) return r;
    }
    return null;
  }
  function identity() {
    const r = reader();
    if (!r) return null;
    const chapter = r.currentChapter || r.$store?.state?.reader?.currentChapter;
    const chapterUid = r.currentChapterUid ?? chapter?.chapterUid;
    if (!r.bookId || chapterUid === undefined) return null;
    return { bookId: String(r.bookId), chapterUid: Number(chapterUid), title: chapter?.title || '' };
  }
  function sameChapter(context) {
    const current = identity();
    return current && String(context.bookId) === current.bookId && Number(context.chapterUid) === current.chapterUid;
  }
  function chapterCharacters() {
    const r = reader();
    const context = identity();
    if (!r || !context) throw new Error('尚未捕获 reader；请刷新本页后重新读取');
    if (!decrypt && requireModule) {
      for (const m of Object.values(requireModule.c || {})) inspectExports(m.exports);
    }
    const state = r.$store?.state?.reader;
    const entries = r.horizontalReaderChapterContentHtml?.[context.chapterUid] || state?.chapterContentHtml;
    if (!decrypt || !Array.isArray(entries) || !entries.length) throw new Error('当前 renderer 尚未提供章节正文');
    const values = entries.map(entry => entry?.value);
    const key = context.bookId + ':' + context.chapterUid;
    if (cache?.key === key && values.length === cache.values.length && values.every((v, i) => v === cache.values[i])) return cache.characters;
    const characters = new Map();
    entries.forEach((entry, section) => {
      if (typeof entry?.value !== 'string' || !entry.value) return;
      const html = decrypt(entry.value, context.bookId, context.chapterUid, section);
      if (typeof html !== 'string') return;
      const template = document.createElement('template');
      template.innerHTML = html;
      // data-wr-co is the renderer's original UTF-16 chapter offset. Do not
      // reconstruct it from normalized text, textContent length or HTML length.
      for (const el of template.content.querySelectorAll('[data-wr-co][data-wr-role="text"]')) {
        const offset = Number(el.getAttribute('data-wr-co'));
        if (!Number.isSafeInteger(offset) || offset < 0) continue;
        const text = el.textContent || '';
        for (let i = 0; i < text.length; i++) characters.set(offset + i, text[i]);
      }
    });
    const sorted = [...characters].sort((a, b) => a[0] - b[0]);
    if (!sorted.length) throw new Error('正文缺少 data-wr-co，无法确认字符范围');
    cache = {key, values, characters: sorted};
    return sorted;
  }
  const normalize = text => String(text || '').replace(/[\s\u200b\ufeff]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-');
  function parseRange(raw) {
    // The official Range parser treats bestbookmarks' range as inclusive ends.
    const match = typeof raw === 'string' && /^(\d+)-(\d+)$/.exec(raw);
    if (!match) return null;
    const start = Number(match[1]), end = Number(match[2]);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end - start < 100000 ? {start, end} : null;
  }
  function rangeText(characters, start, end) {
    let low = 0, high = characters.length;
    while (low < high) { const middle = (low + high) >>> 1; if (characters[middle][0] < start) low = middle + 1; else high = middle; }
    let text = '';
    for (; low < characters.length && characters[low][0] <= end; low++) text += characters[low][1];
    return text;
  }
  function locate(items, context) {
    if (!sameChapter(context)) throw new Error('章节已变化，请重新读取');
    const characters = chapterCharacters();
    return items.map(item => {
      const range = parseRange(item.range);
      if (!range || !item.markText) return null;
      const text = rangeText(characters, range.start, range.end);
      if (normalize(text) !== normalize(item.markText)) return null;
      return {...range, ...context, text, method:'native'};
    });
  }
  async function jump(target) {
    if (!sameChapter(target)) throw new Error('章节已变化，请重新读取');
    const r = reader();
    const range = parseRange(target.start + '-' + target.end);
    if (!range || normalize(rangeText(chapterCharacters(), range.start, range.end)) !== normalize(target.text)) throw new Error('正文范围校验失败');
    r.scrollTo({chapterOffset: range.start, chapterOffsetEnd: range.end + 1, highlight: true});
    // Section changes are asynchronous. Confirm the renderer's actual object,
    // rather than counting an attempted scroll as a successful jump.
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!sameChapter(target)) throw new Error('跳转期间章节发生变化');
      let object;
      if (typeof r.getCurrentDisplayRenderContents === 'function') {
        object = r.getCurrentDisplayRenderContents().find(o => o.getOffset?.() === range.start && (!o.chapterUid || Number(o.chapterUid) === Number(target.chapterUid)));
      } else if (typeof r.findNearestObjByOffset === 'function') {
        object = r.findNearestObjByOffset(range.start);
      }
      if (object?.getOffset?.() === range.start && object.rect) return {located:true, visual:!!r.chapterContentHighLightBgHtml};
    }
    throw new Error('reader 尚未完成目标分段排版，请再点击一次');
  }
  function clearPage() {
    document.getElementById('wrph-page-marks')?.replaceChildren();
  }
  function viewport() {
    const r = reader(), context = identity();
    if (!r || !context) return null;
    const content = r.$refs?.renderTargetContent;
    if (!content?.isConnected || typeof r.findObjsWithPoints !== 'function' || typeof r.clientXY2RenderAreaXY !== 'function') return null;
    const origin = content.getBoundingClientRect();
    const top = Math.max(0, r.$refs?.reader_top_bar?.$el?.getBoundingClientRect().bottom || 72);
    const bottom = window.innerHeight - 20;
    const startPoint = r.clientXY2RenderAreaXY({x: 0, y: top});
    const endPoint = r.clientXY2RenderAreaXY({x: window.innerWidth, y: bottom});
    const objects = r.findObjsWithPoints(startPoint, endPoint).filter(o => {
      const rect = o.rect;
      return rect && Number.isFinite(o.getOffset?.()) && o.getTextLength?.() > 0 && rect.w > 0 && rect.h > 0 && rect.y + rect.h + origin.top > top && rect.y + origin.top < bottom;
    });
    const start = objects.length ? Math.min(...objects.map(o => o.getOffset())) : -1;
    const end = objects.length ? Math.max(...objects.map(o => o.getOffset() + o.getTextLength())) : -1;
    const signature = [context.bookId, context.chapterUid, r.getCurrentSectionIdx, r.renderContentsVersion, start, end, Math.round(origin.left), Math.round(origin.top), origin.width, window.innerHeight].join(':');
    return {r, context, origin, top, bottom, objects, start, end, signature};
  }
  function pageState() {
    const v = viewport();
    return v ? { ...v.context, signature: v.signature, start: v.start, end: v.end, section: v.r.getCurrentSectionIdx } : null;
  }
  function paintPage(items, context, signature) {
    const v = viewport();
    if (!v || !sameChapter(context) || v.signature !== signature) return null;
    clearPage();
    const characters = chapterCharacters();
    const marks = [];
    for (const item of items) {
      const range = parseRange(item.range);
      if (!range || range.start >= v.end || range.end < v.start) continue;
      const objects = v.objects.filter(o => o.getOffset() <= range.end && o.getOffset() + o.getTextLength() > range.start);
      if (!objects.length) continue;
      const rects = v.r.getRectsByContentObjs(objects).map(rect => ({x:rect.x + v.origin.left, y:rect.y + v.origin.top, w:rect.w, h:rect.h}));
      if (!rects.length) continue;
      const text = rangeText(characters, range.start, range.end);
      if (!text.trim()) continue;
      marks.push({...item, markText:text, target:{...range,...context,text,method:'native'}, rects});
    }
    return {marks, left:v.origin.left, right:v.origin.right, top:v.top, bottom:v.bottom, signature};
  }

  const adapter = {version:1, identity, locate, jump, pageState, paintPage, clearPage};
  window.__wrphReader = adapter;
  return adapter;
}

  const readerBridge = unsafeWindow.Function('return (' + readerBridgeBootstrap.toString() + ')()')();

  const API = 'https://i.weread.qq.com/api/agent/gateway';
  const SKILL_VERSION = '1.0.4';
  const KEY_NAME = 'weread_api_key';
  const PANEL_ID = 'wr-popular-panel-v03';
  const STYLE_ID = 'wr-popular-style-v03';
  const HIGHLIGHT_NAME = 'wr-popular-v03';


  function getKey() {
    try {
      return String(GM_getValue(KEY_NAME, '') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function askAndSaveKey() {
    const key = window.prompt(
      '请输入微信读书 WeRead API Key（以 wrk- 开头）\n\n官方获取页：https://weread.qq.com/r/weread-skills',
      getKey()
    );

    if (key === null) return false;

    const clean = key.trim();

    if (!clean.startsWith('wrk-')) {
      window.alert('这个 Key 看起来不对：应当以 wrk- 开头。');
      return false;
    }

    GM_setValue(KEY_NAME, clean);
    setStatus('Key 已保存，准备重新读取……', true);
    return true;
  }

  function api(apiName, params = {}) {
    const key = getKey();

    if (!key) {
      return Promise.reject(
        new Error('还没有设置 WeRead API Key')
      );
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        anonymous: true,
        url: API,

        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },

        data: JSON.stringify({
          api_name: apiName,
          ...params,
          skill_version: SKILL_VERSION
        }),

        timeout: 15000,

        onload(res) {
          let data;

          try {
            data = JSON.parse(res.responseText || '{}');
          } catch (_) {
            reject(
              new Error(
                `API 返回内容无法解析（HTTP ${res.status}）`
              )
            );
            return;
          }

          if (data.upgrade_info) {
            reject(
              new Error(
                data.upgrade_info.message ||
                'WeRead API 要求升级'
              )
            );
            return;
          }

          const errcode =
            data.errcode ??
            data.errCode ??
            0;

          if (
            res.status < 200 ||
            res.status >= 300 ||
            Number(errcode) !== 0
          ) {
            reject(
              new Error(
                data.errmsg ||
                data.message ||
                `API 错误：HTTP ${res.status}, errcode ${errcode}`
              )
            );
            return;
          }

          resolve(data);
        },

        onerror() {
          reject(
            new Error('连接微信读书 API 失败')
          );
        },

        ontimeout() {
          reject(
            new Error('连接微信读书 API 超时')
          );
        }
      });
    });
  }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;

    style.textContent = `
      #wrph-page-marks { position:fixed; inset:0; z-index:100; pointer-events:none; }
      #wrph-page-marks button { position:fixed; pointer-events:auto; cursor:pointer; }
      #wrph-page-marks .wrph-page-hit { background:transparent; border:0; border-bottom:1px dotted rgba(110,125,140,.48); border-radius:0; padding:0; box-sizing:border-box; }
      #wrph-page-marks .wrph-page-hit:hover { background:rgba(125,145,165,.06); border-bottom-color:rgba(90,110,130,.85); }

      ::highlight(${HIGHLIGHT_NAME}) {
        background: rgba(218, 190, 88, .22);
        text-decoration-line: underline;
        text-decoration-style: dotted;
        text-decoration-thickness: 1.5px;
        text-underline-offset: 3px;
        text-decoration-color: rgba(90, 72, 20, .72);
      }

      #${PANEL_ID} {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #222;
      }

      #${PANEL_ID} * {
        box-sizing: border-box;
      }

      #${PANEL_ID} .wr-main-btn {
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        background: rgba(255,255,255,.98);
        color: #222;
        box-shadow: 0 5px 20px rgba(0,0,0,.16);
        cursor: pointer;
        font-size: 13px;
      }

      #${PANEL_ID} .wr-box {
        display: none;
        width: 390px;
        max-height: 68vh;
        overflow: auto;
        margin-bottom: 10px;
        border-radius: 14px;
        background: rgba(255,255,255,.99);
        color: #222;
        box-shadow: 0 8px 30px rgba(0,0,0,.18);
        border: 1px solid rgba(0,0,0,.08);
      }

      #${PANEL_ID}.open .wr-box {
        display: block;
      }

      #${PANEL_ID} .wr-head {
        position: sticky;
        top: 0;
        z-index: 1;
        background: rgba(255,255,255,.99);
        padding: 12px 14px 10px;
        border-bottom: 1px solid rgba(0,0,0,.07);
      }

      #${PANEL_ID} .wr-close { position:absolute; top:7px; right:8px; width:30px; height:30px; border:0; border-radius:6px; background:transparent; color:#666; cursor:pointer; font-size:24px; line-height:28px; }
      #${PANEL_ID} .wr-close:hover { background:rgba(0,0,0,.06); }
      #${PANEL_ID} .wr-title {
        padding-right:30px;
        font-size: 13px;
        font-weight: 650;
        margin-bottom: 5px;
      }

      #${PANEL_ID} .wr-status {
        font-size: 12px;
        line-height: 1.45;
        color: rgba(0,0,0,.64);
      }

      #${PANEL_ID} .wr-actions {
        display: flex;
        gap: 8px;
        margin-top: 9px;
      }

      #${PANEL_ID} .wr-action {
        border: 1px solid rgba(0,0,0,.12);
        background: #fff;
        color: #222;
        border-radius: 8px;
        padding: 6px 9px;
        cursor: pointer;
        font-size: 12px;
      }

      #${PANEL_ID} .wr-item {
        display: block;
        width: 100%;
        text-align: left;
        border: 0;
        border-bottom: 1px solid rgba(0,0,0,.06);
        background: #fff;
        color: #222;
        padding: 10px 14px;
        cursor: pointer;
      }

      #${PANEL_ID} .wr-item:hover {
        background: rgba(0,0,0,.035);
      }

      #${PANEL_ID} .wr-item[disabled] {
        cursor: default;
      }

      #${PANEL_ID} .wr-count {
        font-size: 11px;
        color: rgba(0,0,0,.52);
        margin-bottom: 4px;
      }

      #${PANEL_ID} .wr-text {
        font-size: 12.5px;
        line-height: 1.5;
        color: #222;
      }

      #${PANEL_ID} .wr-reviews {
        padding: 8px 14px 10px;
        border-bottom: 1px solid #e8e8e8;
        background: #fafafa;
        color: #333;
        font-size: 12px;
        line-height: 1.55;
      }
      #${PANEL_ID} .wr-reviews summary { cursor: pointer; color: #32679c; }
      #${PANEL_ID} .wr-reviews-body { padding-top: 8px; }
      #${PANEL_ID} .wr-review + .wr-review { border-top: 1px solid #e4e4e4; margin-top: 9px; padding-top: 9px; }
      #${PANEL_ID} .wr-review strong { display: block; margin-bottom: 3px; }
      #${PANEL_ID} .wr-review-content { white-space: pre-wrap; overflow-wrap: anywhere; }

      #${PANEL_ID} .wr-miss .wr-count::after {
        content: ' · 未定位到正文';
        color: #a35b00;
      }
    `;

    document.head.appendChild(style);
  }

  function ensurePanel() {
    installStyle();

    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;

    panel.innerHTML = `
      <div class="wr-box">
        <div class="wr-head">
          <button class="wr-close" type="button" aria-label="关闭想法面板" title="关闭">×</button>
          <div class="wr-title">WeRead Popular Highlights · v0.7.1</div>
          <div class="wr-status">脚本已启动。</div>

          <div class="wr-actions">
            <button class="wr-action wr-set-key">设置 / 更换 Key</button>
            <button class="wr-action wr-reload">重新读取</button>
          </div>
        </div>

        <div class="wr-list"></div>
      </div>

      <button class="wr-main-btn">WR 0.7.1</button>
    `;

    document.body.appendChild(panel);
    const closePanel = () => panel.classList.remove('open');
    panel.querySelector('.wr-close').addEventListener('click', closePanel);
    document.addEventListener('click', event => {
      if (!panel.contains(event.target)) closePanel();
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closePanel();
    });

    panel
      .querySelector('.wr-main-btn')
      .addEventListener('click', () => {
        panel.classList.toggle('open');
      });

    panel
      .querySelector('.wr-set-key')
      .addEventListener('click', () => {
        if (askAndSaveKey()) run(true);
      });

    panel
      .querySelector('.wr-reload')
      .addEventListener('click', () => {
        run(true);
      });

    return panel;
  }

  function setStatus(text, open = false) {
    const panel = ensurePanel();

    panel.querySelector('.wr-status').textContent = text;

    if (open) {
      panel.classList.add('open');
    }
  }

  function setMainButton(text) {
    ensurePanel()
      .querySelector('.wr-main-btn')
      .textContent = text;
  }

  let chapterData = null;
  let pageSignature = '';
  let pageQueued = false;
  const chapterRequests = new Map();
  const reviewRequests = new Map();

  function reviewGroupMap(data) {
    const groups = data.reviews ?? data.items;
    if (Array.isArray(groups)) return new Map(groups.filter(g => g && g.range != null).map(g => [String(g.range), g]));
    if (groups && typeof groups === 'object') return new Map(Object.entries(groups));
    throw new Error('想法返回结构暂不支持');
  }
  function countLabel(item) {
    return Number(item.count) > 0 ? `${Number(item.count).toLocaleString()} 人划线` : '热门划线';
  }
  function renderReviews(body, group) {
    body.replaceChildren();
    for (const entry of group.pageReviews.slice(0, 5)) {
      const review = entry?.review || entry;
      if (!review || typeof review.content !== 'string') continue;
      const article = document.createElement('article');
      article.className = 'wr-review';
      if (review.author?.name) {
        const author = document.createElement('strong');
        author.textContent = review.author.name;
        article.appendChild(author);
      }
      const content = document.createElement('div');
      content.className = 'wr-review-content';
      content.textContent = review.content;
      article.appendChild(content);
      body.appendChild(article);
    }
    if (!body.children.length) body.textContent = group.totalCount ? '本次未返回可展示的想法内容。' : '暂无想法。';
  }
  function fetchReviews(item, context) {
    const key = `${context.bookId}:${context.chapterUid}:${item.range}`;
    if (!reviewRequests.has(key)) {
      const request = api('/book/readreviews', {
        bookId:context.bookId, chapterUid:context.chapterUid,
        reviews:[{range:item.range,maxIdx:0,count:5,synckey:0}]
      }).then(data => {
        const group = reviewGroupMap(data).get(String(item.range));
        if (!group || !Array.isArray(group.pageReviews) || !Number.isFinite(Number(group.totalCount))) throw new Error('该范围未返回完整想法数据');
        return group;
      }).catch(error => { reviewRequests.delete(key); throw error; });
      reviewRequests.set(key, request);
    }
    return reviewRequests.get(key);
  }
  async function openReviews(item, context) {
    const panel = ensurePanel();
    const list = panel.querySelector('.wr-list');
    list.replaceChildren();
    const row = document.createElement('button');
    row.className = 'wr-item';
    const count = document.createElement('div');
    count.className = 'wr-count';
    count.textContent = countLabel(item) + ' · 点击原文定位';
    const text = document.createElement('div');
    text.className = 'wr-text';
    text.textContent = item.markText;
    row.append(count,text);
    row.addEventListener('click', async () => {
      row.disabled = true;
      try { await readerBridge.jump(item.target); }
      catch(error) { setStatus(error.message || '定位失败',true); }
      finally { row.disabled = false; }
    });
    const body = document.createElement('div');
    body.className = 'wr-reviews';
    body.textContent = '正在读取想法…';
    list.append(row,body);
    setStatus('当前划线 · 正在读取想法',true);
    try {
      const group = await fetchReviews(item,context);
      if (!body.isConnected) return;
      const total = Number(group.totalCount).toLocaleString();
      renderReviews(body,group);
      setStatus(`${countLabel(item)} · ${total} 条想法 · 首屏最多 5 条`);
    } catch(error) {
      if (!body.isConnected) return;
      body.textContent = `${error.message || '想法加载失败'}；再次点击正文划线可重试。`;
    }
  }
  function clearView() {
    readerBridge.clearPage();
    const panel = ensurePanel();
    panel.classList.remove('open');
    panel.querySelector('.wr-list').replaceChildren();
  }
  function drawLabels(page, context) {
    let root = document.getElementById('wrph-page-marks');
    if (!root) { root=document.createElement('div');root.id='wrph-page-marks';document.body.appendChild(root); }
    root.replaceChildren();
    // Preserve the full text rectangles as hit areas; only their bottom edge is visible.
    for (const item of page.marks.sort((a,b) => a.rects[0].y-b.rects[0].y || a.target.start-b.target.start)) {
      for (const rect of item.rects) {
        const hit=document.createElement('button');
        hit.className='wrph-page-hit';
        hit.title=item.markText+' · 查看想法';
        hit.setAttribute('aria-label',item.markText+' · 查看想法');
        hit.style.cssText=`left:${rect.x}px;top:${Math.max(page.top,rect.y)}px;width:${rect.w}px;height:${Math.max(0,Math.min(rect.y+rect.h,page.bottom)-Math.max(page.top,rect.y))}px`;
        hit.addEventListener('click',event=>{event.stopPropagation();openReviews(item,context);});
        root.appendChild(hit);
      }
    }
  }
  function updatePage() {
    if (!chapterData) return;
    try {
      const state=readerBridge.pageState();
      if (!state || state.bookId!==chapterData.bookId || state.chapterUid!==chapterData.chapterUid) {
        if(pageSignature){clearView();pageSignature='';} return;
      }
      if(state.signature===pageSignature)return;
      clearView();
      const page=readerBridge.paintPage(chapterData.items,chapterData,state.signature);
      if(!page)return;
      pageSignature=state.signature;
      drawLabels(page,chapterData);
      setMainButton(`本页 ${page.marks.length} 条划线`);
      setStatus(`${chapterData.title} · 本页 ${page.marks.length} 条 · 本章 ${chapterData.items.length} 条`);
    } catch(error) { setStatus(error.message || '当前页标记失败'); }
  }
  function schedulePage() {
    if(pageQueued)return;
    pageQueued=true;
    requestAnimationFrame(()=>{pageQueued=false;updatePage();});
  }
  async function run(force=false) {
    const context=readerBridge.identity();
    if(!context){setStatus('正在等待 reader 完成加载…');return;}
    if(!getKey()){setStatus('点“设置 / 更换 Key”填入 wrk-…',true);return;}
    const key=`${context.bookId}:${context.chapterUid}`;
    if(force)chapterRequests.delete(key);
    clearView();pageSignature='';chapterData=null;
    setStatus('正在获取本章 underlines…');
    try {
      if(!chapterRequests.has(key)) {
        chapterRequests.set(key,api('/book/underlines',{bookId:context.bookId,chapterUid:context.chapterUid,synckey:0}).then(data=>{
          if(!Array.isArray(data.underlines))throw new Error('underlines 返回结构不正确');
          const unique=new Map();
          for(const item of data.underlines){
            if(!item || !/^\d+-\d+$/.test(item.range))continue;
            const old=unique.get(item.range);
            if(!old||Number(item.count)>Number(old.count))unique.set(item.range,item);
          }
          return [...unique.values()];
        }).catch(error=>{chapterRequests.delete(key);throw error;}));
      }
      const items=await chapterRequests.get(key);
      const now=readerBridge.identity();
      if(!now||`${now.bookId}:${now.chapterUid}`!==key)return;
      chapterData={...context,items};
      updatePage();
    } catch(error){setStatus(error.message||'读取失败',true);setMainButton('WR Error');}
  }
  function start() {
    ensurePanel();
    if(typeof GM_registerMenuCommand==='function'){
      GM_registerMenuCommand('设置 / 更换 WeRead API Key',()=>{if(askAndSaveKey())run(true);});
      GM_registerMenuCommand('重新读取热门划线',()=>run(true));
    }
    let chapterSignature='';
    setInterval(()=>{
      const current=readerBridge.identity();
      const next=current?`${current.bookId}:${current.chapterUid}`:'';
      if(next && next!==chapterSignature){chapterSignature=next;run();}
      else schedulePage();
    },300);
    window.addEventListener('scroll',schedulePage,{passive:true,capture:true});
    window.addEventListener('resize',schedulePage,{passive:true});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedulePage();});
  }
  if(document.body)start();else window.addEventListener('DOMContentLoaded',start,{once:true});
})();
