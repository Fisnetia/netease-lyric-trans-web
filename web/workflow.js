// ============================================================================
// web/workflow.js - 核心业务工作流：歌曲检索、歌词多轨提取、通道体检、格式导出
// ============================================================================

// ---- 1. 歌曲搜索与分页
STATE.candPage = [];          // 当前页的候选
STATE.searchPage = 1;         // 第几页（从 1 开始）
STATE.searchLimit = 5;        // 每页几条
STATE.searchTotal = 0;
STATE.currentSong = null;     // 当前检视的歌曲元数据与歌词
STATE.inspectorTrack = 'orig'; // 当前检视的音轨类型: orig / trans / roman / bi

async function doSearch(){
  const q = $('#q').value.trim();
  if(!q){
    if(typeof banner === 'function') banner('请先输入歌名或歌曲 ID。', 'info');
    else $('#searchMsg').textContent = '请先输入歌名或歌曲 ID。';
    return;
  }

  // 若输入纯数字，直接按歌曲 ID 获取详情
  if(/^\d{4,12}$/.test(q)){
    $('#searchMsg').textContent = `检测到纯数字编号，正在直接拉取 ID: ${q} 的歌曲与歌词…`;
    await inspectSong(parseInt(q, 10));
    return;
  }

  STATE.searchQ = q;
  STATE.searchArtist = $('#qArtist').value.trim();
  STATE.searchPage = 1;
  await fetchCandPage(true);
}

async function goPage(n){
  if(n < 1) return;
  STATE.searchPage = n;
  await fetchCandPage(n === 1);
}

function collapseCands(){
  $('#candTbl').classList.add('hide');
  $('#pagerBox').classList.add('hide');
  $('#searchMsg').innerHTML = `已收起候选列表（共查过 ${STATE.candPage.length} 条，停在第 `
    + `${STATE.searchPage} 页）。<a href="#" onclick="expandCands();return false;">重新展开</a>`;
}

function expandCands(){
  if(!STATE.candPage.length){ doSearch(); return; }
  renderCands();
}

async function fetchCandPage(autoPick){
  $('#searchMsg').textContent = '正在检索网易云曲库…';
  const offset = (STATE.searchPage - 1) * STATE.searchLimit;
  try{
    const r = await api(`/api/search?q=${encodeURIComponent(STATE.searchQ)}`
      + `&artist=${encodeURIComponent(STATE.searchArtist)}`
      + `&limit=${STATE.searchLimit}&offset=${offset}`);
    STATE.candPage = r.candidates || [];
    STATE.searchHasMore = !!r.has_more;
    if(!STATE.candPage.length){
      if(STATE.searchPage > 1){
        $('#searchMsg').textContent = '当前页暂无更多候选，可返回上一页查看。';
        STATE.searchPage -= 1;
        return;
      }
      $('#searchMsg').textContent = '曲库中未检索到匹配曲目，请检查关键词或直接输入官方歌曲 ID 检索。';
      $('#candTbl').classList.add('hide');
      $('#pagerBox').classList.add('hide');
      return;
    }
    renderCands();
    if(autoPick) selectCand(0);
  }catch(e){
    $('#searchMsg').textContent = '搜索出错：' + e.message;
  }
}

function renderCands(){
  const tb = $('#candTbl').querySelector('tbody');
  tb.innerHTML = '';
  STATE.candPage.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.dataset.i = i;
    tr.innerHTML = `
      <td>${c.score.toFixed(3)}</td>
      <td><code>${c.id}</code></td>
      <td><b>${esc(c.name)}</b></td>
      <td>${esc((c.artists || []).join('/'))}</td>
      <td class="muted">${esc(c.album || '—')}</td>`;
    tr.onclick = () => selectCand(i);
    tb.appendChild(tr);
  });
  $('#candTbl').classList.remove('hide');
  $('#searchMsg').textContent = `第 ${STATE.searchPage} 页，共 ${STATE.candPage.length} 条候选。点击任一行即可拉取详情与歌词：`;

  const p = $('#pagerBox');
  p.classList.remove('hide');
  const prev = STATE.searchPage > 1
    ? `<button class="mini" onclick="goPage(${STATE.searchPage - 1})">← 上一页</button>`
    : `<button class="mini" disabled>← 上一页</button>`;
  const next = STATE.searchHasMore
    ? `<button class="mini" onclick="goPage(${STATE.searchPage + 1})">下一页 →</button>`
    : `<button class="mini" disabled>下一页 →</button>`;
  p.innerHTML = `
    <div class="pager-nav">
      ${prev}
      <span class="muted">第 <b>${STATE.searchPage}</b> 页</span>
      ${next}
    </div>
    <div class="pager-right">
      <div class="pager-size">
        <span>每页</span>
        <select class="no-custom" onchange="setPageSize(this.value)">
          ${[5, 10, 20].map(n => `<option value="${n}"${n === STATE.searchLimit ? ' selected' : ''}>${n} 条</option>`).join('')}
        </select>
      </div>
      <button class="mini" onclick="collapseCands()">收起列表</button>
    </div>`;
}

