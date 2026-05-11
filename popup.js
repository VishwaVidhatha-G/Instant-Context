let chatHistory = [];
let currentModel = "gemini-3.1-flash-lite"; 
let fallbackModel = "gemini-1.5-flash"; 
let els = {};
let urlParams = new URLSearchParams(window.location.search);
let isDetached = urlParams.get('mode') === 'detached';
let originalTabId = urlParams.get('tabId');

async function initUI() {
  document.body.classList.toggle('is-detached', isDetached);
  
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
    detachBtn: document.getElementById('detachBtn'),
    resetBtn: document.getElementById('resetSessionBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    saveBtn: document.getElementById('saveKeysBtn'),
    gInp: document.getElementById('geminiKey'),
    sInp: document.getElementById('serperKey'),
    keysPanel: document.getElementById('settingsPanel'),
    closeKeys: document.getElementById('closeSettings')
  };

  setupListeners();
  
  const sync = await chrome.storage.local.get(['chatHistory', 'geminiKey', 'serperKey', 'currentTab', 'cachedSummary', 'lastDomain']);
  
  const tab = await getContext();
  let currentDomain = "";
  if (tab && tab.url) {
    try {
      currentDomain = new URL(tab.url).hostname;
    } catch(e){}
  }

  // Session Intelligence: Check if domain changed
  if (currentDomain && sync.lastDomain && sync.lastDomain !== currentDomain) {
    chatHistory = [];
    chrome.storage.local.set({ chatHistory: [], cachedSummary: null, lastDomain: currentDomain });
    sync.chatHistory = [];
    sync.cachedSummary = null;
  } else if (currentDomain) {
    chrome.storage.local.set({ lastDomain: currentDomain });
  }

  if (sync.geminiKey) els.gInp.value = sync.geminiKey;
  if (sync.serperKey) els.sInp.value = sync.serperKey;
  if (sync.chatHistory && sync.chatHistory.length > 0) { chatHistory = sync.chatHistory; renderHistory(); }
  if (sync.cachedSummary) els.sumPane.innerHTML = formatMD(sync.cachedSummary);
  
  if (sync.currentTab === 'summary') switchTab('summary', false);
}

async function getContext() {
  if (isDetached && originalTabId) {
    try {
      const tab = await chrome.tabs.get(parseInt(originalTabId));
      if (tab) return tab;
    } catch (e) {}
  }
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const browserWin = windows.find(w => w.focused) || windows[0];
  return browserWin?.tabs.find(t => t.active);
}

async function getPageData() {
  const tab = await getContext();
  if (!tab) return { content: "", title: "" };
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { action: "getPageContent" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 4000))
    ]);
    return { content: (res.content || "").substring(0, 15000), title: tab.title || "" };
  } catch (e) { 
    return { content: "", title: tab?.title || "" }; 
  }
}

