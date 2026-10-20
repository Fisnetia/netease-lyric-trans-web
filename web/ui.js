// ============================================================================
// web/ui.js - 基础交互、Toast通知、自定义下拉框、深浅色主题、输入状态暂存
// ============================================================================

const $ = s => document.querySelector(s);
const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let STATE = {files:[], songs:[], cand:null, seq:0};

// ---- 深浅色主题切换 (View Transition 硬件级快照 + 阻尼插值)
let currentThemeDark = (document.documentElement.getAttribute('data-theme') === 'light' ? 0.0 : 1.0);
let targetThemeDark = currentThemeDark;

function applyTheme(next){
  document.documentElement.setAttribute('data-theme', next);
  try{ localStorage.setItem('ncm_theme', next); }catch(e){}
  targetThemeDark = (next === 'dark' ? 1.0 : 0.0);
  window.dispatchEvent(new CustomEvent('ncm:theme-change', { detail: { theme: next } }));
  updateThemeUi(next);
}

function initTheme(){
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  targetThemeDark = (theme === 'dark' ? 1.0 : 0.0);
  currentThemeDark = targetThemeDark;
  updateThemeUi(theme);
}

function toggleTheme(){
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';

  // 1. 优先使用现代 View Transition API（GPU 纯硬件位图快照平滑过渡，锁死高刷新率，0 次 DOM/毛玻璃多帧重绘）
  if (typeof document.startViewTransition === 'function' && 
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      !window.__LOW_POWER_MODE__) {
    document.startViewTransition(() => {
      applyTheme(next);
    });
    return;
  }

  // 降级方案：切换瞬间临时关闭 transition，避免样式闪烁
  const style = document.createElement('style');
  style.id = 'theme-transition-lock';
  style.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.appendChild(style);
  applyTheme(next);
  void document.body.offsetHeight; // 触发单次重绘
  requestAnimationFrame(() => {
    const s = document.getElementById('theme-transition-lock');
    if(s) s.remove();
  });
}
function updateThemeUi(t){
  const icon = $('#themeIcon'), lbl = $('#themeLabel');
  if(icon && lbl){
    icon.textContent = t === 'dark' ? '☀️' : '🌙';
    lbl.textContent = t === 'dark' ? '日间' : '夜间';
  }
  const dIcon = $('#dashThemeIcon'), dLbl = $('#dashThemeLabel');
  if(dIcon && dLbl){
    dIcon.textContent = t === 'dark' ? '☀️' : '🌙';
    dLbl.textContent = t === 'dark' ? '日间' : '夜间';
  }
}

// ---- 看板娘戳戳趣味互动
const AVATAR_LINES = [
  "干嘛？",
  "快去写翻译~",
  "别戳了！",
  "快去校对翻译吧~",
  "今天有要关注的新歌吗？",
  "歌词同步引擎准备就绪！",
  "哼，本小姐可不会帮你打轴哦~",
  "盯——",
  "今天也是元气满满的歌词翻译家！",
  "戳我干嘛，快看新歌呀！"
];
let bubbleTimer = null;
let lastLineIdx = -1;