async function setPageSize(n){
  STATE.searchLimit = parseInt(n, 10) || 5;
  STATE.searchPage = 1;
  await fetchCandPage(true);
}

function selectCand(i){
  const c = STATE.candPage[i];
  if(!c) return;
  $('#candTbl').querySelectorAll('tr').forEach(x => x.classList.toggle('sel', +x.dataset.i === i));
  STATE.cand = c;
  inspectSong(c.id, c);
}

// ---- 2. 歌曲详情与歌词多轨检视器 (Song Inspector)
async function inspectSong(songId, optCand){
  const card = $('#songInspectorCard');
  if(!card) return;
  card.classList.remove('hide');

  // 预填初始标题与 ID
  $('#inspTitle').textContent = optCand ? optCand.name : `歌曲 #${songId}`;
  $('#inspIdBadge').textContent = `ID: ${songId}`;
  $('#inspArtists').textContent = optCand ? (optCand.artists || []).join(' / ') : '正在拉取曲目信息…';
  $('#inspAlbum').textContent = optCand ? optCand.album || '—' : '—';
  $('#inspLyricText').value = '正在拉取官方原文歌词与线上翻译…';
  $('#inspTrackLineCount').textContent = '加载中…';

  // 同步填入下方的本地草稿输入框
  if($('#lyTitle')) $('#lyTitle').value = optCand ? optCand.name : '';
  if($('#lyId')) $('#lyId').value = songId;

  try {
    const r = await api(`/api/song_lyric?songId=${encodeURIComponent(songId)}`);
    if(!r.ok){
      $('#inspLyricText').value = `拉取失败：${r.error || '未能获取到歌曲信息'}`;
      $('#inspTrackLineCount').textContent = '0 行';
      return;
    }

    STATE.currentSong = r;

    // 填充元数据
    $('#inspTitle').textContent = r.name || (optCand ? optCand.name : `歌曲 #${songId}`);
    $('#inspArtists').textContent = r.artists || (optCand ? (optCand.artists || []).join(' / ') : '未知歌手');
    $('#inspAlbum').textContent = r.album || (optCand ? optCand.album : '—');
    if($('#lyTitle')) $('#lyTitle').value = r.name || '';

    // 专辑封面图
    const imgEl = $('#inspCoverImg');
    const fbEl = $('#inspCoverFallback');
    if(r.pic_url){
      imgEl.src = r.pic_url + '?param=140y140';
      imgEl.style.display = 'block';
      if(fbEl) fbEl.style.display = 'none';
    } else {
      if(imgEl) imgEl.style.display = 'none';
      if(fbEl) fbEl.style.display = 'block';
    }

    // 状态标签
    const bOrig = $('#badgeOrig');
    if(bOrig){
      if(r.original && r.original.trim()){
        bOrig.className = 'pill ok';
        bOrig.textContent = '原文已上线';
      } else {
        bOrig.className = 'pill dim';
        bOrig.textContent = '未检索到原文';
      }
    }

    const bTrans = $('#badgeTrans');
    if(bTrans){
      if(r.has_translation){
        bTrans.className = 'pill warn';
        bTrans.textContent = '已有线上翻译';
      } else {
        bTrans.className = 'pill info';
        bTrans.textContent = '暂无翻译 (可贡献)';
      }
    }

    const bUser = $('#badgeUser');
    if(bUser){
      if(r.trans_user){
        bUser.className = 'pill dim';
        bUser.style.display = 'inline-block';
        bUser.textContent = `线上译者: ${r.trans_user}`;
      } else if(r.lyric_user){
        bUser.className = 'pill dim';
        bUser.style.display = 'inline-block';
        bUser.textContent = `词作者: ${r.lyric_user}`;
      } else {
        bUser.style.display = 'none';
      }
    }

    const bRoma = $('#badgeRoma');
    if(bRoma){
      if(r.roman && r.roman.trim()){
        bRoma.className = 'pill ok';
        bRoma.style.display = 'inline-block';
        bRoma.textContent = '含罗马音';
      } else {
        bRoma.style.display = 'none';
      }
    }

    // 顶部外链
    const linksEl = $('#inspHeaderLinks');
    if(linksEl){
      linksEl.innerHTML = `
        <a href="https://music.163.com/#/song?id=${songId}" target="_blank" rel="noopener noreferrer" class="insp-ext-link mini">🔗 网易云播放 ↗</a>
        <a href="https://music.163.com/#/wiki/song?songId=${songId}" target="_blank" rel="noopener noreferrer" class="insp-ext-link mini">🔗 百科词条 ↗</a>
      `;
    }

    // 默认展示原文（若无原文则展示现有翻译）
    const defTrack = (r.original && r.original.trim()) ? 'orig' : (r.translation ? 'trans' : 'orig');
    switchInspectorTrack(defTrack);

  } catch(e) {
    $('#inspLyricText').value = '拉取异常：' + e.message;
    $('#inspTrackLineCount').textContent = '出错';
  }
}

