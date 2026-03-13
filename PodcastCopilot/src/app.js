/* ================================================
   PodcastCopilot — app.js  (Groq / static build)
   ================================================ */

const GROQ_URL        = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_WHISPER    = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT_MODEL = "llama-3.1-8b-instant";
const GROQ_STT_MODEL  = "whisper-large-v3-turbo";

const WINDOW_MS       = 2 * 60 * 1000;
const ANALYZE_EVERY   = 20_000;
const TOPIC_EXPIRY_MS = 10 * 60 * 1000;
const EXPIRY_TICK_MS  = 1_000;
const CHUNK_MS        = 8_000;   // audio chunk size sent to Whisper

const QUESTION_PATTERNS = [
  /\b(how does|how do|how is|how are|why does|why do|why is|what is|what are|what was|who is|when did|where does)\b/i,
  /\b(i don'?t know|no idea|i never (knew|understood)|i always wondered|i wonder|do you know|have you heard)\b/i,
  /\b(tell me (more|about)|explain|i'?m curious|interesting)\b/i,
  /\b(hogyan|miért|mi az|mi a|ki az|mikor|hol|hogy működik)\b/i,
  /\b(nem tudom|fogalmam sincs|sosem értettem|mindig kíváncsi|érdekes|tudod-e|hallottad)\b/i,
];

const ANALYZE_SYSTEM = `You are a real-time research assistant for a podcast host.
You receive a rolling transcript of the last ~2 minutes of conversation.

Your job is to detect ANY of the following — be generous, err on the side of detection:

ALWAYS detect:
- Any direct question: "how does X work?", "what is X?", "why does X happen?", "do you know X?"
- Expressed ignorance: "I don't know", "I have no idea", "I never understood", "I always wondered"
- Guest saying they don't know: "no idea", "not sure", "I haven't looked into it"
- Curiosity phrases: "I wonder", "interesting, I didn't know that", "tell me more about"
- Factual claims that could use a source: "apparently X does Y", "I heard that..."

Hungarian equivalents (detect ALL of these):
- "nem tudom", "fogalmam sincs", "nem értem", "sosem értettem"
- "mindig kíváncsi voltam", "érdekes", "hogy működik", "mi az hogy"
- "tudod-e hogy", "hallottad már hogy", "szerinted miért"
- Any sentence ending with "?" in the transcript

When in doubt — include it. It is better to show a button the host doesn't need than to miss one they do.

For each detected topic, return JSON. Match label language to the conversation (HU or EN).

Return ONLY valid JSON with no extra text:
{
  "topics": [
    {
      "label": "Short topic label (2-5 words)",
      "question": "The specific question or knowledge gap detected",
      "answer": "A clear, concise answer in 3-5 sentences.",
      "sources": [
        {"title": "Source name", "url": "https://..."},
        {"title": "Source name", "url": "https://..."}
      ]
    }
  ]
}

If truly nothing resembling a question or uncertainty exists, return: {"topics": []}
Maximum 3 topics per response. Prioritise the most recent ones.`;

const SUMMARIZE_SYSTEM = `You are summarizing an older portion of a podcast transcript to preserve context.
Write a concise summary (3-6 sentences) capturing the key topics discussed, any conclusions reached, and the general flow of conversation.
Match the language of the transcript (Hungarian or English).
Return only the summary text, no extra formatting.`;

// ── API key management ─────────────────────────────────────────────────────────
const LS_KEY = "podcastcopilot_groq_key";
function getApiKey() { return localStorage.getItem(LS_KEY) || ""; }
function saveApiKey(k) { localStorage.setItem(LS_KEY, k.trim()); }

// ── State ─────────────────────────────────────────────────────────────────────
let isListening   = false;
let selectedLang  = "hu-HU";
let analyzeTimer      = null;
let expiryTimer       = null;
let quickTriggerTimer = null;
let audioStream       = null;
let chunkTimer        = null;
let audioCtx          = null;
let animFrameId       = null;

let liveLines     = [];
let archivedText  = "";
let summaryText   = "";
let pendingArchive = false;
let topics = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const onboardingOverlay = document.getElementById("onboarding-overlay");
const onboardingClose   = document.getElementById("onboarding-close");
const apiKeyInput       = document.getElementById("api-key-input");
const saveKeyBtn        = document.getElementById("save-key-btn");
const changeKeyBtn      = document.getElementById("change-key-btn");
const statusDot       = document.getElementById("status-dot");
const statusText      = document.getElementById("status-text");
const startBtn        = document.getElementById("start-btn");
const stopBtn         = document.getElementById("stop-btn");
const transcriptLines = document.getElementById("transcript-lines");
const interimLine     = document.getElementById("interim-line");
const transcriptEmpty = document.getElementById("transcript-empty");
const topicsList      = document.getElementById("topics-list");
const topicsEmpty     = document.getElementById("topics-empty");
const topicCount      = document.getElementById("topic-count");
const summaryBlock    = document.getElementById("summary-block");
const summaryTextEl   = document.getElementById("summary-text");
const deleteSummary   = document.getElementById("delete-summary");
const clearTranscript = document.getElementById("clear-transcript");
const clearTopicsBtn  = document.getElementById("clear-topics");
const langBtns        = document.querySelectorAll(".lang-btn");
const resizeHandle    = document.getElementById("resize-handle");
const layout          = document.querySelector(".layout");
const voiceBars       = document.getElementById("voice-bars");
const voiceBarEls     = voiceBars.querySelectorAll(".voice-bar");

// ── Onboarding overlay ────────────────────────────────────────────────────────
function initOnboarding() {
  if (getApiKey()) {
    onboardingOverlay.classList.add("hidden");
  } else {
    onboardingOverlay.classList.remove("hidden");
    onboardingClose.classList.add("hidden");
    setTimeout(() => apiKeyInput.focus(), 100);
  }
}

saveKeyBtn.addEventListener("click", () => {
  const val = apiKeyInput.value.trim();
  if (!val.startsWith("gsk_")) {
    apiKeyInput.style.borderColor = "var(--red)";
    apiKeyInput.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.2)";
    return;
  }
  saveApiKey(val);
  onboardingOverlay.classList.add("hidden");
  onboardingClose.classList.add("hidden");
  apiKeyInput.value = "";
  apiKeyInput.style.borderColor = "";
  apiKeyInput.style.boxShadow = "";
  setStatus("idle", "Ready");
});

apiKeyInput.addEventListener("keydown", e => {
  if (e.key === "Enter") saveKeyBtn.click();
  apiKeyInput.style.borderColor = "";
  apiKeyInput.style.boxShadow = "";
});

changeKeyBtn.addEventListener("click", () => {
  onboardingOverlay.classList.remove("hidden");
  onboardingClose.classList.remove("hidden");
  apiKeyInput.focus();
});

onboardingClose.addEventListener("click", () => {
  onboardingOverlay.classList.add("hidden");
});

initOnboarding();

// ── Resizable transcript panel ────────────────────────────────────────────────
let isResizing = false;

resizeHandle.addEventListener("mousedown", e => {
  isResizing = true;
  resizeHandle.classList.add("dragging");
  document.body.style.cursor    = "col-resize";
  document.body.style.userSelect = "none";
  e.preventDefault();
});

document.addEventListener("mousemove", e => {
  if (!isResizing) return;
  const rect     = layout.getBoundingClientRect();
  const newWidth = Math.max(180, Math.min(600, e.clientX - rect.left));
  layout.style.gridTemplateColumns = `${newWidth}px 6px 1fr`;
});

document.addEventListener("mouseup", () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove("dragging");
  document.body.style.cursor     = "";
  document.body.style.userSelect = "";
});