function pokeAvatar(){
  const avatar = $('#brandAvatar');
  const bubble = $('#speechBubble');
  const textEl = $('#speechText');
  if(!bubble || !textEl) return;

  let idx;
  do {
    idx = Math.floor(Math.random() * AVATAR_LINES.length);
  } while(idx === lastLineIdx && AVATAR_LINES.length > 1);
  lastLineIdx = idx;

  textEl.textContent = AVATAR_LINES[idx];

  if(avatar){
    avatar.classList.remove('poked');
    void avatar.offsetWidth;
    avatar.classList.add('poked');
  }

  bubble.classList.remove('show');
  void bubble.offsetWidth;
  bubble.classList.add('show');

  if(bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(()=>{
    bubble.classList.remove('show');
  }, 2600);

  window.dispatchEvent(new CustomEvent('ncm:poke-avatar', { detail: { x: 60, y: 40 } }));
}

// ---- 自定义优雅下拉选择框系统（带向下拉出弹性微动效与自适应同步）
function enhanceCustomSelect(selectEl){
  if(!selectEl || !selectEl.parentNode || selectEl.dataset.customized === 'true') return;
  selectEl.dataset.customized = 'true';
  selectEl.classList.add('custom-select-native');
  selectEl.tabIndex = -1;
  selectEl.setAttribute('aria-hidden', 'true');

  const wrap = document.createElement('div');
  wrap.className = 'custom-select-wrap';
  if(selectEl.classList.contains('mini')) wrap.classList.add('mini');
  if(selectEl.style.width) wrap.style.width = selectEl.style.width;

  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);

  const listboxId = 'cs-list-' + Math.random().toString(36).slice(2, 9);

  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';
  trigger.tabIndex = 0;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', listboxId);

  // 复制 accessible name（优先 aria-label，次选关联 label）
  if(selectEl.getAttribute('aria-label')){
    trigger.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
  } else if(selectEl.id){
    const label = document.querySelector(`label[for="${selectEl.id}"]`);
    if(label){
      if(!label.id) label.id = 'lbl-' + selectEl.id;
      trigger.setAttribute('aria-labelledby', label.id);
    }
  }

  const triggerText = document.createElement('span');
  triggerText.className = 'custom-select-trigger-text';
  trigger.appendChild(triggerText);
  wrap.appendChild(trigger);

  const dropdown = document.createElement('div');
  dropdown.className = 'custom-select-dropdown';
  dropdown.id = listboxId;
  dropdown.setAttribute('role', 'listbox');
  wrap.appendChild(dropdown);

  function setActiveOption(item){
    dropdown.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('active'));
    if(item){
      item.classList.add('active');
      trigger.setAttribute('aria-activedescendant', item.id);
      // 仅局部滚动下拉列表内部，杜绝 scrollIntoView 导致整个外部页面视口连带颠簸
      const top = item.offsetTop;
      const bottom = top + item.offsetHeight;
      if(top < dropdown.scrollTop){
        dropdown.scrollTop = Math.max(0, top - 6);
      } else if(bottom > dropdown.scrollTop + dropdown.clientHeight){
        dropdown.scrollTop = bottom - dropdown.clientHeight + 6;
      }
    } else {
      trigger.removeAttribute('aria-activedescendant');
    }
  }

  function openDropdown(){
    // 关闭其他已展开的下拉菜单
    document.querySelectorAll('.custom-select-wrap.open').forEach(w => {
      if(w !== wrap){
        w.classList.remove('open', 'drop-up');
        const trig = w.querySelector('.custom-select-trigger');
        if(trig) trig.setAttribute('aria-expanded', 'false');
      }
    });

    // 智能视口碰撞检测：若距离屏幕底部过近且上方空间充裕，则向上弹出
    const rect = wrap.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if(spaceBelow < 250 && spaceAbove > spaceBelow){
      wrap.classList.add('drop-up');
    } else {
      wrap.classList.remove('drop-up');
    }

    wrap.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');

    const sel = dropdown.querySelector('.custom-select-option.selected')
             || dropdown.querySelector('.custom-select-option:not(.disabled)');
    if(sel){
      setActiveOption(sel);
    }
  }

  function closeDropdown(){
    wrap.classList.remove('open', 'drop-up');
    trigger.setAttribute('aria-expanded', 'false');
    dropdown.querySelectorAll('.custom-select-option').forEach(el => el.classList.remove('active'));
    trigger.removeAttribute('aria-activedescendant');
  }

  function updateTriggerAndHighlight(){
    const curIdx = selectEl.selectedIndex;
    let foundText = '';
    const optionEls = dropdown.querySelectorAll('.custom-select-option');

    // 按索引匹配当前选中项，避免同名或空选项干扰
    optionEls.forEach(item => {
      const itemIdx = parseInt(item.dataset.index, 10);
      const isMatch = itemIdx === curIdx;
      item.classList.toggle('selected', isMatch);
      item.setAttribute('aria-selected', isMatch ? 'true' : 'false');
      if(isMatch && !foundText){
        const txt = item.querySelector('.custom-select-option-text');
        foundText = txt ? txt.textContent : item.textContent;
      }
    });

    if(!foundText && selectEl.options.length > 0){
      const selOpt = selectEl.selectedOptions && selectEl.selectedOptions[0];
      if(selOpt) foundText = selOpt.textContent;
      else if(curIdx >= 0 && selectEl.options[curIdx]) foundText = selectEl.options[curIdx].textContent;
      else foundText = selectEl.options[0].textContent;
    }

    triggerText.textContent = foundText || (selectEl.options.length === 0 ? '（暂无选项）' : '请选择…');
    trigger.title = foundText || '';
    if(selectEl.disabled){
      closeDropdown(); // 展开中被异步禁用时自动收起
      wrap.classList.add('disabled');
      trigger.tabIndex = -1;
      trigger.setAttribute('aria-disabled', 'true');
    } else {
      wrap.classList.remove('disabled');
      trigger.tabIndex = 0;
      trigger.removeAttribute('aria-disabled');
    }
  }

  function rebuildOptions(){
    dropdown.innerHTML = '';
    const options = Array.from(selectEl.options);

    if(options.length === 0){
      triggerText.textContent = '（暂无选项）';
      trigger.title = '';
      updateTriggerAndHighlight();
      return;
    }

    options.forEach((opt, idx) => {
      const item = document.createElement('div');
      item.className = 'custom-select-option';
      item.id = `${listboxId}-opt-${idx}`;
      item.setAttribute('role', 'option');
      item.dataset.value = opt.value;
      item.dataset.index = idx;
      item.title = opt.textContent;

      const txt = document.createElement('span');
      txt.className = 'custom-select-option-text';
      txt.textContent = opt.textContent;
      item.appendChild(txt);

      const chk = document.createElement('span');
      chk.className = 'custom-select-check';
      chk.textContent = '✓';
      chk.setAttribute('aria-hidden', 'true');
      item.appendChild(chk);

      if(opt.disabled){
        item.classList.add('disabled');
        item.setAttribute('aria-disabled', 'true');
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if(opt.disabled) return;
        const changed = selectEl.selectedIndex !== idx;
        selectEl.selectedIndex = idx;
        if(changed){
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        updateTriggerAndHighlight();
        closeDropdown();
      });

      dropdown.appendChild(item);
    });

    updateTriggerAndHighlight();
  }

  // 绑定主动刷新接口
  selectEl._syncCustomSelect = () => rebuildOptions();

  // 初始构建
  rebuildOptions();

  // 劫持 value 与 selectedIndex 的 setter，确保 JS 赋值时实时同步
  const proto = HTMLSelectElement.prototype;
  const valDesc = Object.getOwnPropertyDescriptor(proto, 'value');
  if(valDesc && valDesc.set){
    Object.defineProperty(selectEl, 'value', {
      get(){ return valDesc.get.call(this); },
      set(val){
        valDesc.set.call(this, val);
        updateTriggerAndHighlight();
      },
      configurable: true
    });
  }

  const idxDesc = Object.getOwnPropertyDescriptor(proto, 'selectedIndex');
  if(idxDesc && idxDesc.set){
    Object.defineProperty(selectEl, 'selectedIndex', {
      get(){ return idxDesc.get.call(this); },
      set(idx){
        idxDesc.set.call(this, idx);
        updateTriggerAndHighlight();
      },
      configurable: true
    });
  }

  // MutationObserver 监听原生 select 选项子节点变化
  const obs = new MutationObserver(() => rebuildOptions());
  obs.observe(selectEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });

  // 原生 change 事件同步
  selectEl.addEventListener('change', () => updateTriggerAndHighlight());

  // 触发栏点击展开/收起
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if(selectEl.disabled) return;
    if(wrap.classList.contains('open')){
      closeDropdown();
    } else {
      openDropdown();
    }
  });

  // 键盘操作完整支持 (a11y)
  trigger.addEventListener('keydown', (e) => {
    if(selectEl.disabled) return;

    if(!wrap.classList.contains('open')){
      if(e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        openDropdown();
      }
      return;
    }

    const items = Array.from(dropdown.querySelectorAll('.custom-select-option:not(.disabled)'));
    if(!items.length) return;

    let activeIndex = items.findIndex(it => it.classList.contains('active'));
    if(activeIndex === -1){
      activeIndex = items.findIndex(it => it.classList.contains('selected'));
    }

    if(e.key === 'ArrowDown'){
      e.preventDefault();
      const nextIdx = Math.min(items.length - 1, activeIndex + 1);
      setActiveOption(items[nextIdx]);
    } else if(e.key === 'ArrowUp'){
      e.preventDefault();
      const prevIdx = Math.max(0, activeIndex - 1);
      setActiveOption(items[prevIdx]);
    } else if(e.key === 'Home'){
      e.preventDefault();
      setActiveOption(items[0]);
    } else if(e.key === 'End'){
      e.preventDefault();
      setActiveOption(items[items.length - 1]);
    } else if(e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      const target = items[activeIndex];
      if(target) target.click();
    } else if(e.key === 'Escape' || e.key === 'Tab'){
      closeDropdown();
    }
  });

  return wrap;
}