// 切换检视音轨
function switchInspectorTrack(track){
  STATE.inspectorTrack = track;
  const card = $('#songInspectorCard');
  if(!card || !STATE.currentSong) return;

  // 切换选项卡高亮
  const tabBtns = card.querySelectorAll('.lyric-view-tabs .mode-tab-btn');
  tabBtns.forEach(b => b.classList.remove('on'));
  const activeBtn = card.querySelector(`#btnTrack${track.charAt(0).toUpperCase() + track.slice(1)}`);
  if(activeBtn) activeBtn.classList.add('on');

  const song = STATE.currentSong;
  let text = '';

  if(track === 'orig'){
    text = song.original || '（该歌曲暂未检索到官方原文歌词）';
  } else if(track === 'trans'){
    text = song.translation || '（该歌曲暂无已发布的线上翻译歌词）';
  } else if(track === 'roman'){
    text = song.roman || '（该歌曲暂无官方罗马音歌词）';
  } else if(track === 'bi'){
    text = mergeBilingualLyrics(song.original, song.translation);
  }

  const ta = $('#inspLyricText');
  if(ta) ta.value = text;

  const count = text.trim() ? text.trim().split('\n').length : 0;
  const countEl = $('#inspTrackLineCount');
  if(countEl) countEl.textContent = `${count} 行`;
}

// 双语行合并算法
function mergeBilingualLyrics(origLrc, transLrc){
  if(!origLrc && !transLrc) return '（暂无歌词数据）';
  if(!transLrc) return origLrc || '（暂无译文）';
  if(!origLrc) return transLrc || '（暂无原文）';

  const origLines = origLrc.split('\n');
  const transLines = transLrc.split('\n');

  // 构建时间轴索引
  const timeRegex = /\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g;
  const transMap = new Map();

  transLines.forEach(line => {
    const matches = Array.from(line.matchAll(timeRegex));
    const cleanText = line.replace(timeRegex, '').trim();
    if(cleanText){
      matches.forEach(m => {
        transMap.set(m[1], cleanText);
      });
    }
  });

  const merged = [];
  origLines.forEach(line => {
    merged.push(line);
    const matches = Array.from(line.matchAll(timeRegex));
    if(matches.length > 0){
      const tKey = matches[0][1];
      if(transMap.has(tKey)){
        merged.push(`[${tKey}] ${transMap.get(tKey)}`);
      }
    }
  });

  return merged.join('\n');
}

// 快捷动作：送入对轴器
function sendInspectorToAligner(){
  if(!STATE.currentSong){
    if(typeof banner === 'function') banner('请先检索并选定一首歌曲', 'info');
    return;
  }
  const s = STATE.currentSong;
  if(window.Aligner && typeof window.Aligner.open === 'function'){
    window.Aligner.open({
      songId: s.id,
      title: s.name,
      artists: s.artists,
      sourceText: s.original || ''
    });
    if(typeof showToast === 'function') showToast(`已将《${s.name}》原文载入对轴工作台`, 'ok');
  } else {
    alert('对轴器组件就绪中，请稍候重试');
  }
}

