const DEFAULTS = {
  gemini: "", // Removed for security
  serper: ""  // Removed for security
};

let chatHistory = [];
let currentModel = "gemini-3.1-flash-lite-preview"; 
let els = {};

async function initUI() {
  els = {
    inp: document.getElementById('userInput'),
    chatFlow: document.getElementById('chatContainer'),
    sumPane: document.getElementById('summaryOutput'),
    chatView: document.getElementById('chatView'),
    sumView: document.getElementById('summaryView'),
    tabChat: document.getElementById('tabChat'),
    tabSum: document.getElementById('tabSum'),
    askBtn: document.getElementById('askBtn'),
    sumRefresh: document.getElementById('refreshSum'),
    expandBtn: document.getElementById('expandBtn'),
    resetBtn: document.getElementById('resetSessionBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    saveBtn: document.getElementById('saveKeysBtn'),
    gInp: document.getElementById('geminiKey'),
    sInp: document.getElementById('serperKey'),
    keysPanel: document.getElementById('settingsPanel'),
    closeKeys: document.getElementById('closeSettings')
  };

  setupListeners();
  
  const sync = await chrome.storage.local.get(['isExpanding', 'chatHistory', 'currentTab', 'geminiKey', 'serperKey']);
  if (sync.geminiKey && els.gInp) els.gInp.value = sync.geminiKey;
  if (sync.serperKey && els.sInp) els.sInp.value = sync.serperKey;

  if (sync.isExpanding) {
    chatHistory = sync.chatHistory || [];
    renderHistory();
    if (sync.currentTab === 'summary') switchTab('summary');
    chrome.storage.local.set({ isExpanding: false });
  } else {
    resetSession();
  }

  // TAB SWITCH DETECTION: Automatically reset if user changes pages
  chrome.tabs.onActivated.addListener(() => resetSession());
  chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete') resetSession(); });
}

function resetSession() {
  chatHistory = [];
  chrome.storage.local.set({ chatHistory: [] });
  if (els.chatFlow) els.chatFlow.innerHTML = '<div class="system-msg">Session Reset. Listening to active tab...</div>';
  if (els.sumPane) els.sumPane.innerHTML = "Not summarized.";
}

function setupListeners() {
  if (els.expandBtn && window.innerWidth > 450) {
    els.expandBtn.textContent = '↙';
    els.expandBtn.title = 'Close Sidebar';
    els.expandBtn.onclick = () => window.close();
  } else if (els.expandBtn) {
    els.expandBtn.onclick = () => {
      chrome.storage.local.set({ 
        isExpanding: true, 
        chatHistory: chatHistory,
        currentTab: els.chatView.classList.contains('hidden') ? 'summary' : 'chat'
      }, () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          chrome.sidePanel.setOptions({ path: 'popup.html', enabled: true });
          chrome.sidePanel.open({ tabId: tabs[0].id });
          setTimeout(() => window.close(), 100);
        });
      });
    };
  }

  if (els.resetBtn) els.resetBtn.onclick = () => { if (confirm("Reset current session?")) resetSession(); };
  if (els.tabChat) els.tabChat.onclick = () => switchTab('chat');
  if (els.tabSum) els.tabSum.onclick = () => switchTab('summary');
  if (els.settingsBtn) els.settingsBtn.onclick = () => els.keysPanel.classList.toggle('hidden');
  if (els.closeKeys) els.closeKeys.onclick = () => els.keysPanel.classList.add('hidden');
  
  if (els.saveBtn) {
    els.saveBtn.onclick = () => {
      chrome.storage.local.set({ geminiKey: els.gInp.value, serperKey: els.sInp.value }, () => {
        els.keysPanel.classList.add('hidden');
        alert("Saved.");
      });
    };
  }

  if (els.inp) {
    els.inp.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAsk();
      }
    };
  }
  if (els.askBtn) els.askBtn.onclick = handleAsk;
  if (els.sumRefresh) els.sumRefresh.onclick = handleSummarize;
}