function enhanceAllCustomSelects(root = document){
  root.querySelectorAll('select:not(.custom-select-native):not(.no-custom)').forEach(enhanceCustomSelect);
}

// 全局监听点击与 Esc 自动收起
document.addEventListener('click', (e) => {
  if(!e.target.closest('.custom-select-wrap')){
    document.querySelectorAll('.custom-select-wrap.open').forEach(w => w.classList.remove('open'));
  }
});
document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape'){
    document.querySelectorAll('.custom-select-wrap.open').forEach(w => w.classList.remove('open'));
  }
});

// 全局 DOM 节点注入监听：任何动态创建的 select 自动完成向下拉出包装
const selectObserver = new MutationObserver((mutations) => {
  for(const m of mutations){
    for(const node of m.addedNodes){
      if(node.nodeType === 1){
        if(node.tagName === 'SELECT' && !node.classList.contains('custom-select-native') && !node.classList.contains('no-custom')){
          enhanceCustomSelect(node);
        } else if(node.querySelectorAll){
          node.querySelectorAll('select:not(.custom-select-native):not(.no-custom)').forEach(enhanceCustomSelect);
        }
      }
    }
  }
});
try {
  selectObserver.observe(document.body, { childList: true, subtree: true });
} catch(e){}

// ---- 刷新不丢工作：输入内容存 localStorage，F5 后自动还原
// 工作区输入状态持久化至 localStorage
const PERSIST_IDS = ['q','qArtist','lyTitle','lyId','lyTrans','lySource','ckId','ckFile'];
const PERSIST_CHECKS = ['ckAuto'];
const LS_KEY = 'ncm_gui_state_v1';