// ── Language toggle ───────────────────────────────────────────────────────────
langBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    langBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedLang = btn.dataset.lang;
    if (isListening) { stopListening(); startListening(); }
  });
});

// ── Start / Stop ──────────────────────────────────────────────────────────────
startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click",  stopListening);

async function startListening() {
  if (!getApiKey()) {
    onboardingOverlay.classList.remove("hidden");
    onboardingClose.classList.add("hidden");
    apiKeyInput.focus();
    return;
  }

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus("error", "Microphone access denied.");
    return;
  }

  isListening = true;
  startBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");
  transcriptEmpty.classList.add("hidden");
  setStatus("listening", "Listening…");

  // Voice level visualizer
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.75;
  audioCtx.createMediaStreamSource(audioStream).connect(analyser);
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const barMults = [0.6, 1.0, 0.85, 0.55];
  voiceBars.classList.remove("hidden");
  (function animBars() {
    animFrameId = requestAnimationFrame(animBars);
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    const n = Math.floor(freqData.length / 2);
    for (let i = 0; i < n; i++) sum += freqData[i];
    const vol = sum / (n * 255);
    voiceBarEls.forEach((bar, i) => {
      const h = Math.max(2, vol * 22 * barMults[i] * (0.8 + Math.random() * 0.4));
      bar.style.height = `${h}px`;
    });
  })();

  scheduleAnalyze();
  startExpiryTicker();
  recordChunk();
}