// 快捷动作：送入双语编辑器
function sendInspectorToEditor(){
  if(!STATE.currentSong){
    if(typeof banner === 'function') banner('请先检索并选定一首歌曲', 'info');
    return;
  }
  const s = STATE.currentSong;
  if(window.LyricEditor && typeof window.LyricEditor.open === 'function'){
    window.LyricEditor.open({
      songId: s.id,
      songTitle: s.name,
      artists: s.artists,
      originalLrc: s.original || '',
      transLrc: s.translation || ''
    });
    if(typeof showToast === 'function') showToast(`已将《${s.name}》歌词载入双语编辑器`, 'ok');
  } else {
    alert('双语编辑器就绪中，请稍候重试');
  }
}

// 快捷动作：复制指定音轨歌词
function copyInspectorLyric(trackType){
  if(!STATE.currentSong) return;
  let text = '';
  const s = STATE.currentSong;
  if(trackType === 'orig') text = s.original;
  else if(trackType === 'trans') text = s.translation;
  else if(trackType === 'bi') text = mergeBilingualLyrics(s.original, s.translation);

  if(!text || !text.trim()){
    if(typeof showToast === 'function') showToast('该音轨暂无歌词内容可供复制', 'warn');
    return;
  }

  navigator.clipboard.writeText(text).then(() => {
    if(typeof showToast === 'function') showToast('歌词内容已成功复制到剪贴板！', 'ok');
    else alert('歌词已复制到剪贴板');
  }).catch(() => {
    alert('复制失败，请手动在下方文本框中全选复制');
  });
}

// 快捷动作：下载 LRC 文件
function downloadInspectorLrc(){
  if(!STATE.currentSong) return;
  const s = STATE.currentSong;
  const currentText = $('#inspLyricText').value;
  if(!currentText || !currentText.trim()){
    if(typeof showToast === 'function') showToast('当前没有歌词内容可下载', 'warn');
    return;
  }
  const filename = `${s.name || 'lyrics'} - ${s.artists || 'NCM'}.lrc`.replace(/[\\/:*?"<>|]/g, '_');
  triggerFileDownload(filename, currentText);
}

// 导出当前草稿
function downloadCurrentDraft(){
  const title = ($('#lyTitle')?.value || '').trim() || 'untitled';
  const text = ($('#lyTrans')?.value || '').trim();
  if(!text){
    if(typeof showToast === 'function') showToast('草稿译文内容为空，请先录入', 'warn');
    return;
  }
  const ext = text.includes('[00:') ? '.lrc' : '.txt';
  triggerFileDownload(`${title}${ext}`.replace(/[\\/:*?"<>|]/g, '_'), text);
}

function triggerFileDownload(filename, content){
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  if(typeof showToast === 'function') showToast(`已导出下载：${filename}`, 'ok');
}

// ---- 3. 本地草稿录入与文件解析
function bufToB64(buf){
  const b = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for(let i = 0; i < b.length; i += CH) bin += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  return btoa(bin);
}

async function loadFileInto(file, taId, infoId){
  const el = document.getElementById(infoId);
  el.textContent = `读取 ${file.name}…`;
  const buf = await file.arrayBuffer();
  try {
    const r = await api('/api/decode_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b64: bufToB64(buf) })
    });
    if(!r.ok){ el.textContent = '读取失败：' + r.error; return; }
    document.getElementById(taId).value = r.text;
    el.textContent = `${file.name} · ${r.bytes} 字节 · 编码 ${r.encoding} · ${r.lines} 行`;
  } catch(e) {
    // 降级为原生文本读取
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById(taId).value = reader.result;
      el.textContent = `${file.name} · 本地直接读取 · ${reader.result.split('\n').length} 行`;
    };
    reader.readAsText(file);
  }
}

function wireDrop(dropId, inputId, taId, infoId){
  const drop = document.getElementById(dropId), inp = document.getElementById(inputId);
  if(!drop || !inp) return;
  inp.onchange = () => { if(inp.files[0]) loadFileInto(inp.files[0], taId, infoId); };
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0]; if(f) loadFileInto(f, taId, infoId); });
}
wireDrop('dropTrans','fileTrans','lyTrans','transInfo');
wireDrop('dropSource','fileSource','lySource','sourceInfo');

