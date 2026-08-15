const API_BASE = ""; // same origin as this page

let currentThreadId = null;

const threadListEl = document.getElementById("threadList");
const chatTitleEl = document.getElementById("chatTitle");
const messagesEl = document.getElementById("messages");
const composerEl = document.getElementById("composer");
const messageInputEl = document.getElementById("messageInput");
const sendBtnEl = document.getElementById("sendBtn");
const dropZoneEl = document.getElementById("dropZone");
const fileInputEl = document.getElementById("fileInput");
const docStatusEl = document.getElementById("docStatus");
const toolStripEl = document.getElementById("toolStrip");
const toolStripTextEl = document.getElementById("toolStripText");

init();

async function init() {
  document.getElementById("newThreadBtn").addEventListener("click", createThread);
  composerEl.addEventListener("submit", onSend);
  dropZoneEl.addEventListener("click", () => fileInputEl.click());
  fileInputEl.addEventListener("change", (e) => uploadPdf(e.target.files[0]));
  dropZoneEl.addEventListener("dragover", (e) => { e.preventDefault(); dropZoneEl.classList.add("dragover"); });
  dropZoneEl.addEventListener("dragleave", () => dropZoneEl.classList.remove("dragover"));
  dropZoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZoneEl.classList.remove("dragover");
    if (e.dataTransfer.files[0]) uploadPdf(e.dataTransfer.files[0]);
  });

  await refreshThreadList();
  if (!currentThreadId) await createThread();
}

async function refreshThreadList() {
  const res = await fetch(`${API_BASE}/api/threads`);
  const threads = await res.json();
  threadListEl.innerHTML = "";
  threads.forEach((t) => {
    const item = document.createElement("div");
    item.className = "thread-item" + (t.thread_id === currentThreadId ? " active" : "");
    item.textContent = t.thread_id;
    item.title = t.thread_id;
    item.addEventListener("click", () => selectThread(t.thread_id));
    threadListEl.appendChild(item);
  });
}

async function createThread() {
  const res = await fetch(`${API_BASE}/api/threads`, { method: "POST" });
  const data = await res.json();
  currentThreadId = data.thread_id;
  await refreshThreadList();
  await selectThread(currentThreadId);
}

async function selectThread(threadId) {
  currentThreadId = threadId;
  chatTitleEl.textContent = threadId;
  document.querySelectorAll(".thread-item").forEach((el) => {
    el.classList.toggle("active", el.textContent === threadId);
  });

  const res = await fetch(`${API_BASE}/api/threads/${threadId}/history`);
  const data = await res.json();
  messagesEl.innerHTML = "";
  if (data.messages.length === 0) {
    messagesEl.innerHTML = `<div class="empty-state">Ask something, or upload a PDF and ask about it.</div>`;
  } else {
    data.messages.forEach((m) => appendBubble(m.role, m.content));
  }

  docStatusEl.textContent = "No document indexed";
  docStatusEl.classList.remove("ready");
}

async function uploadPdf(file) {
  if (!file || !currentThreadId) return;
  docStatusEl.textContent = "Indexing…";
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/threads/${currentThreadId}/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    docStatusEl.textContent = "Upload failed";
    return;
  }
  const summary = await res.json();
  docStatusEl.textContent = `${summary.filename} · ${summary.chunks} chunks`;
  docStatusEl.classList.add("ready");
}

function appendBubble(role, text) {
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

async function onSend(e) {
  e.preventDefault();
  const text = messageInputEl.value.trim();
  if (!text || !currentThreadId) return;

  appendBubble("user", text);
  messageInputEl.value = "";
  sendBtnEl.disabled = true;

  const assistantBubble = appendBubble("assistant", "");
  showToolStrip("thinking…");

  try {
    const form = new URLSearchParams();
    form.append("message", text);

    const res = await fetch(`${API_BASE}/api/threads/${currentThreadId}/chat`, {
      method: "POST",
      body: form,
    });

    await readSseStream(res, (evt, data) => {
      if (evt === "tool") {
        showToolStrip(`running ${data.name}…`);
      } else if (evt === "token") {
        hideToolStripSoon();
        assistantBubble.textContent += data.text;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (evt === "error") {
        assistantBubble.textContent += `\n[error: ${data.message}]`;
      } else if (evt === "done") {
        hideToolStrip();
      }
    });
  } finally {
    sendBtnEl.disabled = false;
    await refreshThreadList();
  }
}

function showToolStrip(text) {
  toolStripEl.hidden = false;
  toolStripTextEl.textContent = text;
}
function hideToolStrip() {
  toolStripEl.hidden = true;
}
function hideToolStripSoon() {
  // once real tokens start arriving, drop the "running tool" readout
  toolStripEl.hidden = true;
}

// Minimal SSE parser for a fetch() streaming response body.
// (EventSource can't be used here because it only supports GET requests.)
async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventType = "message";
      let dataLine = "";
      rawEvent.split("\n").forEach((line) => {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      });

      if (dataLine) {
        try {
          onEvent(eventType, JSON.parse(dataLine));
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}