function switchTab(type) {
  if (type === 'chat') {
    els.chatView.classList.remove('hidden'); els.sumView.classList.add('hidden');
    els.tabChat.classList.add('active'); els.tabSum.classList.remove('active');
  } else {
    els.chatView.classList.add('hidden'); els.sumView.classList.remove('hidden');
    els.tabChat.classList.remove('active'); els.tabSum.classList.add('active');
  }
}

async function getPageData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "getPageContent" });
    return { content: (res.content || "").substring(0, 5000), title: tab.title || "" };
  } catch (e) { return { content: "N/A", title: "N/A" }; }
}

async function handleAsk() {
  const q = els.inp.value.trim();
  if (!q) return;
  addMessage('user', q);
  els.inp.value = '';
  setLoading(true);

  const { content, title } = await getPageData();
  const searchResults = await fetchSearch(q, title);

  const prompt = `
    Analyze: "${q}"
    
    ### WEBPAGE FINDINGS
    ${content}
    
    ### INTERNET FINDINGS
    ${searchResults}
    
    REQUIRED FORMAT:
    ### WEBPAGE FINDINGS
    - Points only.
    
    ### INTERNET FINDINGS
    - Points only. Highlight news.
    
    ### FINAL VERDICT
    - Bullet points only. Summary of situation.
  `;
  const response = await callAI(prompt);
  addMessage('ai', response);
  setLoading(false);
}

async function fetchSearch(q, title) {
  const res = await chrome.storage.local.get(['serperKey']);
  const key = res.serperKey || DEFAULTS.serper;
  if (!key) return "Error: Serper API Key missing. Please set it in Settings (⚙).";
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${title} ${q}`, num: 3 })
    });
    const data = await response.json();
    return data.organic ? data.organic.map(o => o.snippet).join(' ') : "No search data found.";
  } catch (e) { return "Search Error."; }
}

async function callAI(prompt, retry = 0) {
  const res = await chrome.storage.local.get(['geminiKey']);
  const key = res.geminiKey || DEFAULTS.gemini;
  if (!key) return "Error: Gemini API Key missing. Please set it in Settings (⚙).";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${key}`;
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    if (data.error) {
      if (data.error.message.includes("high demand") && retry < 2) {
        await new Promise(r => setTimeout(r, 2000));
        return callAI(prompt, retry + 1);
      }
      return `AI Error: ${data.error.message}`;
    }
    return data.candidates[0].content.parts[0].text;
  } catch (e) { return "Error."; }
}

async function handleSummarize() {
  switchTab('summary');
  els.sumPane.innerHTML = "Summarizing (6-12 points)...";
  const { content } = await getPageData();
  // STRICTOR PROMPT: No intro text allowed
  const response = await callAI(`Provide a factual 6 to 12 point bulleted summary. START DIRECTLY WITH BULLET POINTS. NO INTRODUCTORY TEXT: ${content}`);
  els.sumPane.innerHTML = formatMD(response);
}

function addMessage(role, content) {
  chatHistory.push({ role, content });
  const group = document.createElement('div');
  group.className = 'msg-group';
  group.innerHTML = `
    <div class="label">${role === 'user' ? 'You' : 'Instant Context'}</div>
    <div class="text ${role === 'ai' ? 'ai-text' : ''}">${role === 'ai' ? formatMD(content) : content}</div>
  `;
  els.chatFlow.appendChild(group);
  group.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHistory() {
  els.chatFlow.innerHTML = '';
  chatHistory.forEach(m => {
    const group = document.createElement('div');
    group.className = 'msg-group';
    group.innerHTML = `
      <div class="label">${m.role === 'user' ? 'You' : 'Instant Context'}</div>
      <div class="text ${m.role === 'ai' ? 'ai-text' : ''}">${m.role === 'ai' ? formatMD(m.content) : m.content}</div>
    `;
    els.chatFlow.appendChild(group);
  });
  els.chatFlow.scrollTop = els.chatFlow.scrollHeight;
}

function formatMD(text) {
  return text
    .replace(/###\s*(.*)/gi, '<span class="section-header">$1</span>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[\*\-]\s*(.*)/gm, '<li>$1</li>');
}

function setLoading(val) {
  els.askBtn.disabled = val;
  els.askBtn.textContent = val ? "..." : "Ask Context";
}

document.addEventListener('DOMContentLoaded', initUI);