function lyClear(){
  if($('#lyTrans')) $('#lyTrans').value = '';
  if($('#lySource')) $('#lySource').value = '';
  if($('#transInfo')) $('#transInfo').textContent = '';
  if($('#sourceInfo')) $('#sourceInfo').textContent = '';
  if($('#lyMsg')) $('#lyMsg').innerHTML = '';
  saveUiState();
}

async function lyLookup(){
  const id = ($('#lyId')?.value || '').trim();
  if(!id){
    if(typeof banner === 'function') banner('请先输入歌曲编号', 'warn');
    return;
  }
  try{
    const r = await api('/api/song_name?songId=' + encodeURIComponent(id));
    if(r.ok){
      if($('#lyTitle')) $('#lyTitle').value = r.name;
      $('#lyMsg').innerHTML = `<span class="muted">官方曲库歌名：${esc(r.name)}</span>`;
      await inspectSong(parseInt(id, 10));
    } else {
      $('#lyMsg').innerHTML = `<span class="pill err">查询失败</span> ${esc(r.error)}`;
    }
  }catch(e){
    $('#lyMsg').textContent = '出错：' + e.message;
  }
}

async function saveLyrics(onConflict){
  const f = document.getElementById('fileTrans')?.files?.[0];
  const body = {
    songId: ($('#lyId')?.value || '').trim() || null,
    title: ($('#lyTitle')?.value || '').trim(),
    trans: ($('#lyTrans')?.value || ''),
    source: ($('#lySource')?.value || ''),
    transExt: (f && f.name.toLowerCase().endsWith('.lrc')) ? '.lrc' : '.txt',
    onConflict: onConflict,
    artists: STATE.cand ? STATE.cand.artists : [],
  };
  if(!body.trans.trim()){
    if(typeof banner === 'function') banner('译文内容不能为空', 'warn');
    return;
  }

  if (window.WorkspaceStorage) {
    const ext = body.transExt || '.lrc';
    const title = body.title || '未命名歌词';
    const transName = `${title} 翻译${ext}`;
    window.WorkspaceStorage.save({
      name: transName,
      content: body.trans,
      songId: body.songId || ''
    });
    if (body.source && body.source.trim()) {
      window.WorkspaceStorage.save({
        name: `${title} 原文.txt`,
        content: body.source,
        songId: body.songId || ''
      });
    }
    const msg = `已保存《${transName}》至浏览器本地专属工作区`;
    $('#lyMsg').innerHTML = `<div class="banner on ok" style="margin:0 0 6px">💾 ${esc(msg)}</div>`;
    if(typeof banner === 'function') banner(msg, 'ok');
    if(typeof window.showToast === 'function') window.showToast(msg, 'ok');
    saveUiState();
    if(typeof fillFileSelects === 'function') fillFileSelects();
    if(typeof updateDashboard === 'function') updateDashboard();
    return;
  }
}

// ---- 4. 通道只读体检
function kvRows(o){ return Object.entries(o).map(([k,v]) => `<div class="k">${esc(k)}</div><div>${v}</div>`).join(''); }

async function doCheck(){
  const id = ($('#ckId')?.value || '').trim();
  const f = $('#ckFile')?.value;
  if(!id || !f){
    if(typeof banner === 'function') banner('通道体检需要指定「歌曲编号」和「中文译文文件」', 'err');
    return;
  }
  $('#ckOut').innerHTML = '<div class="muted">正在进行全流程只读检测…</div>';
  if(typeof banner === 'function') banner('');
  try{
    let doc = null;
    if(window.WorkspaceStorage){
      doc = window.WorkspaceStorage.get(f) || window.WorkspaceStorage.findByName(f);
    }
    let r;
    if(doc && doc.content){
      r = await api('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          songId: parseInt(id, 10),
          fileName: doc.name,
          trans_text: doc.content,
          autoReflow: $('#ckAuto')?.checked ? 1 : 0
        })
      });
    } else {
      if(typeof banner === 'function') banner('请在工作区选择要体检的文稿，或在主页导入文稿', 'warn');
      $('#ckOut').innerHTML = '<div class="pill warn">未找到文稿</div> 请先在主页拖拽导入或在工作区保存文稿。';
      return;
    }
    if(!r.ok){
      $('#ckOut').innerHTML = `<div class="pill err">失败</div> ${esc(r.error)}`;
      return;
    }
    renderReport('#ckOut', r.report);
  }catch(e){
    $('#ckOut').innerHTML = `<div class="pill err">出错</div> ${esc(e.message)}`;
  }
}

