// ============================================================================
// web/app.js - 应用生命周期入口：boot() 初始化与自启动协调
// ============================================================================

function fillFileSelects(){
  const ck = $('#ckFile');
  if(!ck) return;
  const keep = ck.value;
  const localDocs = window.WorkspaceStorage ? window.WorkspaceStorage.getAll() : [];
  let opts = '';
  if (localDocs.length) {
    opts = localDocs.map(d => `<option value="${esc(d.name)}">${esc(d.name)} (${(d.type || 'lrc').toUpperCase()})</option>`).join('');
  } else if (STATE.files && STATE.files.length) {
    opts = STATE.files.map(f => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('');
  }
  ck.innerHTML = opts || '<option value="">（工作区暂无文稿，可在主页拖拽导入）</option>';
  if(keep && [...ck.options].some(o => o.value === keep)) {
    ck.value = keep;
  }
  ck._syncCustomSelect?.();
}
window.fillFileSelects = fillFileSelects;

// ---- 初始化
async function boot(){
  try {
    const s = await api('/api/status');
    STATE.files = s.files || [];
    fillFileSelects();
    if(typeof updateDashboard === 'function') updateDashboard(s);
  } catch(e) {
    console.warn('Boot status fetch failed:', e);
    fillFileSelects();
    if(typeof updateDashboard === 'function') updateDashboard();
  }
}
window.boot = boot;

// ---- 页面就绪启动流程
(async ()=>{
  initTheme();
  enhanceAllCustomSelects();
  try{ await boot(); }catch(e){}
  restoreUiState();

  const curTab = document.querySelector('.tab[data-t="home"]') || document.querySelector('.tab.on') || document.querySelector('.tab');
  if(curTab){
    if(!curTab.classList.contains('on')){
      curTab.click();
    } else {
      moveTabIndicator(curTab, true);
      if(typeof updateHeaderForTab === 'function') updateHeaderForTab('home', true);
    }
  }
})();