function saveUiState(){
  const o = {tab: 'home',
             fields:{}, checks:{}};
  for(const id of PERSIST_IDS){ const el=document.getElementById(id); if(el) o.fields[id]=el.value; }
  for(const id of PERSIST_CHECKS){ const el=document.getElementById(id); if(el) o.checks[id]=el.checked; }
  try{ localStorage.setItem(LS_KEY, JSON.stringify(o)); }catch(e){}
}
function restoreUiState(){
  let o = null;
  try{ o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }catch(e){ o = null; }
  if(!o) return false;
  for(const [id,v] of Object.entries(o.fields||{})){
    const el = document.getElementById(id); if(el) el.value = v;
  }
  for(const [id,v] of Object.entries(o.checks||{})){
    const el = document.getElementById(id); if(el) el.checked = !!v;
  }
  // 刷新页面后固定回到主页（不恢复历史 Tab）
  return true;
}
// 任何输入/勾选都记一笔（事件委托，省得逐个绑定）
document.addEventListener('input', e=>{
  if(e.target && (PERSIST_IDS.includes(e.target.id))) saveUiState();
});
document.addEventListener('change', e=>{
  if(e.target && (PERSIST_IDS.includes(e.target.id) || PERSIST_CHECKS.includes(e.target.id))) saveUiState();
});
// ---- 底部悬浮通知组件（支持多条平滑向上顶起堆叠，独立倒计时进度条）
function getToastContainer(){
  let c = document.getElementById('toastContainer');
  if(!c){
    c = document.createElement('div');
    c.id = 'toastContainer';
    c.className = 'toast-container';
    c.setAttribute('aria-live', 'polite');
    document.body.appendChild(c);
  }
  return c;
}

function dismissToast(toastEl){
  if(!toastEl || toastEl.dataset.dismissed) return;
  toastEl.dataset.dismissed = '1';
  if(toastEl._timer){
    clearTimeout(toastEl._timer);
    toastEl._timer = null;
  }
  toastEl.classList.remove('show');
  toastEl.classList.add('hiding');
  setTimeout(()=>{
    try { toastEl.remove(); } catch(_) {}
  }, 280);
}

function banner(msg, kind = 'info', duration = null){
  const container = getToastContainer();

  if(!msg){
    // 清除当前显示的通知
    container.querySelectorAll('.toast-banner:not(.hiding)').forEach(dismissToast);
    return;
  }

  // 限制同时展示的最大通知数（最多 4 条），多出的旧通知先平滑退出
  const existing = container.querySelectorAll('.toast-banner:not(.hiding)');
  if(existing.length >= 4){
    dismissToast(existing[0]);
  }

  const effectiveDuration = duration !== null ? duration : (kind === 'err' ? 5000 : 3200);
  const iconMap = {
    ok: '✓',
    err: '✕',
    warn: '!',
    info: 'ℹ'
  };
  const icon = iconMap[kind] || 'ℹ';

  const toast = document.createElement('div');
  toast.className = `toast-banner ${kind}`;
  toast.innerHTML = `
    <div class="toast-progress-bar"></div>
    <span class="toast-icon">${icon}</span>
    <div class="toast-msg">${msg}</div>
    <button class="toast-close" type="button" title="关闭">&times;</button>
  `;

  // 独立点击关闭
  const closeBtn = toast.querySelector('.toast-close');
  if(closeBtn){
    closeBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      dismissToast(toast);
    });
  }

  container.appendChild(toast);

  // 双帧 requestAnimationFrame 确保从 0px 展开高度，将上方的旧通知平滑向上顶起一格
  requestAnimationFrame(()=>{
    requestAnimationFrame(()=>{
      toast.classList.add('show');
      const bar = toast.querySelector('.toast-progress-bar');
      if(bar && effectiveDuration > 0){
        bar.style.transition = 'none';
        bar.style.width = '100%';
        void bar.offsetWidth; // 触发回流重绘
        bar.style.transition = `width ${effectiveDuration}ms linear`;
        bar.style.width = '0%';
      }
    });
  });

  if(effectiveDuration > 0){
    toast._timer = setTimeout(()=>{
      dismissToast(toast);
    }, effectiveDuration);
  }

  return toast;
}
async function api(path, opt){
  const r = await fetch(path, opt);
  if(!r.ok) throw new Error('HTTP '+r.status);
  return await r.json();
}