function setupListeners() {
  if (els.expandBtn) {
    els.expandBtn.onclick = async () => {
      const tab = await getContext();
      if (!tab) return;
      chrome.storage.local.set({ chatHistory, currentTab: els.chatView.classList.contains('hidden') ? 'summary' : 'chat' }, () => {
        chrome.sidePanel.setOptions({ path: 'popup.html', enabled: true });
        chrome.sidePanel.open({ tabId: tab.id });
        window.close();
      });
    };
  }

  if (els.detachBtn) {
    els.detachBtn.onclick = async () => {
      if (isDetached) {
        const tab = await getContext();
        if (tab) {
          chrome.sidePanel.setOptions({ path: 'popup.html', enabled: true });
          chrome.sidePanel.open({ tabId: tab.id });
        }
        window.close();
      } else {
        const tab = await getContext();
        chrome.windows.create({
          url: chrome.runtime.getURL(`popup.html?mode=detached&tabId=${tab?.id || ''}`),
          type: 'popup', width: 460, height: 720
        });
        setTimeout(() => window.close(), 100);
      }
    };
  }

  if (els.resetBtn) els.resetBtn.onclick = () => { if (confirm("Clear session history?")) resetSession(); };
  if (els.tabChat) els.tabChat.onclick = () => switchTab('chat', false);
  if (els.tabSum) els.tabSum.onclick = () => switchTab('summary', false);
  if (els.settingsBtn) els.settingsBtn.onclick = () => els.keysPanel.classList.remove('hidden');
  if (els.closeKeys) els.closeKeys.onclick = () => els.keysPanel.classList.add('hidden');
  
  if (els.saveBtn) {
    els.saveBtn.onclick = () => {
      chrome.storage.local.set({ 
        geminiKey: els.gInp.value.trim(), 
        serperKey: els.sInp.value.trim() 
      }, () => {
        els.keysPanel.classList.add('hidden');
        alert("Configuration Saved.");
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
  if (els.sumRefresh) els.sumRefresh.onclick = () => handleSummarize(true);
}

function switchTab(type, autoSum = false) {
  if (type === 'chat') {
    els.chatView.classList.remove('hidden'); els.sumView.classList.add('hidden');
    els.tabChat.classList.add('active'); els.tabSum.classList.remove('active');
    chrome.storage.local.set({ currentTab: 'chat' });
  } else {
    els.chatView.classList.add('hidden'); els.sumView.classList.remove('hidden');
    els.tabChat.classList.remove('active'); els.tabSum.classList.add('active');
    chrome.storage.local.set({ currentTab: 'summary' });
    if (autoSum && (els.sumPane.innerHTML.includes("Context") || els.sumPane.innerHTML.includes("baseline"))) handleSummarize(false);
  }
}

async function handleAsk() {
  const q = els.inp.value.trim();
  if (!q) return;
  
  addMessage('user', q);
  els.inp.value = '';
  setLoading(true);

  const pageData = await getPageData();
  const searchResults = await fetchSearch(q, pageData.title);

  const prompt = `
    TASK: Answer the User Question using the provided data sources. 
    You MUST output your answer STRICTLY as a list of bullet points. 
    DO NOT write any paragraphs or introductory text. Use easy, basic English. Be smart, simple, short, and clean. DO NOT sound robotic.

    CRITICAL SOURCE SEPARATION RULES:
    1. SECTION 📄 Webpage Findings: Meticulously scan the "Webpage Context". Provide the EXACT answer found on the webpage regarding the question. If the context contains names or titles relevant to the question, you MUST list them.
    2. SECTION 🌐 Live Insights: Act as a highly intelligent, context-aware chatbot (like Gemini). Provide the direct, comprehensive response utilizing your general knowledge and the "Live Internet Feed". Connect it to the user's implicit context.
    3. SECTION 💡 Final Takeaways: Synthesize both sections into a clear, definitive, and human-readable conclusion.

    STRUCTURE FORMAT TO COPY EXACTLY:
    ### 📄 Webpage Findings
    - [Bullet point]
    
    ### 🌐 Live Insights
    - [Bullet point]
    
    ### 💡 Final Takeaways
    - [Bullet point]

    Webpage Context: "${pageData.content || pageData.title}"
    Live Internet Feed: "${searchResults}"
    User Question: "${q}"
  `;
  
  const aiBubble = addMessage('ai', '...');
  let fullText = "";
  
  try {
    await streamAI(prompt, (chunk) => {
      fullText += chunk;
      updateAiMessage(aiBubble, fullText);
    }, currentModel);
  } catch (e) {
    if (e.message.includes("429") || e.message.includes("503")) {
       updateAiMessage(aiBubble, "### ⚠️ Congestion\nRetrying on stable core...");
       fullText = "";
       await streamAI(prompt, (chunk) => {
         fullText += chunk;
         updateAiMessage(aiBubble, fullText);
       }, fallbackModel);
    } else {
       updateAiMessage(aiBubble, `### ❌ Error\n${e.message}`);
    }
  }
  
  if (chatHistory.length && chatHistory[chatHistory.length - 1].role === 'ai') {
    chatHistory[chatHistory.length - 1].content = fullText;
    chrome.storage.local.set({ chatHistory });
  }
  setLoading(false);
}

async function fetchSearch(q, contextTitle) {
  const res = await chrome.storage.local.get(['serperKey']);
  if (!res.serperKey) return "Search inactive.";
  
  // Intelligent Context Augmentation
  let query = q;
  if (contextTitle && contextTitle.trim().length > 0) {
     // Clean up title slightly if needed, or just append it
     query = `${q} ${contextTitle.split('-')[0].trim()} updates news`; 
  }

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST", 
      headers: { "X-API-KEY": res.serperKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 5 })
    });
    const data = await response.json();
    return data.organic ? data.organic.map(o => o.snippet).join(' ') : "No findings.";
  } catch (e) { return "Search fail."; }
}