function stopListening() {
  isListening = false;
  clearTimeout(chunkTimer);
  clearTimeout(analyzeTimer);
  clearInterval(expiryTimer);
  audioStream?.getTracks().forEach(t => t.stop());
  audioStream = null;
  cancelAnimationFrame(animFrameId);
  animFrameId = null;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  voiceBars.classList.add("hidden");
  voiceBarEls.forEach(b => b.style.height = "2px");
  startBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  interimLine.textContent = "";
  setStatus("idle", "Stopped");
}

// ── Audio recording loop ──────────────────────────────────────────────────────
function recordChunk() {
  if (!isListening || !audioStream) return;

  const chunks = [];
  const mr = new MediaRecorder(audioStream);

  mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  mr.onstop = async () => {
    if (!chunks.length) return;
    const mimeType = mr.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });
    try {
      // Show a subtle "transcribing" indicator in the interim line
      interimLine.textContent = "…";
      const text = await groqTranscribe(blob, mimeType);
      interimLine.textContent = "";
      if (text && text.trim()) addLine(text.trim());
    } catch (e) {
      interimLine.textContent = "";
      console.warn("Transcribe failed:", e);
    }
  };

  mr.start();
  chunkTimer = setTimeout(() => {
    if (mr.state === "recording") mr.stop();
    recordChunk(); // start next chunk immediately
  }, CHUNK_MS);
}