// ---- 果冻滑块驱动引擎 (Jelly Stretch Sliding Indicator)
let jellyTimer = null;
function moveTabIndicator(targetTab, immediate = false){
  const indicator = $('#tabIndicator');
  if(!indicator || !targetTab) return;

  // 1. 在任何分支前优先清除未完成的形变回正定时器，防止快速切换时异步触发导致形变异常重置
  if(jellyTimer){
    clearTimeout(jellyTimer);
    jellyTimer = null;
  }

  const targetLeft = targetTab.offsetLeft;
  const targetWidth = targetTab.offsetWidth;

  // 2. 尊重系统的减少动效设置 (Accessibility: prefers-reduced-motion)
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if(immediate || prefersReduced || indicator.style.opacity === '0' || !indicator.style.width || indicator.style.width === '0px'){
    indicator.style.transition = 'none';
    indicator.style.transformOrigin = 'center center';
    indicator.style.transform = 'scale(1, 1)';
    indicator.style.left = targetLeft + 'px';
    indicator.style.width = targetWidth + 'px';
    indicator.style.opacity = '1';
    void indicator.offsetWidth; // 强制触发重排，确保后续连贯动画生效
    return;
  }

  // 3. 使用 offsetLeft 读取当前动画中的真实物理位置（数值安全，避免 0 || ... 逻辑陷阱）
  const curLeft = indicator.offsetLeft;
  const dist = targetLeft - curLeft;

  if(Math.abs(dist) < 2){
    indicator.style.transform = 'scale(1, 1)';
    indicator.style.transition = '';
    indicator.style.left = targetLeft + 'px';
    indicator.style.width = targetWidth + 'px';
    return;
  }

  const dir = Math.sign(dist); // 1: 向右, -1: 向左
  const absDist = Math.abs(dist);

  // 4. 自然微果冻弹性拉伸（水平方向按距离微拉伸，垂直方向按二维面积守恒 squash = 1 / sqrt(stretch) 挤压）
  // 经微调最大拉伸限制在 1.09x（此时 squash 约为 0.958，兼顾 Q 弹手感与文本清晰度）
  const stretch = Math.min(1.09, 1 + absDist / 850);
  const squash = 1 / Math.sqrt(stretch);

  // 阶段 1：起步加速时沿移动方向平滑微拉伸
  indicator.style.transition = 'left 0.36s cubic-bezier(0.28, 1.15, 0.42, 1), '
                             + 'width 0.32s cubic-bezier(0.28, 1.15, 0.42, 1), '
                             + 'transform 0.35s cubic-bezier(0.28, 1.15, 0.42, 1)';
  indicator.style.transformOrigin = dir > 0 ? 'left center' : 'right center';
  indicator.style.transform = `scale(${stretch}, ${squash})`;
  indicator.style.left = targetLeft + 'px';
  indicator.style.width = targetWidth + 'px';

  // 阶段 2：抵达目标点，柔和微弹回正
  jellyTimer = setTimeout(()=>{
    indicator.style.transformOrigin = 'center center';
    indicator.style.transform = 'scale(1, 1)';
    jellyTimer = null;
  }, 160);
}

// ---- tabs 切换逻辑与无障碍支持 (a11y)
// ---- 页面头部根据当前 Tab 动态适配（切换到主页时隐藏最上方标题栏，切换到其它 Tab 恢复）
function updateHeaderForTab(tabKey, isInitial = false){
  const isHome = (tabKey === 'home');
  const wasHome = document.body.classList.contains('is-home');
  document.body.classList.toggle('is-home', isHome);

  if(isInitial || wasHome === isHome){
    if(window.Sidebar && typeof window.Sidebar.syncHeaderHeight === 'function'){
      window.Sidebar.syncHeaderHeight();
    }
    return;
  }

  // 过渡期间限制 header overflow，动画结束后恢复
  document.body.classList.add('header-transitioning');
  clearTimeout(window.__headerTransTimer);
  window.__headerTransTimer = setTimeout(() => {
    document.body.classList.remove('header-transitioning');
  }, 390);

  // 切换 Tab 时隐藏气泡
  const bubble = $('#speechBubble');
  if(bubble) bubble.classList.remove('show');

  if(window.Sidebar && typeof window.Sidebar.syncHeaderHeight === 'function'){
    window.Sidebar.syncHeaderHeight();
  }
}
window.updateHeaderForTab = updateHeaderForTab;

let paneSwitchTimer = null;
const allTabs = document.querySelectorAll('.tab');

