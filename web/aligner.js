// ============================================================================
// web/aligner.js - 歌词对轴工作台
// ============================================================================
(function(window) {
  'use strict';

  let modalEl = null;
  let backdropEl = null;
  let currentResult = null;
  let currentSong = null;

  const Aligner = {
    init() {
      if (modalEl) return;

      // 1. 创建蒙层
      backdropEl = document.createElement('div');
      backdropEl.className = 'aligner-backdrop';
      backdropEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(backdropEl);

      // 2. 创建主悬浮大窗口
      modalEl = document.createElement('div');
      modalEl.className = 'aligner-modal';
      modalEl.setAttribute('role', 'dialog');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('aria-labelledby', 'alignerTitle');
      modalEl.innerHTML = this.renderTemplate();
      document.body.appendChild(modalEl);

      this.bindEvents();
      this.loadPendingFiles();

      // 3. 向侧边栏注册入口
      if (window.Sidebar) {
        window.Sidebar.register({
          id: 'aligner',
          icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 6h16M4 12h10M4 18h14"></path>
            <circle cx="18" cy="12" r="2.5" fill="currentColor"></circle>
          </svg>`,
          label: '智能对轴',
          title: '独立智能对轴工作台',
          order: 10,
          onClick: () => this.open()
        });
      }
    },

    renderTemplate() {
      return `
        <!-- 窗口顶部标题栏 -->
        <div class="aligner-header">
          <div class="aligner-title-group">
            <span class="aligner-header-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <polygon points="10 8 16 12 10 16 10 8"></polygon>
              </svg>
            </span>
            <div>
              <div class="aligner-title" id="alignerTitle">独立对轴工作台</div>
              <div class="aligner-subtitle">一键自动对轴 · 可视化手动对轴</div>
            </div>
          </div>
          <div class="aligner-header-actions">
            <div id="alSongBadge" class="al-song-badge hide"></div>
            <button type="button" class="aligner-close-btn" id="alCloseBtn" title="关闭窗口 (ESC)">✕</button>
          </div>
        </div>

        <!-- 抓取与配置栏 -->
        <div class="aligner-quickbar">
          <div class="al-fld-inline" style="flex: 1; max-width: 320px;">
            <label for="alSongId">歌曲编号</label>
            <input type="text" id="alSongId" placeholder="输入 ID，如 1951285318" />
            <button type="button" class="primary mini" id="alFetchBtn">抓取原词</button>
          </div>

          <div class="al-fld-inline" style="flex: 1.2;">
            <label for="alPickFile">从待投稿选用</label>
            <select id="alPickFile">
              <option value="">-- 选择待投稿文件 --</option>
            </select>
          </div>

          <div class="al-options-group">
            <label class="al-check-label" title="当译文与原文行数对不上时，调用字符级与跨语言启发式算法自动拆并">
              <input type="checkbox" id="alAutoReflow" checked />
              <span>自动拆并</span>
            </label>
            <div class="al-tolerance-wrap" title="时间戳容差：带轴对齐时的最大邻近匹配时间">
              <label for="alTolerance">容差</label>
              <input type="number" id="alTolerance" value="60" min="10" max="800" step="10" style="width: 58px;" />
              <span>ms</span>
            </div>
            <button type="button" class="primary" id="alRunBtn">对轴</button>
          </div>
        </div>

        <!-- 消息通知槽 -->
        <div id="alBanner" class="al-banner hide"></div>

        <!-- 工作台主体内容区 (双模式：输入录入模式 / 对齐预览模式) -->
        <div class="aligner-body">
          
          <!-- 模式切换选项卡 -->
          <div class="al-stage-tabs">
            <button type="button" class="al-stage-tab on" id="alTabInput" data-view="input">双轨文本录入</button>
            <button type="button" class="al-stage-tab" id="alTabCompare" data-view="compare">可视化对齐对比 <span id="alCompareBadge" class="pill-count hide">0</span></button>
            <button type="button" class="al-stage-tab" id="alTabLrc" data-view="lrc">完整LRC输出</button>
            <span class="al-stage-spacer"></span>
            <button type="button" class="al-subtle-btn" id="alToggleSrcBtn">📐 展开参考原文轨 (字符级同语言匹配)</button>
          </div>

          <!-- 视图 1：输入双轨 -->
          <div class="al-view al-view-input" id="alViewInput">
            <div class="al-track-col">
              <div class="al-track-header">
                <span class="al-track-tag orig">官方 / 参考原文时间轴</span>
                <span class="muted text-xs" id="alOrigCount">0 行</span>
                <button type="button" class="al-track-tool" id="alClearOrig">清空</button>
              </div>
              <textarea id="alOrigText" placeholder="在此粘贴带时间轴的官方原文 LRC，例如：&#10;[00:14.250]Hello, it's me&#10;[00:17.800]I was wondering if after all these years&#10;&#10;或在上方直接输入「歌曲编号」一键拉取。"></textarea>
            </div>

            <div class="al-track-col">
              <div class="al-track-header">
                <span class="al-track-tag trans">中文译文文本</span>
                <span class="muted text-xs" id="alTransCount">0 行</span>
                <button type="button" class="al-track-tool" id="alClearTrans">清空</button>
              </div>
              <textarea id="alTransText" placeholder="在此粘贴译文文本（纯文本或带时间轴均可）：&#10;你好，是我&#10;我想知道这么多年过去后&#10;&#10;支持直接从本地待投稿目录拖入 .txt / .lrc 文件。"></textarea>
            </div>
          </div>

          <!-- 可折叠展开的“参考原文轨” -->
          <div class="al-src-drawer hide" id="alSrcDrawer">
            <div class="al-src-header">
              <span><b>📐 参考原文 (写翻译时参考的原文)</b> <span class="muted text-xs">（与官方原文同语言的底稿文本，用于辅助对齐分行与重复段）</span></span>
              <button type="button" class="al-track-tool" id="alCloseSrc">收起</button>
            </div>
            <textarea id="alSourceText" placeholder="可选填入：翻译时对照的原文文本（无需时间轴，用于辅助对齐分行）"></textarea>
          </div>

          <!-- 视图 2：可视化逐行对齐对比看板 -->
          <div class="al-view al-view-compare hide" id="alViewCompare">
            <div class="al-compare-stats-bar" id="alCompareStats">
              <span class="muted">尚未开始对轴，请填入内容后点击「立即对轴」</span>
            </div>
            <div class="al-compare-table-wrap" id="alCompareTableWrap">
              <div class="al-compare-table" id="alCompareTable"></div>
            </div>
          </div>

          <!-- 视图 3：标准 LRC 结果预览 -->
          <div class="al-view al-view-lrc hide" id="alViewLrc">
            <div class="al-lrc-preview-header">
              <span class="muted text-xs">生成的标准网易云双向兼容格式歌词：</span>
              <button type="button" class="mini" id="alCopyLrcTop">📋 复制全部</button>
            </div>
            <textarea id="alLrcOutput" readonly placeholder="对轴成功后在此显示输出..."></textarea>
          </div>
        </div>

        <!-- 窗口底栏操作坞 -->
        <div class="aligner-footer">
          <div class="al-footer-info" id="alFooterInfo">
            <span class="status-indicator-dot"></span>
            <span id="alFooterText">对轴器就绪</span>
          </div>
          <div class="al-footer-actions">
            <button type="button" id="alBtnCopy" class="al-act-btn" disabled>📋 复制全部</button>
            <button type="button" id="alBtnSave" class="al-act-btn" disabled>💾 保存至工作区</button>
            <button type="button" id="alBtnDownload" class="al-act-btn" disabled>📥 下载 LRC</button>
            <button type="button" id="alBtnTransfer" class="al-act-btn primary" disabled>✏️ 送入双语编辑器</button>
          </div>
        </div>
      `;
    },

    bindEvents() {
      // 关闭按钮与 ESC 键
      modalEl.querySelector('#alCloseBtn').addEventListener('click', () => this.close());
      backdropEl.addEventListener('click', () => this.close());
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modalEl.classList.contains('open')) {
          this.close();
        }
      });

      // 抓取原词按钮与回车触发
      const songIdInput = modalEl.querySelector('#alSongId');
      const fetchBtn = modalEl.querySelector('#alFetchBtn');
      fetchBtn.addEventListener('click', () => {
        const sid = songIdInput.value.trim();
        if (sid) this.fetchOfficialLyric(sid);
      });
      songIdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          fetchBtn.click();
        }
      });

      // 清空按钮
      modalEl.querySelector('#alClearOrig').addEventListener('click', () => {
        modalEl.querySelector('#alOrigText').value = '';
        this.updateLineCounters();
      });
      modalEl.querySelector('#alClearTrans').addEventListener('click', () => {
        modalEl.querySelector('#alTransText').value = '';
        this.updateLineCounters();
      });

      // 文本计数监控
      modalEl.querySelector('#alOrigText').addEventListener('input', () => this.updateLineCounters());
      modalEl.querySelector('#alTransText').addEventListener('input', () => this.updateLineCounters());

      // 展开/收拢参考原文轨
      const toggleSrcBtn = modalEl.querySelector('#alToggleSrcBtn');
      const srcDrawer = modalEl.querySelector('#alSrcDrawer');
      const closeSrc = modalEl.querySelector('#alCloseSrc');
      toggleSrcBtn.addEventListener('click', () => {
        const isHidden = srcDrawer.classList.contains('hide');
        srcDrawer.classList.toggle('hide', !isHidden);
        toggleSrcBtn.classList.toggle('active', isHidden);
      });
      closeSrc.addEventListener('click', () => {
        srcDrawer.classList.add('hide');
        toggleSrcBtn.classList.remove('active');
      });

      // 视图选项卡切换
      modalEl.querySelectorAll('.al-stage-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          this.switchView(tab.dataset.view);
        });
      });

      // 立即对轴按钮
      modalEl.querySelector('#alRunBtn').addEventListener('click', () => this.doAlign());

      // 底栏操作按钮
      modalEl.querySelector('#alBtnCopy').addEventListener('click', () => this.copyLrc());
      modalEl.querySelector('#alCopyLrcTop').addEventListener('click', () => this.copyLrc());
      modalEl.querySelector('#alBtnSave').addEventListener('click', () => this.saveLrc());
      modalEl.querySelector('#alBtnDownload')?.addEventListener('click', () => this.downloadLrc());
      modalEl.querySelector('#alBtnTransfer').addEventListener('click', () => this.transferToEditor());

      // 拖拽文件到译文区支持
      const transTextarea = modalEl.querySelector('#alTransText');
      ['dragenter', 'dragover'].forEach(eventName => {
        transTextarea.addEventListener(eventName, (e) => {
          e.preventDefault();
          transTextarea.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(eventName => {
        transTextarea.addEventListener(eventName, (e) => {
          e.preventDefault();
          transTextarea.classList.remove('dragover');
        });
      });
      transTextarea.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files[0]) {
          const file = dt.files[0];
          const reader = new FileReader();
          reader.onload = (ev) => {
            transTextarea.value = ev.target.result;
            this.updateLineCounters();
            this.banner(`已读取文件：${file.name}`, 'info');
          };
          reader.readAsText(file, 'utf-8');
        }
      });

      // 本地待处理文件选择联动
      modalEl.querySelector('#alPickFile').addEventListener('change', async (e) => {
        const val = e.target.value;
        if (!val) return;
        if (val.startsWith('ws:')) {
          const docId = val.slice(3);
          const doc = window.WorkspaceStorage?.get(docId);
          if (doc && doc.content) {
            transTextarea.value = doc.content;
            this.updateLineCounters();
            this.banner(`已载入本地工作区文稿：${doc.name}`, 'info');
            return;
          }
        }
        try {
          const r = await fetch(`/api/read_file?path=${encodeURIComponent(val)}`);
          if (r.ok) {
            const data = await r.json();
            if (data && data.text) {
              transTextarea.value = data.text;
              this.updateLineCounters();
              this.banner(`已载入文稿：${data.name || val}`, 'info');
              return;
            }
          }
        } catch (_) {}
      });
    },

    updateLineCounters() {
      const orig = modalEl.querySelector('#alOrigText').value.split(/\r?\n/).filter(x => x.trim()).length;
      const trans = modalEl.querySelector('#alTransText').value.split(/\r?\n/).filter(x => x.trim()).length;
      modalEl.querySelector('#alOrigCount').textContent = `${orig} 行`;
      modalEl.querySelector('#alTransCount').textContent = `${trans} 行`;
    },

    switchView(viewName) {
      modalEl.querySelectorAll('.al-stage-tab').forEach(t => {
        t.classList.toggle('on', t.dataset.view === viewName);
      });
      modalEl.querySelector('#alViewInput').classList.toggle('hide', viewName !== 'input');
      modalEl.querySelector('#alViewCompare').classList.toggle('hide', viewName !== 'compare');
      modalEl.querySelector('#alViewLrc').classList.toggle('hide', viewName !== 'lrc');
    },

    banner(msg, type = 'info') {
      const b = modalEl.querySelector('#alBanner');
      if (!msg) {
        b.className = 'al-banner hide';
        b.textContent = '';
        return;
      }
      b.className = `al-banner ${type}`;
      b.textContent = msg;
    },

    async loadPendingFiles() {
      const sel = modalEl.querySelector('#alPickFile');
      if (!sel) return;
      const wsDocs = window.WorkspaceStorage ? window.WorkspaceStorage.getAll() : [];
      let html = '<option value="">-- 选择工作区待处理文件 --</option>';
      if (wsDocs.length) {
        html += wsDocs.map(d => `<option value="ws:${d.id}">📁 [工作区] ${d.name}</option>`).join('');
      } else {
        html += '<option value="" disabled>（工作区暂无文稿，可在主页拖拽导入）</option>';
      }
      sel.innerHTML = html;
      sel._syncCustomSelect?.();
    },

    async loadFile(filePath) {
      if (!filePath) return;
      try {
        const r = await fetch(`/api/read_file?path=${encodeURIComponent(filePath)}`);
        if (r.ok) {
          const data = await r.json();
          if (data && data.text) {
            modalEl.querySelector('#alTransText').value = data.text;
            this.updateLineCounters();
            this.banner(`已载入待投稿文件：${data.name || filePath}`, 'info');
            const sel = modalEl.querySelector('#alPickFile');
            if (sel) {
              sel.value = filePath;
              sel._syncCustomSelect?.();
            }
          }
        }
      } catch (err) {
        this.banner(`读取文件失败: ${err.message}`, 'err');
      }
    },

    open(options = {}) {
      this.init();
      this.loadPendingFiles();
      backdropEl.classList.add('open');
      modalEl.classList.add('open');

      if (options.filePath) {
        this.loadFile(options.filePath);
      }
      if (options.songId) {
        modalEl.querySelector('#alSongId').value = options.songId;
        this.fetchOfficialLyric(options.songId);
      }
      if (options.transText) {
        modalEl.querySelector('#alTransText').value = options.transText;
        this.updateLineCounters();
      }
      const origContent = options.origText || options.sourceText;
      if (origContent) {
        modalEl.querySelector('#alOrigText').value = origContent;
        this.updateLineCounters();
      }
    },

    close() {
      if (!modalEl) return;
      backdropEl.classList.remove('open');
      modalEl.classList.remove('open');
      this.banner('');
    },

    clientSideAlign(origText, transText) {
      const timeRegex = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/;
      const origLines = origText.split(/\r?\n/).filter(l => l.trim());
      const transLines = transText.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('[by:') && !l.startsWith('[ti:'));

      const parsedOrig = [];
      origLines.forEach(line => {
        const m = line.match(timeRegex);
        if (m) {
          const timeStr = m[0];
          const text = line.replace(timeRegex, '').trim();
          parsedOrig.push({ time_str: timeStr, orig_text: text });
        }
      });

      const parsedTrans = transLines.map(line => {
        return line.replace(timeRegex, '').trim();
      }).filter(Boolean);

      const pairs = [];
      const minLen = Math.min(parsedOrig.length, parsedTrans.length);
      for (let i = 0; i < parsedOrig.length; i++) {
        const o = parsedOrig[i];
        const t = i < parsedTrans.length ? parsedTrans[i] : '';
        const isBlank = !o.orig_text || o.orig_text.startsWith('-') || o.orig_text.includes('作词') || o.orig_text.includes('作曲');
        pairs.push({
          time_str: o.time_str,
          orig_text: o.orig_text,
          trans_text: t,
          is_empty_slot: isBlank,
          status: t ? 'ok' : (isBlank ? 'empty' : 'missing')
        });
      }

      const extra = [];
      if (parsedTrans.length > parsedOrig.length) {
        for (let i = parsedOrig.length; i < parsedTrans.length; i++) {
          extra.push({ time_str: null, text: parsedTrans[i] });
        }
      }

      const aligned_lrc = pairs.map(p => `${p.time_str}${p.trans_text}`).join('\n');
      return {
        ok: true,
        style_label: '自动检测 (前端即时匹配)',
        stats: {
          total_slots: parsedOrig.length,
          content_slots: parsedOrig.length,
          trans_lines: parsedTrans.length,
          matched: minLen,
          exact: minLen,
          fuzzy: 0,
          missing: Math.max(0, parsedOrig.length - parsedTrans.length),
          extra: extra.length,
          is_perfect: parsedOrig.length === parsedTrans.length
        },
        pairs,
        extra,
        missing: [],
        aligned_lrc
      };
    },

    async fetchOfficialLyric(songId) {
      this.banner('正在从网易云曲库拉取官方原文歌词...', 'info');
      try {
        const r = await fetch(`/api/song_lyric?songId=${encodeURIComponent(songId)}`);
        if (r.status === 404) {
          try {
            const rName = await fetch(`/api/song_name?songId=${encodeURIComponent(songId)}`);
            const dName = await rName.json();
            const nameStr = dName.ok ? dName.name : `歌曲 #${songId}`;
            this.banner(`已识别歌曲《${nameStr}》。提示：重启服务终端后可直接抓取原词；或直接在左侧粘贴带轴原词即可立即对轴！`, 'warn');
          } catch (_) {
            this.banner('提示：后端服务重启后可激活曲库原词一键抓取；或直接在左侧粘贴带轴原词立即对轴！', 'warn');
          }
          return;
        }

        const data = await r.json();
        if (!data.ok) {
          this.banner(`拉取原词失败：${data.error || '未知原因'}`, 'err');
          return;
        }

        currentSong = data;
        modalEl.querySelector('#alOrigText').value = data.original || '';
        this.updateLineCounters();

        // 展示歌曲胶囊信息
        const badge = modalEl.querySelector('#alSongBadge');
        badge.classList.remove('hide');
        const transTip = data.has_translation
          ? `<span class="pill-badge warn">已收录译文 (${data.trans_user || '匿名'})</span>`
          : '<span class="pill-badge ok">曲库未收录译文</span>';
        badge.innerHTML = `🎵 <b>${data.name}</b> · ${data.artists} ${transTip}`;

        this.banner(`成功抓取曲目《${data.name}》，已自动填充官方带轴原文！`, 'ok');
      } catch (e) {
        this.banner(`网络异常或请求出错：${e.message}`, 'err');
      }
    },

    async doAlign() {
      const songId = modalEl.querySelector('#alSongId').value.trim();
      const origText = modalEl.querySelector('#alOrigText').value.trim();
      const transText = modalEl.querySelector('#alTransText').value.trim();
      const sourceText = modalEl.querySelector('#alSourceText').value.trim();
      const autoReflow = modalEl.querySelector('#alAutoReflow').checked;
      const tolerance = parseInt(modalEl.querySelector('#alTolerance').value, 10) || 60;

      if (!origText && !songId) {
        this.banner('请先提供原文时间轴内容，或者填入「歌曲编号」从曲库抓取。', 'err');
        return;
      }
      if (!transText) {
        this.banner('请提供需要对齐的中文译文内容。', 'err');
        return;
      }

      this.banner('正在调用高精声学对齐算法与字符级拆并...', 'info');
      modalEl.querySelector('#alRunBtn').disabled = true;

      try {
        const r = await fetch('/api/align', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            song_id: songId || undefined,
            orig_text: origText,
            trans_text: transText,
            source_text: sourceText || undefined,
            auto_reflow: autoReflow,
            tolerance_ms: tolerance
          })
        });

        modalEl.querySelector('#alRunBtn').disabled = false;

        let data;
        if (r.status === 404) {
          // 后端尚未重启时触发零崩溃即时备选对轴引擎
          data = this.clientSideAlign(origText, transText);
        } else {
          data = await r.json();
        }

        if (!data.ok) {
          this.banner(`对轴失败：${data.error}`, 'err');
          return;
        }

        currentResult = data;
        this.renderCompareTable(data);
        modalEl.querySelector('#alLrcOutput').value = data.aligned_lrc || '';

        // 解锁底部操作
        modalEl.querySelector('#alBtnCopy').disabled = false;
        modalEl.querySelector('#alBtnSave').disabled = false;
        const dlBtn = modalEl.querySelector('#alBtnDownload');
        if (dlBtn) dlBtn.disabled = false;
        modalEl.querySelector('#alBtnTransfer').disabled = false;

        // 更新状态文字与标签
        const isPerfect = data.stats.is_perfect;
        modalEl.querySelector('#alCompareBadge').textContent = `${data.pairs.length}`;
        modalEl.querySelector('#alCompareBadge').classList.remove('hide');

        modalEl.querySelector('#alFooterText').textContent = isPerfect
          ? `对齐完成：共 ${data.stats.matched} 行，时间轴已对齐`
          : `对齐完成（匹配 ${data.stats.matched} 行，缺失 ${data.stats.missing} 行，多余 ${data.stats.extra} 行）`;

        this.banner(
          isPerfect
            ? `对轴成功，已生成标准 LRC（共 ${data.stats.matched} 行已对齐）。`
            : `对齐完成，存在行数差异（匹配 ${data.stats.matched}，缺 ${data.stats.missing}，多 ${data.stats.extra}），已在对比面板标出。`,
          isPerfect ? 'ok' : 'warn'
        );

        // 自动切到对比面板供用户查看
        this.switchView('compare');

      } catch (e) {
        modalEl.querySelector('#alRunBtn').disabled = false;
        this.banner(`对轴请求异常：${e.message}`, 'err');
      }
    },

    renderCompareTable(data) {
      const statsBar = modalEl.querySelector('#alCompareStats');
      const tableEl = modalEl.querySelector('#alCompareTable');

      const s = data.stats;
      const rate = s.total_slots > 0 ? Math.round((s.matched / s.total_slots) * 100) : 100;

      statsBar.innerHTML = `
        <div class="al-stats-chips">
          <span class="pill ${s.is_perfect ? 'ok' : 'warn'}">对齐吻合度: <b>${rate}%</b></span>
          <span class="pill dim">正文槽位: ${s.content_slots} 行</span>
          <span class="pill dim">已配对: ${s.matched} 行</span>
          <span class="pill ${s.missing > 0 ? 'err' : 'dim'}">缺失译文: ${s.missing} 行</span>
          <span class="pill ${s.extra > 0 ? 'warn' : 'dim'}">多余译文: ${s.extra} 行</span>
          <span class="pill dim">轴格式: ${data.style_label}</span>
        </div>
      `;

      let rowsHtml = '';
      data.pairs.forEach((pair, idx) => {
        const isBlankSlot = pair.is_empty_slot;
        const lineStatus = isBlankSlot ? 'slot-blank' : (pair.trans_text ? 'matched' : 'unmatched');
        const statusBadge = isBlankSlot
          ? '<span class="al-tag blank">前奏/间奏占位</span>'
          : (pair.trans_text ? '<span class="al-tag ok">✓ 对齐</span>' : '<span class="al-tag err">! 缺译</span>');

        rowsHtml += `
          <div class="al-row ${lineStatus}" data-idx="${idx}">
            <div class="al-col-num">${idx + 1}</div>
            <div class="al-col-time">
              <span class="al-time-chip" title="点击微调时间轴">${pair.time_str}</span>
            </div>
            <div class="al-col-orig" title="${pair.orig_text}">${pair.orig_text || '<span class="muted">（纯旋律）</span>'}</div>
            <div class="al-col-link">${statusBadge}</div>
            <div class="al-col-trans">
              <input type="text" 
                     class="al-line-input ${isBlankSlot ? 'muted-slot' : ''}" 
                     value="${pair.trans_text || ''}" 
                     placeholder="${isBlankSlot ? '（此行为标记占位，建议留空）' : '待填入译文...'}" />
            </div>
          </div>
        `;
      });

      // 追加多余未匹配到的译文行
      if (data.extra && data.extra.length > 0) {
        data.extra.forEach((ex, exIdx) => {
          rowsHtml += `
            <div class="al-row extra">
              <div class="al-col-num">+${exIdx + 1}</div>
              <div class="al-col-time"><span class="al-time-chip dim">--:--.---</span></div>
              <div class="al-col-orig muted">（原文此处无对应行，译文可能需要合并到上一句）</div>
              <div class="al-col-link"><span class="al-tag warn">多余行</span></div>
              <div class="al-col-trans">
                <input type="text" class="al-line-input warn" value="${ex.text || ''}" />
              </div>
            </div>
          `;
        });
      }

      tableEl.innerHTML = rowsHtml;

      // 绑定行输入联动：修改任意行译文后即时更新 LRC
      tableEl.querySelectorAll('.al-line-input').forEach(input => {
        input.addEventListener('change', () => {
          this.rebuildLrcFromInputs();
        });
      });
    },

    rebuildLrcFromInputs() {
      if (!currentResult || !currentResult.pairs) return;
      const inputs = modalEl.querySelectorAll('.al-compare-table .al-row:not(.extra) .al-line-input');
      const lines = [];
      inputs.forEach((inp, idx) => {
        const pair = currentResult.pairs[idx];
        if (pair) {
          pair.trans_text = inp.value.trim();
          lines.push(`${pair.time_str}${pair.trans_text}`);
        }
      });
      currentResult.aligned_lrc = lines.join('\n');
      modalEl.querySelector('#alLrcOutput').value = currentResult.aligned_lrc;
    },

    copyLrc() {
      if (!currentResult || !currentResult.aligned_lrc) {
        this.banner('尚无可复制的对轴结果，请先点击「立即对轴」。', 'warn');
        return;
      }
      navigator.clipboard.writeText(currentResult.aligned_lrc).then(() => {
        this.banner('✅ 已成功复制对轴后的标准 LRC 到系统剪贴板！可以直接粘贴投稿。', 'ok');
      }).catch(() => {
        const out = modalEl.querySelector('#alLrcOutput');
        out.select();
        document.execCommand('copy');
        this.banner('✅ 已复制到剪贴板！', 'ok');
      });
    },

    async saveLrc() {
      if (!currentResult || !currentResult.aligned_lrc) return;
      const songName = (currentSong && currentSong.name) || modalEl.querySelector('#alSongId').value.trim() || '未命名对轴';
      const filename = `${songName} (已对轴).lrc`.replace(/[\\/:*?"<>|]/g, '_');
      const alignedLrc = currentResult.aligned_lrc;
      const sid = currentSong ? currentSong.id : modalEl.querySelector('#alSongId').value.trim();

      // 存入浏览器本地专属工作区 (保证多用户公网隔离与持久化)
      if (window.WorkspaceStorage) {
        window.WorkspaceStorage.save({
          name: filename,
          content: alignedLrc,
          songId: sid || ''
        });
      }

      this.banner(`💾 已成功保存对轴文件至本地专属工作区：${filename}`, 'ok');
      if (typeof window.showToast === 'function') {
        window.showToast(`💾 已保存《${filename}》至本地工作区`, 'ok');
      }
      this.loadPendingFiles();
    },

    downloadLrc() {
      if (!currentResult || !currentResult.aligned_lrc) return;
      const songName = (currentSong && currentSong.name) || modalEl.querySelector('#alSongId').value.trim() || 'aligned_lyric';
      const filename = `${songName} (已对轴).lrc`.replace(/[\\/:*?"<>|]/g, '_');
      const blob = new Blob([currentResult.aligned_lrc], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (typeof window.showToast === 'function') {
        window.showToast(`已下载文件：${filename}`, 'ok');
      }
    },

    transferToEditor() {
      if (!currentResult || !currentResult.aligned_lrc) return;
      const sid = (currentSong && currentSong.id) || modalEl.querySelector('#alSongId').value.trim();
      const title = (currentSong && currentSong.name) || '';
      const alignedLrc = currentResult.aligned_lrc;
      const origLrc = currentResult.original_lrc || modalEl.querySelector('#alSourceText').value;

      this.close();

      if (window.LyricEditor && typeof window.LyricEditor.open === 'function') {
        window.LyricEditor.open({
          songId: sid,
          songTitle: title,
          originalLrc: origLrc,
          transLrc: alignedLrc
        });
      }

      if (typeof window.showToast === 'function') {
        window.showToast('🚀 已将对轴结果无缝载入双语编辑器！', 'ok');
      }
    }
  };

  // 暴露全局命名空间
  window.Aligner = Aligner;

  // DOM 就绪后自初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Aligner.init());
  } else {
    Aligner.init();
  }

})(window);
