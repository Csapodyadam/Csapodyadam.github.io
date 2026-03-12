/* ================================================
   PodcastCopilot — app.js  (Groq / static build)
   ================================================ */

const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = "llama-3.1-8b-instant";

const WINDOW_MS       = 2 * 60 * 1000;   // 2 min live window
const ANALYZE_EVERY   = 20_000;           // analyze every 20s
const TOPIC_EXPIRY_MS = 10 * 60 * 1000;  // topic buttons live 10 min
const EXPIRY_TICK_MS  = 1_000;

// Question trigger patterns — immediate analysis when these are detected
const QUESTION_PATTERNS = [
  // English
  /\b(how does|how do|how is|how are|why does|why do|why is|what is|what are|what was|who is|when did|where does)\b/i,
  /\b(i don'?t know|no idea|i never (knew|understood)|i always wondered|i wonder|do you know|have you heard)\b/i,
  /\b(tell me (more|about)|explain|i'?m curious|interesting)\b/i,
  // Hungarian
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

function getApiKey() {
  return localStorage.getItem(LS_KEY) || "";
}

function saveApiKey(key) {
  localStorage.setItem(LS_KEY, key.trim());
}

// ── State ─────────────────────────────────────────────────────────────────────
let recognition   = null;
let isListening   = false;
let selectedLang  = "hu-HU";
let analyzeTimer      = null;
let expiryTimer       = null;
let quickTriggerTimer = null;

// Each entry: { text, timestamp }
let liveLines     = [];
let archivedText  = "";
let summaryText   = "";
let pendingArchive = false;

// Each topic: { id, label, question, answer, sources, createdAt, element }
let topics = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const setupBar        = document.getElementById("setup-bar");
const apiKeyInput     = document.getElementById("api-key-input");
const saveKeyBtn      = document.getElementById("save-key-btn");
const changeKeyBtn    = document.getElementById("change-key-btn");
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
const langBtns        = document.querySelectorAll(".lang-btn");

// ── Setup bar ─────────────────────────────────────────────────────────────────
function initSetupBar() {
  if (getApiKey()) {
    setupBar.classList.add("hidden");
  } else {
    setupBar.classList.remove("hidden");
  }
}

saveKeyBtn.addEventListener("click", () => {
  const val = apiKeyInput.value.trim();
  if (!val.startsWith("gsk_")) {
    apiKeyInput.style.borderColor = "var(--red)";
    return;
  }
  saveApiKey(val);
  setupBar.classList.add("hidden");
  apiKeyInput.value = "";
  apiKeyInput.style.borderColor = "";
  setStatus("idle", "Ready");
});

apiKeyInput.addEventListener("keydown", e => {
  if (e.key === "Enter") saveKeyBtn.click();
  apiKeyInput.style.borderColor = "";
});

changeKeyBtn.addEventListener("click", () => {
  setupBar.classList.toggle("hidden");
  if (!setupBar.classList.contains("hidden")) apiKeyInput.focus();
});

initSetupBar();

// ── Language toggle ───────────────────────────────────────────────────────────
langBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    langBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedLang = btn.dataset.lang;
    if (isListening) {
      stopListening();
      startListening();
    }
  });
});

// ── Start / Stop ──────────────────────────────────────────────────────────────
startBtn.addEventListener("click", startListening);
stopBtn.addEventListener("click",  stopListening);

function startListening() {
  if (!getApiKey()) {
    setupBar.classList.remove("hidden");
    apiKeyInput.focus();
    return;
  }

  if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
    setStatus("error", "Speech recognition not supported. Use Chrome.");
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = selectedLang;

  recognition.onstart = () => {
    isListening = true;
    startBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    transcriptEmpty.classList.add("hidden");
    setStatus("listening", "Listening…");
    scheduleAnalyze();
    startExpiryTicker();
  };

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) {
        addLine(result[0].transcript.trim());
      } else {
        interim += result[0].transcript;
      }
    }
    interimLine.textContent = interim;
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech") return;
    setStatus("error", `Error: ${e.error}`);
  };

  recognition.onend = () => {
    if (isListening) recognition.start();
  };

  recognition.start();
}

function stopListening() {
  isListening = false;
  recognition?.stop();
  clearTimeout(analyzeTimer);
  clearInterval(expiryTimer);
  startBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  interimLine.textContent = "";
  setStatus("idle", "Stopped");
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
  for (let i = 0; i < toRemove; i++) {
    transcriptLines.firstChild?.remove();
  }

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

    const text = await groqChat(SUMMARIZE_SYSTEM, toSummarize, 512);
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
  if (!summaryText) {
    summaryBlock.classList.add("hidden");
    return;
  }
  summaryTextEl.textContent = summaryText;
  summaryBlock.classList.remove("hidden");
}

deleteSummary.addEventListener("click", () => {
  summaryText = "";
  summaryBlock.classList.add("hidden");
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

// ── Groq API ──────────────────────────────────────────────────────────────────
async function groqChat(system, userMsg, maxTokens = 1024) {
  const key = getApiKey();
  if (!key) throw new Error("No API key set");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userMsg },
      ],
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ── Analysis ──────────────────────────────────────────────────────────────────
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(async () => {
    if (isListening) {
      await runAnalysis();
      scheduleAnalyze();
    }
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

    const text = await groqChat(ANALYZE_SYSTEM, context, 1024);
    const data = JSON.parse(text);

    if (data.topics?.length) {
      data.topics.forEach(t => addTopic(t));
    }
  } catch (e) {
    console.warn("Analyze failed:", e);
    if (e.message.includes("401") || e.message.toLowerCase().includes("invalid")) {
      setStatus("error", "Invalid API key");
      setupBar.classList.remove("hidden");
    }
  } finally {
    if (isListening) setStatus("listening", "Listening…");
  }
}

// ── Topics ────────────────────────────────────────────────────────────────────
function addTopic({ label, question, answer, sources }) {
  const norm = s => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (topics.some(t => norm(t.label) === norm(label))) return;

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
    a.href = s.url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.title;
    sourcesEl.appendChild(a);
  });

  card.querySelector(".topic-dismiss").addEventListener("click", () => removeTopic(id));
  wrapper.appendChild(card);

  topicsList.prepend(wrapper);

  const topic = { id, label, question, answer, sources, createdAt, wrapper, card, btn };
  topics.push(topic);
  updateTopicCount();
}

function expandTopic(id) {
  const topic = topics.find(t => t.id === id);
  if (!topic) return;

  topic.btn.classList.add("expanded");
  topic.card.classList.remove("hidden");
  topic.card.querySelector(".topic-answer").classList.remove("hidden");
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
      const elapsed  = now - topic.createdAt;
      const ratio    = Math.min(elapsed / TOPIC_EXPIRY_MS, 1);
      const fill     = topic.card.querySelector(".topic-expiry-fill");

      if (fill) {
        const pct = (1 - ratio) * 100;
        fill.style.width = `${pct}%`;
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