allTabs.forEach(t=>{
  t.addEventListener('click', async ()=>{
    if(t.classList.contains('on')) return; // 已经在当前标签页，不重复过渡
    window.scrollTo(0, 0); // 切换 Tab 时重置到顶部，避免不同高度页面引起滚动条异常跳动

    const nextPane = $('#p-' + t.dataset.t);
    if(!nextPane) return; // 目标面板不存在则直接返回

    allTabs.forEach(x=>{
      x.classList.remove('on');
      x.setAttribute('aria-selected', 'false');
      x.tabIndex = -1;
    });
    t.classList.add('on');
    t.setAttribute('aria-selected', 'true');
    t.tabIndex = 0;
    moveTabIndicator(t, false); // 更新指示器位置
    updateHeaderForTab(t.dataset.t); // 动态切换最上方标题栏显隐与侧边栏高度

    // 平滑淡出旧页面，优雅淡入新页面
    const curPane = document.querySelector('.tab-pane:not(.hide)');

    if(paneSwitchTimer) clearTimeout(paneSwitchTimer);

    if(curPane && curPane !== nextPane){
      curPane.classList.add('fade-out');
      paneSwitchTimer = setTimeout(()=>{
        document.querySelectorAll('.tab-pane').forEach(s=>{
          s.classList.remove('fade-out');
          s.classList.add('hide');
        });
        if(nextPane){
          nextPane.classList.remove('hide');
        }
        paneSwitchTimer = null;
      }, 90);
    } else {
      // 快速连击 A->B->A 时兜底清除残留的 fade-out，防止页面卡在半透明隐身状态
      document.querySelectorAll('.tab-pane').forEach(s=>{
        s.classList.remove('fade-out');
        s.classList.toggle('hide', s !== nextPane);
      });
    }

    // 切换到主页时刷新概览统计数据
    if(t.dataset.t==='home'){
      if(typeof updateDashboard === 'function') updateDashboard();
      playHomeEntranceAnimation();
    }
  });
});

function playHomeEntranceAnimation(){
  const pHome = $('#p-home');
  if(!pHome) return;
  const animEls = pHome.querySelectorAll('.dash-anim-row, .dash-stat-card');
  animEls.forEach(el => {
    el.style.animation = 'none';
    void el.offsetWidth; // 强制回流以重置 CSS 动画
    el.style.animation = '';
  });
}
window.playHomeEntranceAnimation = playHomeEntranceAnimation;

// 初始化时立即同步当前选中 Tab 的指示器与 header 显隐状态（静默初始化，避免打断首屏渲染）
const initActiveTab = document.querySelector('.tab.on');
if(initActiveTab) moveTabIndicator(initActiveTab, true);
updateHeaderForTab(initActiveTab ? initActiveTab.dataset.t : 'home', true);

// ---- 主页控制台 (Dashboard) 实用业务逻辑与待办速查
function goToTab(tabName){
  const t = document.querySelector(`.tab[data-t="${tabName}"]`);
  if(t) t.click();
}
window.goToTab = goToTab;

