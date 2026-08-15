"""
FastAPI backend that exposes chatbot_core.chatbot over HTTP, so the
vanilla HTML/CSS/JS frontend in ./static can replace the Streamlit UI.

Run with:
    uvicorn api:app --reload --port 8000

Then open http://localhost:8000 in a browser.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import AIMessageChunk, HumanMessage, ToolMessage

from chatbot_core import (
    chatbot,
    ingest_pdf,
    retrieve_all_threads,
    thread_document_metadata,
    thread_has_document,
)

app = FastAPI(title="PDF-RAG Chatbot API")

# The static frontend calls this API from the browser — allow it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _thread_title(thread_id: str, max_len: int = 42) -> str:
    """First user message, trimmed — used instead of the raw UUID in the UI."""
    config = {"configurable": {"thread_id": thread_id}}
    state = chatbot.get_state(config)
    messages = state.values.get("messages", []) if state else []
    for m in messages:
        if m.type == "human" and getattr(m, "content", None):
            text = " ".join(m.content.split())  # collapse newlines/whitespace
            return text[:max_len] + ("…" if len(text) > max_len else "")
    return "New thread"


@app.get("/api/threads")
def list_threads():
    threads = retrieve_all_threads()
    return [
        {
            "thread_id": t,
            "title": _thread_title(t),
            "has_document": thread_has_document(t),
            "document": thread_document_metadata(t),
        }
        for t in threads
    ]


@app.post("/api/threads")
def create_thread():
    return {"thread_id": str(uuid.uuid4())}


@app.get("/api/threads/{thread_id}/history")
def get_history(thread_id: str):
    config = {"configurable": {"thread_id": thread_id}}
    state = chatbot.get_state(config)
    messages = state.values.get("messages", []) if state else []
    out = []
    for m in messages:
        if m.type == "human":
            role = "user"
        elif m.type == "ai":
            role = "assistant"
        else:
            continue  # skip raw tool messages in the transcript view
        if getattr(m, "content", None):
            out.append({"role": role, "content": m.content})
    return {"thread_id": thread_id, "messages": out}


@app.post("/api/threads/{thread_id}/upload")
async def upload_pdf(thread_id: str, file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported.")
    data = await file.read()
    try:
        summary = ingest_pdf(data, thread_id=thread_id, filename=file.filename)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Failed to ingest PDF: {exc}") from exc
    return summary


@app.post("/api/threads/{thread_id}/chat")
async def chat(thread_id: str, message: str = Form(...)):
    """
    Streams the assistant's reply as Server-Sent Events so the UI can show
    tokens as they arrive, plus which tool the agent is currently using.

    Event types sent to the client:
      tool  -> {"name": "...", "content": "..."}  a tool finished, with its result
      token -> {"text": "..."}                     a chunk of the reply
      error -> {"message": "..."}                  something went wrong
      done  -> {}                                   stream finished
    """
    config = {"configurable": {"thread_id": thread_id}}

    def event(kind: str, data: dict) -> str:
        return f"event: {kind}\ndata: {json.dumps(data)}\n\n"

    def gen():
        try:
            for message_chunk, _metadata in chatbot.stream(
                {"messages": [HumanMessage(content=message)]},
                config=config,
                stream_mode="messages",
            ):
                if isinstance(message_chunk, ToolMessage):
                    # content is usually a JSON string (dict tools) or plain text
                    # (the DuckDuckGo search tool) — send it as-is and let the
                    # frontend try to parse it.
                    yield event(
                        "tool",
                        {"name": message_chunk.name, "content": str(message_chunk.content)},
                    )
                elif isinstance(message_chunk, AIMessageChunk) and message_chunk.content:
                    yield event("token", {"text": message_chunk.content})
        except Exception as exc:  # noqa: BLE001
            yield event("error", {"message": str(exc)})
        yield event("done", {})

    return StreamingResponse(gen(), media_type="text/event-stream")


# Serve the vanilla HTML/CSS/JS frontend at "/"
STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")