async function streamAI(prompt, onChunk, modelName) {
  const res = await chrome.storage.local.get(['geminiKey']);
  const key = (res.geminiKey || "").trim();
  if (!key) throw new Error("Key missing.");
  
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${key}`;
  
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  
  if (!response.ok) throw new Error(await response.text());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let start = buffer.indexOf('{');
    while (start !== -1) {
      let end = -1, depth = 0, inStr = false;
      for (let i = start; i < buffer.length; i++) {
        if (buffer[i] === '"' && buffer[i-1] !== '\\') inStr = !inStr;
        if (!inStr) {
          if (buffer[i] === '{') depth++; else if (buffer[i] === '}') depth--;
        }
        if (depth === 0) { end = i + 1; break; }
      }
      if (end !== -1) {
        try {
          const json = JSON.parse(buffer.substring(start, end));
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
        } catch (e) {}
        buffer = buffer.substring(end);
        start = buffer.indexOf('{');
      } else break;
    }
  }
}

async function handleSummarize(isManual) {
  if (!isManual) return;
  els.sumPane.innerHTML = '<div class="loader-bar"></div>';
  const pageData = await getPageData();
  const res = await chrome.storage.local.get(['geminiKey']);
  const key = (res.geminiKey || "").trim();
  if (!key) { els.sumPane.innerHTML = "Key missing."; return; }
  
  const prompt = `TASK: Summarize this page in exactly 8 high-quality bullet points. YOU MUST NOT WRITE PARAGRAPHS OR INTRODUCTORY TEXT. Start immediately with bullet points using a dash (-). Context: ${pageData.content || pageData.title}`;

  try {
    let response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    
    if (!response.ok) {
       response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${fallbackModel}:generateContent?key=${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
       });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "No summary.";
    els.sumPane.innerHTML = formatMD(text);
    chrome.storage.local.set({ cachedSummary: text });
  } catch (e) { els.sumPane.innerHTML = "Neural scan fail."; }
}

function resetSession() {
  chatHistory = [];
  chrome.storage.local.set({ chatHistory: [], cachedSummary: null });
  els.chatFlow.innerHTML = '<div class="system-msg">System Ready. Awaiting Input.</div>';
  els.sumPane.innerHTML = '<div class="system-msg">Click \'Context\' to analyze the current webpage.</div>';
}

function addMessage(role, content) {
  const group = document.createElement('div');
  group.className = `msg-group ${role === 'user' ? 'user-msg' : 'ai-msg'}`;
  
  if (role === 'ai') {
    group.innerHTML = `
      <div class="ai-header">Neural Response</div>
      <div class="ai-bubble">${formatMD(content)}</div>
    `;
  } else {
    group.innerHTML = `<div class="bubble">${content}</div>`;
  }
  
  els.chatFlow.appendChild(group);
  
  // Smart Scroll Fix: Start from the top naturally, don't force scroll past content
  requestAnimationFrame(() => {
    if (role === 'user') {
      els.chatFlow.scrollTo({ top: els.chatFlow.scrollHeight, behavior: 'smooth' });
    } else {
      // For AI, just ensure the start of the message is visible if it was offscreen,
      // but do not aggressively scroll to block: 'start' which hides the user question.
      const rect = group.getBoundingClientRect();
      const parentRect = els.chatFlow.getBoundingClientRect();
      if (rect.bottom > parentRect.bottom) {
         els.chatFlow.scrollBy({ top: 50, behavior: 'smooth' }); // Gentle nudge
      }
    }
  });
  
  chatHistory.push({ role, content });
  if (role === 'user') chrome.storage.local.set({ chatHistory });
  return role === 'ai' ? group.querySelector('.ai-bubble') : null;
}

function updateAiMessage(el, text) {
  el.innerHTML = formatMD(text);
}

function renderHistory() {
  if (!els.chatFlow) return;
  els.chatFlow.innerHTML = chatHistory.length ? '' : '<div class="system-msg">System Ready. Awaiting Input.</div>';
  chatHistory.forEach(m => addMessage(m.role, m.content));
}

function formatMD(text) {
  if (!text || text === '...' || text === 'Initializing...') return '<div class="loader-bar"></div>';
  let html = text.replace(/###\s+(.*)/g, '<div class="section-title">$1</div>')
                 .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  const lines = html.split('\n');
  let inList = false, processed = [];
  lines.forEach(line => {
    const t = line.trim();
    if (t.startsWith('- ') || t.startsWith('* ')) {
      if (!inList) { processed.push('<ul class="pillar-list">'); inList = true; }
      processed.push(`<li>${t.substring(2)}</li>`);
    } else {
      if (inList) { processed.push('</ul>'); inList = false; }
      if (t) processed.push(`<p>${t}</p>`);
    }
  });
  if (inList) processed.push('</ul>');
  return processed.join('');
}

function setLoading(val) {
  els.askBtn.disabled = val;
  if (val) {
    els.askBtn.innerHTML = '<svg class="spinner" viewBox="0 0 50 50" width="16" height="16"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5"></circle></svg>';
    els.askBtn.style.opacity = '0.5';
    els.askBtn.style.boxShadow = 'none';
  } else {
    els.askBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
    els.askBtn.style.opacity = '1';
  }
}

document.addEventListener('DOMContentLoaded', initUI);
// Updated UI and logic patterns