function formatFileSize(bytes){
  if(bytes == null || isNaN(bytes)) return '-';
  if(bytes < 1024) return bytes + ' B';
  if(bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
window.formatFileSize = formatFileSize;

function goToEditorWithFile(filePath){
  if(window.LyricEditor && typeof window.LyricEditor.open === 'function'){
    window.LyricEditor.open({ filePath: filePath });
  } else if(window.Aligner && typeof window.Aligner.open === 'function'){
    window.Aligner.open({ filePath: filePath });
  }
}
window.goToEditorWithFile = goToEditorWithFile;

function goToCheckWithSong(songId, filePath){
  goToTab('check');
  const ckId = $('#ckId');
  if(ckId && songId != null){
    ckId.value = songId;
    ckId.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const ckF = $('#ckFile');
  if(ckF && filePath){
    ckF.value = filePath;
    ckF._syncCustomSelect?.();
    ckF.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
window.goToCheckWithSong = goToCheckWithSong;

function toggleLowPowerModeQuick(){
  if(window.Sidebar && typeof window.Sidebar.setLowPowerMode === 'function'){
    window.Sidebar.setLowPowerMode(!window.Sidebar.isLowPowerMode());
  } else {
    const next = !window.__LOW_POWER_MODE__;
    window.__LOW_POWER_MODE__ = next;
    document.documentElement.classList.toggle('low-power-mode', next);
    document.body?.classList.toggle('low-power-mode', next);
    try { localStorage.setItem('ncm_low_power_mode', String(next)); } catch(_) {}
    window.dispatchEvent(new CustomEvent('ncm:low-power-change', { detail: { lowPower: next } }));
  }
}
window.toggleLowPowerModeQuick = toggleLowPowerModeQuick;

// ---- 主页控制台本地系统时钟逻辑
let dashClockTimer = null;
function updateDashboardClock(){
  const tEl = $('#dashTimeText');
  const dEl = $('#dashTimeDesc');
  if(!tEl) return;
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  tEl.textContent = `${hh}:${mm}:${ss}`;

  if(dEl){
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const yyyy = now.getFullYear();
    const month = pad(now.getMonth() + 1);
    const date = pad(now.getDate());
    const dayStr = days[now.getDay()];
    dEl.textContent = `${yyyy}年${month}月${date}日 · ${dayStr}`;
  }
}

function startDashboardClock(){
  if(dashClockTimer) clearInterval(dashClockTimer);
  updateDashboardClock();
  dashClockTimer = setInterval(updateDashboardClock, 1000);
}

function copyDashboardTime(){
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const str = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(str).then(()=>{
      toast(`📋 已复制当前时间：${str}`);
    }).catch(()=>{
      toast(`🕒 当前时间：${str}`);
    });
  } else {
    toast(`🕒 当前时间：${str}`);
  }
}
window.copyDashboardTime = copyDashboardTime;
window.startDashboardClock = startDashboardClock;
window.updateDashboardClock = updateDashboardClock;
startDashboardClock();

function formatTimeAgo(ts) {
  if (!ts) return '-';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderDashboardFiles(){
  const container = $('#dashFilesTableContainer');
  if(!container) return;

  const docs = window.WorkspaceStorage ? window.WorkspaceStorage.getAll() : [];
  const clearBtn = $('#btnClearWorkspace');
  if (clearBtn) {
    clearBtn.style.display = docs.length ? 'inline-flex' : 'none';
  }

  if(!docs.length){
    container.innerHTML = `
      <div class="dash-empty-tip" style="text-align:center;padding:24px 16px;">
        <b>当前工作区暂无文稿。</b><br>
        <span style="font-size:12.5px;color:var(--dim);display:inline-block;margin-top:4px;">
          拖拽本地歌词至上方，或点击右上角「<b>导入文稿</b>」；<br>
        </span>
      </div>`;
    return;
  }

  const rows = docs.map(d => {
    const isLrc = d.type === 'lrc' || d.name.toLowerCase().endsWith('.lrc');
    const extTag = isLrc ? '<span class="dash-file-tag lrc">LRC</span>' : '<span class="dash-file-tag txt">TXT</span>';
    const timeStr = formatTimeAgo(d.mtime);
    return `<tr>
      <td>
        <div class="dash-file-cell">
          ${extTag}
          <span class="dash-file-name" title="${esc(d.name)}" style="font-weight:500;">${esc(d.name)}</span>
        </div>
      </td>
      <td>${formatFileSize(d.size)}</td>
      <td><span class="dash-file-time" title="${new Date(d.mtime || Date.now()).toLocaleString()}">${timeStr}</span></td>
      <td>
        <div class="dash-actions-cell">
          <button type="button" class="mini primary" onclick="workspaceActionAlign('${esc(d.id)}')" title="直接载入智能对轴器">⚡ 对轴</button>
          <button type="button" class="mini" onclick="workspaceActionEdit('${esc(d.id)}')" title="载入双语编辑器">✏️ 编辑</button>
          <button type="button" class="mini" onclick="window.WorkspaceStorage?.exportFile('${esc(d.id)}')" title="导出下载到电脑">💾 导出</button>
          <button type="button" class="mini danger-text" onclick="workspaceActionDelete('${esc(d.id)}')" title="从工作区删除">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="dash-table">
      <thead>
        <tr>
          <th>文稿名称</th>
          <th style="width:90px">大小</th>
          <th style="width:115px">更新时间</th>
          <th style="width:190px;text-align:right">快速操作</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}
window.renderDashboardFiles = renderDashboardFiles;

function workspaceActionAlign(id) {
  const doc = window.WorkspaceStorage?.get(id);
  if (!doc) return;
  window.Aligner?.open({
    transText: doc.content,
    fileName: doc.name,
    songId: doc.songId || ''
  });
}
window.workspaceActionAlign = workspaceActionAlign;

function workspaceActionEdit(id) {
  const doc = window.WorkspaceStorage?.get(id);
  if (!doc) return;
  window.LyricEditor?.open(doc.content);
}
window.workspaceActionEdit = workspaceActionEdit;

function workspaceActionDelete(id) {
  const doc = window.WorkspaceStorage?.get(id);
  if (!doc) return;
  if (confirm(`确定要从工作区移除《${doc.name}》吗？`)) {
    window.WorkspaceStorage?.remove(id);
    if (typeof showToast === 'function') showToast(`已移除《${doc.name}》`, 'info');
  }
}
window.workspaceActionDelete = workspaceActionDelete;


function clearWorkspaceFiles() {
  if (confirm('确定要清空工作区中所有暂存文稿吗？此操作不可撤销。')) {
    window.WorkspaceStorage?.clear();
    if (typeof showToast === 'function') showToast('已清空工作区文稿', 'info');
  }
}
window.clearWorkspaceFiles = clearWorkspaceFiles;

function setupWorkspaceDropZone() {
  const zone = $('#dashWorkspaceDropZone');
  const fileInput = $('#localWorkspaceFileInput');

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (files && files.length) {
        const count = await window.WorkspaceStorage?.importFiles(files);
        fileInput.value = '';
        if (typeof showToast === 'function') {
          showToast(`📥 成功导入 ${count} 份文稿至工作区！`, 'ok');
        }
      }
    });
  }

  if (zone) {
    ['dragenter', 'dragover'].forEach(name => {
      zone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('dragover');
      });
    });

    ['dragleave', 'dragend'].forEach(name => {
      zone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('dragover');
      });
    });

    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        const count = await window.WorkspaceStorage?.importFiles(dt.files);
        if (typeof showToast === 'function') {
          showToast(`📥 成功导入 ${count} 份文稿至工作区！`, 'ok');
        }
      }
    });
  }
}

function updateDashboard(s){
  const wsDocs = window.WorkspaceStorage ? window.WorkspaceStorage.getAll() : [];
  const fEl = $('#dashFilesCount');
  if(fEl) fEl.textContent = wsDocs.length;

  const mEl = $('#dashManuscriptsCount');
  if(mEl) mEl.textContent = wsDocs.length;

  updateDashboardClock();
  renderDashboardFiles();

  if(typeof updateThemeUi === 'function'){
    updateThemeUi(document.documentElement.getAttribute('data-theme') || 'dark');
  }
}
window.updateDashboard = updateDashboard;

window.addEventListener('ncm:workspace-change', () => {
  if(typeof updateDashboard === 'function') updateDashboard();
  if(typeof fillFileSelects === 'function') fillFileSelects();
});

window.addEventListener('ncm:low-power-change', () => {
  if(typeof updateDashboard === 'function') updateDashboard();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupWorkspaceDropZone);
} else {
  setupWorkspaceDropZone();
}

// 支持键盘左右键与 Home/End 切换 Tab (a11y)
const tabsBar = $('#tabsBar');
if(tabsBar){
  tabsBar.addEventListener('keydown', (e)=>{
    const tabs = Array.from(tabsBar.querySelectorAll('.tab'));
    const curIdx = tabs.findIndex(t=>t.classList.contains('on'));
    if(curIdx === -1) return;

    let targetIdx = -1;
    if(e.key === 'ArrowRight' || e.key === 'ArrowDown'){
      targetIdx = (curIdx + 1) % tabs.length;
    } else if(e.key === 'ArrowLeft' || e.key === 'ArrowUp'){
      targetIdx = (curIdx - 1 + tabs.length) % tabs.length;
    } else if(e.key === 'Home'){
      targetIdx = 0;
    } else if(e.key === 'End'){
      targetIdx = tabs.length - 1;
    }

    if(targetIdx !== -1){
      e.preventDefault();
      tabs[targetIdx].focus();
      tabs[targetIdx].click();
    }
  });
}

// 监听窗口缩放与容器尺寸变化，保证滑块精确对齐 (ResizeObserver & document.fonts.ready)
if(window.ResizeObserver && tabsBar){
  const ro = new ResizeObserver(()=>{
    const cur = document.querySelector('.tab.on');
    if(cur) moveTabIndicator(cur, true);
  });
  ro.observe(tabsBar);
} else {
  window.addEventListener('resize', ()=>{
    const cur = document.querySelector('.tab.on');
    if(cur) moveTabIndicator(cur, true);
  });
}

if(document.fonts && document.fonts.ready){
  document.fonts.ready.then(()=>{
    const cur = document.querySelector('.tab.on');
    if(cur) moveTabIndicator(cur, true);
  });
}

// ---- 卡片激光追光边框交互系统（单卡片事件代理 + 0 回流缓存，消除多卡片全树强制重排）
(function initCardSpotlight() {
  let activeCard = null;
  let activeRect = null;
  let moveRaf = null;
  let pendingX = 0, pendingY = 0;

  function updateRect() {
    if (activeCard) {
      activeRect = activeCard.getBoundingClientRect();
    }
  }

  // 鼠标移入时仅计算当前目标卡片尺寸并缓存
  document.addEventListener('pointerover', e => {
    const card = e.target && e.target.closest ? e.target.closest('.card') : null;
    if (card !== activeCard) {
      activeCard = card;
      activeRect = card ? card.getBoundingClientRect() : null;
      if (activeCard && activeRect) {
        const ox = e.clientX - activeRect.left;
        const oy = e.clientY - activeRect.top;
        activeCard.style.setProperty('--card-mx', `${ox}px`);
        activeCard.style.setProperty('--card-my', `${oy}px`);
      }
    }
  }, { passive: true });

  document.addEventListener('pointerout', e => {
    if (activeCard && !e.relatedTarget?.closest?.('.card')) {
      activeCard = null;
      activeRect = null;
    }
  }, { passive: true });

  document.addEventListener('pointermove', e => {
    if (window.__LOW_POWER_MODE__ || !activeCard) return;
    pendingX = e.clientX;
    pendingY = e.clientY;

    if (!moveRaf) {
      moveRaf = requestAnimationFrame(() => {
        moveRaf = null;
        if (!activeCard) return;
        if (!activeRect) updateRect();
        if (!activeRect) return;

        // 仅对当前鼠标悬停卡片更新局部相对坐标
        const ox = pendingX - activeRect.left;
        const oy = pendingY - activeRect.top;
        activeCard.style.setProperty('--card-mx', `${ox}px`);
        activeCard.style.setProperty('--card-my', `${oy}px`);
      });
    }
  }, { passive: true });

  window.addEventListener('scroll', updateRect, { passive: true });
  window.addEventListener('resize', updateRect, { passive: true });
})();