function renderReport(sel, rep){
  const a = rep.alignment, ch = rep.channel || {}, kt = rep.kt || {}, ck = rep.check || {};
  const chPill = ch.open ? '<span class="pill ok">通道就绪·可贡献</span>'
    : ch.has_translation ? '<span class="pill warn">已有线上译文</span>'
    : (!ch.has_original ? '<span class="pill err">原文尚未上线</span>'
    : (ch.transLyricLock && ch.transLyricLock !== 0 ? '<span class="pill err">翻译位已锁定</span>'
    : '<span class="pill dim">通道状态待确认</span>'));

  const alignPill = a.ok ? '<span class="pill ok">歌词行数匹配</span>' : '<span class="pill err">歌词行数不匹配</span>';
  const ktPill = kt.ok ? '<span class="pill ok">格式规范合格</span>' : '<span class="pill err">格式校验未通过</span>';
  const ckPill = ck.result === true ? '<span class="pill ok">官方预检接口通过</span>'
    : ck.result === false ? '<span class="pill err">官方预检接口未通过</span>'
    : '<span class="pill dim">未进行预检接口校验</span>';

  let h = `<div class="row" style="margin-bottom:8px">${alignPill}${ktPill}${ckPill}${chPill}</div>
    <div class="kv">${kvRows({
      '歌曲': esc(rep.song?.name || '') + ' / ' + esc((rep.song?.artists || []).join('/')),
      '歌曲编号': rep.song_id,
      '时长': (rep.duration_ms ? (rep.duration_ms / 1000).toFixed(1) + ' 秒' : '-'),
      '译文文件': esc(rep.file) + `（${rep.parsed.lines} 行，带时间轴=${rep.parsed.has_time}）`,
      '原文对照': rep.source_file ? esc(rep.source_file) + `（${rep.source_lines} 行）` : '未提供',
      '时间格式': rep.time_style === 'colon' ? '冒号式 [00:12:34]' : '点号式 [00:12.345]',
      '完全匹配 / 模糊匹配': `${a.exact} / ${a.fuzzy}`,
      '缺失行数 / 多余行数': `<b style="color:${a.missing || a.extra ? 'var(--err)' : 'inherit'}">${a.missing} / ${a.extra}</b>`,
      '格式检查': esc(kt.message || '规范通过'),
      '当前线上译者': esc(rep.online?.trans_user || '暂无'),
    })}</div>`;

  if(rep.reflow){
    h += `<h2 style="margin-top:14px">自动合并/拆分结果（可信度 ${rep.reflow.confidence}）</h2>`;
    h += rep.reflow.ops.length
      ? '<pre>' + esc(rep.reflow.ops.map(o => `[${o.kind}] ${o.detail}`).join('\n')) + '</pre>'
      : '<div class="muted">原文与译文行数一致，无需合并或拆分。</div>';
  }

  window._lastReportLrc = rep.trans_lrc || '';
  window._lastReportTitle = rep.song?.name || 'aligned';
  const allLines = (rep.trans_lrc || '').split('\n');
  const totalCount = allLines.length;
  h += `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;margin-bottom:6px">
    <h2 style="margin:0">对齐后译文内容 <span class="muted" style="font-size:12px;font-weight:normal">（共 ${totalCount} 行）</span></h2>
    <button type="button" class="mini primary" onclick="triggerFileDownload(window._lastReportTitle + '.lrc', window._lastReportLrc)">💾 下载此 LRC</button>
  </div>
  <pre style="max-height:360px;overflow:auto">${esc(rep.trans_lrc)}</pre>`;

  $(sel).innerHTML = h;
}

// ---- 5. 常用导航页快捷跳转
function openQuickJumpSong(){
  const input = $('#quickJumpSongId');
  const val = (input?.value || '').trim();
  if(!val){
    if(typeof showToast === 'function') showToast('请先输入歌曲编号 (Song ID)', 'warn');
    return;
  }
  window.open(`https://music.163.com/#/song?id=${val}`, '_blank', 'noopener,noreferrer');
}

function openQuickJumpWiki(){
  const input = $('#quickJumpSongId');
  const val = (input?.value || '').trim();
  if(!val){
    if(typeof showToast === 'function') showToast('请先输入歌曲编号 (Song ID)', 'warn');
    return;
  }
  window.open(`https://music.163.com/#/wiki/song?songId=${val}`, '_blank', 'noopener,noreferrer');
}
