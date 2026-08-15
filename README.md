# Multi-Tool Conversational AI Agent

A locally-hosted, multi-turn conversational agent built with **LangGraph** and a **local Ollama LLM**, exposed over a **FastAPI** backend with a custom **HTML/CSS/JS** frontend. The agent can chat normally, answer questions about an uploaded PDF (RAG), search the web, look up stock prices, and do arithmetic — deciding on its own which tool (if any) a given question needs.

> Also referred to as the **PDF-RAG Chatbot** — this repo replaces an earlier Streamlit prototype with a custom frontend and a proper HTTP API.

---
<img width="1907" height="863" alt="image" src="https://github.com/user-attachments/assets/268cb643-1352-478a-bade-d0e814fbf038" />

## Features

- **Multi-tool agent** — the LLM decides when to call:
  - `rag_tool` — retrieval over an uploaded PDF (FAISS + Ollama embeddings)
  - DuckDuckGo web search
  - Stock price lookup (Alpha Vantage)
  - A calculator
- **General conversation is not gated behind a PDF** — you can chat normally; the RAG tool only fires when you actually ask about a document.
- **Threaded, persistent chats** — each conversation is a thread, checkpointed to SQLite via LangGraph's `SqliteSaver`, so history survives a restart.
- **Streaming responses** — replies stream token-by-token over Server-Sent Events, along with live events for which tool is currently running.
- **Per-thread document isolation** — each thread gets its own FAISS retriever; a PDF uploaded in one thread isn't visible to another.
- **No Streamlit** — a hand-built HTML/CSS/JS frontend talks to the backend over a small REST + SSE API, so the UI isn't constrained by a widget framework.

---

## Architecture

```
┌─────────────────────┐        HTTP / SSE        ┌──────────────────────┐
│  Frontend            │  ───────────────────────▶ │  FastAPI (api.py)    │
│  static/index.html   │  ◀─────────────────────── │                       │
│  (HTML + CSS + JS)   │                            │  - /api/threads       │
└─────────────────────┘                            │  - /api/threads/{id}/upload
                                                     │  - /api/threads/{id}/chat (SSE)
                                                     │  - /api/threads/{id}/history
                                                     └──────────┬────────────┘
                                                                │
                                                                ▼
                                                     ┌──────────────────────┐
                                                     │  chatbot_core.py      │
                                                     │  LangGraph agent      │
                                                     │  - chat_node (LLM)    │
                                                     │  - tool_node          │
                                                     │  - SqliteSaver        │
                                                     └──────────┬────────────┘
                                                                │
                              ┌─────────────────────────────────┼───────────────────────┐
                              ▼                                 ▼                        ▼
                     ┌────────────────┐              ┌───────────────────┐   ┌────────────────────┐
                     │ Ollama          │              │ FAISS (per-thread) │   │ DuckDuckGo / Alpha  │
                     │ llama3.1 +      │              │ PDF retriever      │   │ Vantage / calculator │
                     │ nomic-embed-text│              └───────────────────┘   └────────────────────┘
                     └────────────────┘
```

---

## Tech Stack

| Layer            | Technology                                      |
|-------------------|--------------------------------------------------|
| LLM               | Ollama (`llama3.1`)                              |
| Embeddings        | Ollama (`nomic-embed-text`)                      |
| Agent framework   | LangGraph + LangChain                            |
| Vector store      | FAISS (in-memory, per thread)                    |
| PDF parsing       | `PyPDFLoader`                                    |
| Conversation state| SQLite (`langgraph.checkpoint.sqlite.SqliteSaver`)|
| Backend API       | FastAPI + Uvicorn                                |
| Streaming         | Server-Sent Events (SSE)                         |
| Frontend          | Vanilla HTML, CSS, JavaScript (no framework)     |
| Tools             | DuckDuckGo search, Alpha Vantage, custom calculator |

---

## Project Structure

```
query-desk/
├── api.py              # FastAPI app: routes + SSE streaming
├── chatbot_core.py      # LangGraph graph, tools, PDF ingestion, checkpointer
├── requirements.txt
├── static/
│   ├── index.html
│   ├── style.css
│   └── script.js
└── chatbot.db            # SQLite checkpoint DB (created on first run)
```

---

## Setup

### 1. Prerequisites

- Python 3.10+
- [Ollama](https://ollama.com) installed and running locally
- An [Alpha Vantage](https://www.alphavantage.co/support/#api-key) API key (free tier is fine)

### 2. Pull the required Ollama models

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
```

### 3. Clone and install

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd query-desk
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 4. Configure environment variables

Create a `.env` file in the project root:

```env
ALPHA_VANTAGE_API_KEY=your_key_here
```

> ⚠️ The current `get_stock_price` tool has the Alpha Vantage key hardcoded in `chatbot_core.py`. Move it to `.env` and load it with `os.getenv("ALPHA_VANTAGE_API_KEY")` before pushing this repo publicly — don't commit API keys.

### 5. Run

```bash
uvicorn api:app --reload --port 8000
```

Open **http://localhost:8000** in your browser.

---

## API Reference

| Method | Endpoint                          | Description                                  |
|--------|------------------------------------|-----------------------------------------------|
| GET    | `/api/threads`                     | List all threads with title + document status |
| POST   | `/api/threads`                     | Create a new thread                            |
| GET    | `/api/threads/{thread_id}/history` | Get a thread's message history                 |
| POST   | `/api/threads/{thread_id}/upload`  | Upload and index a PDF for that thread          |
| POST   | `/api/threads/{thread_id}/chat`    | Send a message; streams the reply via SSE      |

**SSE event types** from `/chat`:
- `tool` — a tool ran, with its name and result (`{"name": "...", "content": "..."}`)
- `token` — a chunk of the assistant's reply (`{"text": "..."}`)
- `error` — something went wrong (`{"message": "..."}`)
- `done` — stream finished

---

## Known Limitations

- FAISS retrievers are held in memory (`_THREAD_RETRIEVERS`), so uploaded PDFs are lost on server restart — only the chat history persists (via SQLite).
- The Alpha Vantage free tier has a low rate limit; frequent stock lookups will start returning throttling errors instead of quotes.
- No authentication — anyone with network access to the server can read/write any thread. Fine for local/single-user use; add auth before deploying publicly.

---

## Roadmap / Ideas

- [ ] Move the Alpha Vantage key to environment variables
- [ ] Persist FAISS indexes to disk instead of in-memory
- [ ] Add streaming token-level typing indicator polish
- [ ] Docker Compose setup bundling the app + Ollama for easier onboarding

---

## License

MIT — see [LICENSE](LICENSE) for details.