// ── Groq Whisper ──────────────────────────────────────────────────────────────
async function groqTranscribe(blob, mimeType) {
  const key  = getApiKey();
  const lang = selectedLang === "hu-HU" ? "hu" : "en";
  const ext  = mimeType.includes("webm") ? "webm"
             : mimeType.includes("mp4")  ? "mp4"
             : mimeType.includes("ogg")  ? "ogg"
             : "wav";

  const form = new FormData();
  form.append("file",            blob, `audio.${ext}`);
  form.append("model",           GROQ_STT_MODEL);
  form.append("language",        lang);
  form.append("response_format", "json");

  const res = await fetch(GROQ_WHISPER, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${key}` },
    body:    form,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.text || "";
}

// ── Groq Chat ─────────────────────────────────────────────────────────────────
async function groqChat(system, userMsg, maxTokens = 1024, jsonMode = false) {
  const key = getApiKey();
  if (!key) throw new Error("No API key set");

  const body = {
    model:    GROQ_CHAT_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: userMsg },
    ],
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const res = await fetch(GROQ_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ── Transcript management ─────────────────────────────────────────────────────
function addLine(text) {
  if (!text) return;
  const now = Date.now();
  liveLines.push({ text, timestamp: now });

  const div = document.createElement("div");
  div.className = "transcript-line fresh";
  div.textContent = text;
  transcriptLines.appendChild(div);
  scrollTranscript();

  archiveOldLines();

  const looksLikeQuestion = QUESTION_PATTERNS.some(p => p.test(text)) || text.trim().endsWith("?");
  if (looksLikeQuestion) {
    clearTimeout(quickTriggerTimer);
    quickTriggerTimer = setTimeout(async () => {
      clearTimeout(analyzeTimer);
      await runAnalysis();
      scheduleAnalyze();
    }, 2500);
  }
}

function archiveOldLines() {
  const cutoff = Date.now() - WINDOW_MS;
  const old = liveLines.filter(l => l.timestamp < cutoff);
  if (old.length === 0) return;

  liveLines = liveLines.filter(l => l.timestamp >= cutoff);
  archivedText += " " + old.map(l => l.text).join(" ");

  const allNodes = transcriptLines.querySelectorAll(".transcript-line");
  const toRemove = allNodes.length - liveLines.length;
  for (let i = 0; i < toRemove; i++) transcriptLines.firstChild?.remove();

  transcriptLines.querySelectorAll(".transcript-line").forEach((el, idx) => {
    el.classList.toggle("fresh", idx >= transcriptLines.children.length - 3);
  });

  if (archivedText.trim().length > 100 && !pendingArchive) {
    pendingArchive = true;
    summarizeArchived();
  }
}

async function summarizeArchived() {
  try {
    const toSummarize = archivedText.trim();
    archivedText = "";
    const text = await groqChat(SUMMARIZE_SYSTEM, toSummarize, 512, false);
    if (text) {
      summaryText = summaryText ? summaryText + " " + text : text;
      renderSummary();
    }
  } catch (e) {
    console.warn("Summarize failed:", e);
  } finally {
    pendingArchive = false;
  }
}

function renderSummary() {
  if (!summaryText) { summaryBlock.classList.add("hidden"); return; }
  summaryTextEl.textContent = summaryText;
  summaryBlock.classList.remove("hidden");
}

deleteSummary.addEventListener("click", () => {
  summaryText = "";
  summaryBlock.classList.add("hidden");
});

clearTopicsBtn.addEventListener("click", () => {
  topics.forEach(t => t.wrapper.remove());
  topics = [];
  updateTopicCount();
  topicsEmpty.classList.remove("hidden");
});

clearTranscript.addEventListener("click", () => {
  liveLines = [];
  archivedText = "";
  summaryText = "";
  transcriptLines.innerHTML = "";
  interimLine.textContent = "";
  summaryBlock.classList.add("hidden");
  if (!isListening) transcriptEmpty.classList.remove("hidden");
});

function scrollTranscript() {
  const el = document.getElementById("transcript-scroll");
  el.scrollTop = el.scrollHeight;
}

// ── Analysis ──────────────────────────────────────────────────────────────────
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(async () => {
    if (isListening) { await runAnalysis(); scheduleAnalyze(); }
  }, ANALYZE_EVERY);
}

async function runAnalysis() {
  const transcript = liveLines.map(l => l.text).join(" ").trim();
  if (transcript.length < 30) return;

  setStatus("analyzing", "Analyzing…");
  try {
    let context = "";
    if (summaryText) context = `[Earlier context summary]\n${summaryText}\n\n`;
    context += `[Live transcript — last ~2 minutes]\n${transcript}`;

    const text = await groqChat(ANALYZE_SYSTEM, context, 1024, true);
    const data = JSON.parse(text);
    if (data.topics?.length) data.topics.forEach(t => addTopic(t));
  } catch (e) {
    console.warn("Analyze failed:", e);
    if (e.message.includes("401") || e.message.toLowerCase().includes("invalid")) {
      setStatus("error", "Invalid API key");
      onboardingOverlay.classList.remove("hidden");
      onboardingClose.classList.remove("hidden");
    }
  } finally {
    if (isListening) setStatus("listening", "Listening…");
  }
}

// ── Topics ────────────────────────────────────────────────────────────────────
function topicKeywords(s) {
  return s.toLowerCase()
    .replace(/[^\w\sáéíóöőúüű]/gi, "")
    .split(/\s+/)
    .filter(w => w.length > 3);
}

function findSimilarTopic(label, question) {
  const norm  = s => s.toLowerCase().replace(/\s+/g, " ").trim();
  const kwSet = s => new Set(topicKeywords(s));

  return topics.find(t => {
    // Exact label match
    if (norm(t.label) === norm(label)) return true;

    // All meaningful words in the shorter label appear in the longer one
    const a = kwSet(t.label), b = kwSet(label);
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    if (smaller.size > 0 && [...smaller].every(w => larger.has(w))) return true;

    // Question shares ≥60% of its keywords with an existing question
    const qNew = topicKeywords(question);
    if (qNew.length === 0) return false;
    const qExisting = kwSet(t.question);
    const overlap = qNew.filter(w => qExisting.has(w));
    return overlap.length / qNew.length >= 0.6;
  });
}

function bumpTopic(topic) {
  // Scroll the wrapper into view and flash the button
  topic.wrapper.scrollIntoView({ behavior: "smooth", block: "nearest" });
  topic.btn.classList.remove("bump");
  void topic.btn.offsetWidth; // force reflow to restart animation
  topic.btn.classList.add("bump");
  topic.btn.addEventListener("animationend", () => topic.btn.classList.remove("bump"), { once: true });
}

function addTopic({ label, question, answer, sources }) {
  const existing = findSimilarTopic(label, question);
  if (existing) { bumpTopic(existing); return; }

  const id = `topic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = Date.now();

  topicsEmpty.classList.add("hidden");

  const wrapper = document.createElement("div");
  wrapper.className = "topic-wrapper";
  wrapper.id = id;

  const btnTmpl = document.getElementById("topic-btn-template").content.cloneNode(true);
  const btn = btnTmpl.querySelector(".topic-btn");
  btn.querySelector(".topic-btn-label").textContent = label;
  btn.addEventListener("click", () => expandTopic(id));
  wrapper.appendChild(btn);

  const cardTmpl = document.getElementById("topic-card-template").content.cloneNode(true);
  const card = cardTmpl.querySelector(".topic-card");
  card.classList.add("hidden");
  card.querySelector(".topic-card-time").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  card.querySelector(".topic-question").textContent = question;
  card.querySelector(".topic-answer-text").textContent = answer;

  const sourcesEl = card.querySelector(".topic-sources");
  (sources || []).forEach(s => {
    const a = document.createElement("a");
    a.className = "source-link";
    const safe = /^https?:\/\//i.test(s.url) ? s.url : "#";
    a.href = safe;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.title;
    sourcesEl.appendChild(a);
  });

  card.querySelector(".topic-collapse").addEventListener("click", () => collapseTopic(id));
  card.querySelector(".topic-dismiss").addEventListener("click", () => removeTopic(id));
  wrapper.appendChild(card);
  topicsList.prepend(wrapper);

  topics.push({ id, label, question, answer, sources, createdAt, wrapper, card, btn });
  updateTopicCount();
}

function expandTopic(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;
  topic.btn.classList.add("expanded");
  topic.card.classList.remove("hidden");
  topic.card.querySelector(".topic-answer").classList.remove("hidden");
}

function collapseTopic(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;
  topic.card.classList.add("hidden");
  topic.btn.classList.remove("expanded");
}

function removeTopic(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;
  topic.wrapper.style.opacity = "0";
  topic.wrapper.style.transform = "translateY(-6px)";
  topic.wrapper.style.transition = "all 0.2s ease";
  setTimeout(() => {
    topic.wrapper.remove();
    topics = topics.filter(t => t.id !== id);
    updateTopicCount();
    if (topics.length === 0) topicsEmpty.classList.remove("hidden");
  }, 200);
}

function updateTopicCount() {
  const active = topics.length;
  topicCount.textContent = active
    ? `${active} topic${active !== 1 ? "s" : ""} detected`
    : "Listening for questions…";
}

// ── Expiry ticker ─────────────────────────────────────────────────────────────
function startExpiryTicker() {
  clearInterval(expiryTimer);
  expiryTimer = setInterval(() => {
    const now = Date.now();
    topics.forEach(topic => {
      const elapsed = now - topic.createdAt;
      const ratio   = Math.min(elapsed / TOPIC_EXPIRY_MS, 1);
      const fill    = topic.card.querySelector(".topic-expiry-fill");
      if (fill) {
        fill.style.width = `${(1 - ratio) * 100}%`;
        fill.classList.toggle("warning",  ratio > 0.7 && ratio <= 0.9);
        fill.classList.toggle("critical", ratio > 0.9);
      }
      if (elapsed >= TOPIC_EXPIRY_MS) removeTopic(topic.id);
    });
  }, EXPIRY_TICK_MS);
}

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusText.textContent = text;
  statusDot.className = "status-dot";
  if (state === "listening")  statusDot.classList.add("listening");
  if (state === "analyzing")  statusDot.classList.add("analyzing");
}
