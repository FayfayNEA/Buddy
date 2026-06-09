import os
import sys
import shutil
import json
import random
import re
import io
import logging
import time
import uuid
import zipfile
from collections import deque
from datetime import datetime, timezone
from threading import Lock
import requests
from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from dotenv import load_dotenv
from openai import OpenAI
import fal_client
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import simpleSplit
import asyncio

load_dotenv()


def _ensure_console_logger(name: str = "consensus_engine") -> logging.Logger:
    """Uvicorn often leaves the root logger at WARNING; app INFO lines were dropped. This logger always prints to stderr."""
    lg = logging.getLogger(name)
    lg.setLevel(logging.INFO)
    if not lg.handlers:
        h = logging.StreamHandler(sys.stderr)
        h.setLevel(logging.INFO)
        h.setFormatter(
            logging.Formatter(
                "%(asctime)s | %(levelname)-8s | %(message)s",
                datefmt="%H:%M:%S",
            )
        )
        lg.addHandler(h)
    lg.propagate = False
    return lg


logger = _ensure_console_logger()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# In-memory trace of recent /upload-audio (and commit) for GET /debug/trace
_TRACE_MAX = 200
_request_trace: deque = deque(maxlen=_TRACE_MAX)
_trace_lock = Lock()

# Demo limit system — each visitor gets DEMO_LIMIT generations. Usage is tracked by
# BOTH a browser UUID token and the client IP. The effective count is the larger of
# the two, so a visitor must change their browser storage AND their IP to reset the
# limit (clearing localStorage alone no longer grants a fresh allowance).
_DEMO_LIMIT = int(os.getenv("DEMO_LIMIT", "3"))
_demo_tokens: dict = {}     # token -> use_count
_demo_ip_usage: dict = {}   # client_ip -> use_count
_demo_token_lock = Lock()


def _client_ip(request: Request) -> str:
    """Best-effort real client IP. Cloud Run and other proxies forward it in
    X-Forwarded-For (first entry is the original client)."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _resolve_demo_token(token: str) -> str:
    """Return a valid token, creating a new one if unknown."""
    with _demo_token_lock:
        if token and token in _demo_tokens:
            return token
        new_token = str(uuid.uuid4())
        _demo_tokens[new_token] = 0
        return new_token


def _demo_uses(token: str, ip: str) -> int:
    """Effective uses = the larger of the token-based and IP-based counts."""
    with _demo_token_lock:
        return max(_demo_tokens.get(token, 0), _demo_ip_usage.get(ip, 0))


def _increment_demo(token: str, ip: str) -> int:
    """Increment both counters and return the new effective use count."""
    with _demo_token_lock:
        _demo_tokens[token] = _demo_tokens.get(token, 0) + 1
        _demo_ip_usage[ip] = _demo_ip_usage.get(ip, 0) + 1
        return max(_demo_tokens[token], _demo_ip_usage[ip])


def _push_trace(entry: dict) -> None:
    row = {
        **entry,
        "ts_utc": datetime.now(timezone.utc).isoformat(),
    }
    with _trace_lock:
        _request_trace.appendleft(row)


fal_key = os.getenv("FAL_KEY")
if not fal_key:
    logger.warning("FAL_KEY not set — Fal image generation will fail until it is set in .env")
else:
    logger.info("FAL_KEY loaded (prefix %.20s...)", fal_key[:20])

# Voice/interactive UX: default to FLUX Schnell (fast). For max quality use:
#   FAL_IMAGE_MODEL=fal-ai/flux-pro/v1.1  (slower)
FAL_IMAGE_MODEL = os.getenv("FAL_IMAGE_MODEL", "fal-ai/flux/schnell").strip()

limiter = Limiter(key_func=get_remote_address)

app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

_allowed_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _log_startup():
    logger.info(
        "Backend PID=%s | OpenAI key set=%s | Fal key set=%s | FAL_IMAGE_MODEL=%s",
        os.getpid(),
        bool(os.getenv("OPENAI_API_KEY")),
        bool(os.getenv("FAL_KEY")),
        FAL_IMAGE_MODEL,
    )
    logger.info("CORS allowed origins: %s", _allowed_origins)


_DEBUG_SECRET = os.getenv("DEBUG_SECRET", "")


def _check_debug_auth(request: Request):
    if not _DEBUG_SECRET:
        raise HTTPException(status_code=404, detail="Not found")
    if request.headers.get("X-Debug-Secret") != _DEBUG_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")


@app.get("/debug/status")
def debug_status(request: Request):
    _check_debug_auth(request)
    return {
        "backend_pid": os.getpid(),
        "python_version": sys.version.split()[0],
        "trace_entries_buffered": len(_request_trace),
        "openai_api_key_configured": bool(os.getenv("OPENAI_API_KEY")),
        "fal_key_configured": bool(os.getenv("FAL_KEY")),
        "fal_image_model": FAL_IMAGE_MODEL,
    }


@app.get("/debug/trace")
def debug_trace(request: Request, limit: int = 50):
    _check_debug_auth(request)
    limit = max(1, min(limit, _TRACE_MAX))
    with _trace_lock:
        return {
            "backend_pid": os.getpid(),
            "count_returned": min(limit, len(_request_trace)),
            "entries": list(_request_trace)[:limit],
        }


def _fal_first_image_url(result):
    """Extract first image URL from a Fal queue/run JSON response."""
    if not result:
        return None
    if isinstance(result, dict):
        payload = result
        for key in ("data", "output", "result"):
            inner = result.get(key)
            if isinstance(inner, dict) and inner.get("images"):
                payload = inner
                break
    else:
        return None
    images = payload.get("images")
    if not images or not isinstance(images, list):
        return None
    first = images[0]
    if not isinstance(first, dict):
        return None
    url = first.get("url")
    if url and str(url).strip():
        return str(url).strip()
    return None


@app.post("/upload-audio")
@limiter.limit("20/hour")
async def upload_audio(
    request: Request,
    file: UploadFile = File(...),
    history_json: str = Form(default="[]"),
    demo_token: str = Form(default=""),
):
    request_id = str(uuid.uuid4())[:10]
    t0 = time.perf_counter()
    process_steps = []

    def trace_step(name: str, **detail):
        process_steps.append({"step": name, **detail})

    logger.info("========== /upload-audio [%s] START ==========", request_id)

    # --- DEMO GATE ---
    client_ip = _client_ip(request)
    resolved_token = _resolve_demo_token(demo_token)
    if _demo_uses(resolved_token, client_ip) >= _DEMO_LIMIT:
        raise HTTPException(status_code=429, detail="Demo limit reached")

    # --- A. SETUP ---
    temp_filename = "temp_voice.wav"
    with open(temp_filename, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    trace_step("save_audio", bytes=os.path.getsize(temp_filename))

    # --- B. TRANSCRIBE ---
    try:
        with open(temp_filename, "rb") as audio_file:
            transcription = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                language="en",
                temperature=0.0,
                # Prompt steers Whisper away from hallucinations
                prompt="Technical diagram types: pie chart, sequence diagram, mindmap, flow chart, gantt chart, bar chart, architecture.",
            )
        user_text = transcription.text.strip()
        trace_step("whisper", ok=True, transcript=user_text)
        logger.info("[%s] USER (Whisper transcript): %s", request_id, user_text)
    except Exception as exc:
        trace_step("whisper", ok=False, error=str(exc))
        logger.warning("[%s] Transcription failed: %s", request_id, exc)
        _push_trace(
            {
                "request_id": request_id,
                "endpoint": "/upload-audio",
                "outcome": "silence",
                "reason": "transcription_error",
                "process_steps": process_steps,
            }
        )
        return {"error": "Silence"}

    # --- HALLUCINATION FILTER ---
    # Only block known Whisper spam / garbage. Do NOT use short tokens like "you" as
    # substrings — that rejects normal speech ("can you draw...", "your", "young", etc.).
    tl = user_text.lower().strip()
    if len(user_text.strip()) < 4:
        trace_step("filter", rejected=True, reason="too_short")
        _push_trace(
            {
                "request_id": request_id,
                "endpoint": "/upload-audio",
                "user_prompt": user_text,
                "outcome": "silence",
                "reason": "too_short",
                "process_steps": process_steps,
            }
        )
        return {"error": "Silence"}
    junk_phrases = (
        "thank you for watching",
        "thanks for watching",
        "please subscribe",
        "subtitle by",
        "amara.org",
        # Whisper loop hallucinations
        "we'll move on to the",
        "move on to the flow",
        "move on to the mind",
    )
    if any(p in tl for p in junk_phrases):
        trace_step("filter", rejected=True, reason="junk_phrase")
        _push_trace(
            {
                "request_id": request_id,
                "endpoint": "/upload-audio",
                "user_prompt": user_text,
                "outcome": "silence",
                "reason": "junk_phrase",
                "process_steps": process_steps,
            }
        )
        return {"error": "Silence"}
    if tl in ("you", "thank you.", "thanks.", "subtitle", "silence", "bye"):
        trace_step("filter", rejected=True, reason="junk_exact")
        _push_trace(
            {
                "request_id": request_id,
                "endpoint": "/upload-audio",
                "user_prompt": user_text,
                "outcome": "silence",
                "reason": "junk_exact",
                "process_steps": process_steps,
            }
        )
        return {"error": "Silence"}

    # Repetition loop detector — catches any Whisper hallucination that repeats a phrase 4+ times.
    # Split into 4-word ngrams and flag if any appears 4+ times.
    _words = tl.split()
    if len(_words) >= 16:
        _ngrams = [" ".join(_words[i:i+4]) for i in range(len(_words) - 3)]
        _max_repeat = max(_ngrams.count(ng) for ng in set(_ngrams))
        if _max_repeat >= 4:
            trace_step("filter", rejected=True, reason="repetition_loop", max_repeat=_max_repeat)
            logger.warning("[%s] Repetition loop detected (max_repeat=%d): %s", request_id, _max_repeat, tl[:120])
            _push_trace(
                {
                    "request_id": request_id,
                    "endpoint": "/upload-audio",
                    "user_prompt": user_text,
                    "outcome": "silence",
                    "reason": "repetition_loop",
                    "process_steps": process_steps,
                }
            )
            return {"error": "Silence"}

    # --- C. PARSE HISTORY ---
    # --- C. PARSE HISTORY ---
    try:
        history = json.loads(history_json)
        last_item = history[-1] if history else None
        last_image_url = last_item.get('image_url', '') if last_item else ''
        last_visual_prompt = last_item.get('visual_prompt', '') if last_item else ''
        last_seed = last_item.get('seed', None) if last_item else None
    except:
        history, last_image_url, last_visual_prompt, last_seed = [], "", "", None

    trace_step("parse_history", items=len(history))

    # --- D. THE BRAIN (CONTEXT AWARE) ---
    system_prompt = f"""
    You are a Visual Assistant. You generate Mermaid.js code OR Fal.ai image prompts.
    
    CURRENT MODE: {"DIAGRAM" if history and history[-1].get('mode') == 'DIAGRAM' else "SKETCH"} (You can switch based on intent).

    TASK:
    1. ANALYZE USER INTENT:
       - If asking for a chart, graph, flow, or timeline -> output mode: "DIAGRAM".
       - If describing a scene, photo, texture, or visual style -> output mode: "SKETCH".
       - If referring to "it", "the image", or "that", use the CONTEXT HISTORY to understand what is being modified.

    2. FOR DIAGRAMS (Mermaid):
       - Return valid Mermaid code only. No backticks.
       - Support: graph TD, mindmap, pie, sequenceDiagram, xychart-beta, gantt.

    3. FOR SKETCHES (Images):
       - If this is a refinement (e.g. "make it blue"), keep the core details of the previous prompt and apply the change.
       - set "is_refinement": true only if editing the previous image.

    Return JSON ONLY:
    {{ "mode": "DIAGRAM" or "SKETCH", "prompt": "...", "is_refinement": true/false }}
    """

    # 1. Start the message chain with System Prompt
    messages_payload = [{"role": "system", "content": system_prompt}]

    # 2. Inject History (The Fix)
    # We ignore the last 5 items (controlled by frontend) to keep context tight
    for item in history:
        # User said:
        messages_payload.append({"role": "user", "content": item.get('transcript', '')})
        
        # You previously replied with (the prompt or the code):
        prev_response = json.dumps({
            "mode": item.get('mode', 'SKETCH'),
            "prompt": item.get('visual_prompt', ''),
            "is_refinement": False
        })
        messages_payload.append({"role": "assistant", "content": prev_response})

    # 3. Add Current User Input
    messages_payload.append({"role": "user", "content": user_text})

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=messages_payload,
            temperature=0.0,
            top_p=0.0,
            max_tokens=200,
            presence_penalty=0.0,
            frequency_penalty=0.0,
            logit_bias={},
            user="user_id_123",
            n=1,
            stream=False,
        )
        decision = json.loads(response.choices[0].message.content)

        raw_mode = decision.get("mode") or "SKETCH"
        mode = raw_mode.upper().strip() if isinstance(raw_mode, str) else "SKETCH"
        new_prompt = decision.get("prompt", user_text)
        is_refinement = decision.get("is_refinement", False)

        # Hard override for diagrams keywords
        if any(w in user_text.lower() for w in ["diagram", "chart", "graph", "map", "plot"]):
            mode = "DIAGRAM"

        # Only two execution branches exist; anything else (e.g. "IMAGE", "PHOTO") skipped generation before.
        if mode != "DIAGRAM":
            mode = "SKETCH"

        trace_step(
            "brain_gpt",
            mode=mode,
            visual_prompt=(new_prompt or "")[:2000],
            is_refinement=is_refinement,
        )
        logger.info(
            "[%s] BRAIN -> mode=%s | visual_prompt (first 400 chars): %s",
            request_id,
            mode,
            (new_prompt or "")[:400],
        )

    except Exception as e:
        logger.exception("[%s] Brain error, defaulting to SKETCH: %s", request_id, e)
        trace_step("brain_gpt", ok=False, error=str(e), fallback="SKETCH")
        mode = "SKETCH"
        new_prompt = user_text
        is_refinement = False

    # --- E. EXECUTE ---
    media_url = None
    diagram_code = None
    final_seed = None

    if mode == "SKETCH":
        try:
            if is_refinement and last_seed is not None:
                current_seed = last_seed
            else:
                current_seed = random.randint(0, 100000000)

            if not os.getenv("FAL_KEY"):
                logger.error("FAL_KEY is not set; cannot call Fal.ai")

            fal_endpoint = FAL_IMAGE_MODEL
            if fal_endpoint == "fal-ai/flux-pro/v1.1":
                # Higher quality, higher latency & cost
                args = {
                    "prompt": new_prompt,
                    "image_size": "landscape_16_9",
                    "seed": current_seed,
                    "output_format": "jpeg",
                    "safety_tolerance": "3",
                }
                http_timeout = 120.0
                outer_timeout = 125.0
            else:
                # Default: FLUX Schnell — optimized for speed (voice / realtime feel)
                if fal_endpoint not in ("fal-ai/flux/schnell",):
                    logger.warning("Unknown FAL_IMAGE_MODEL=%s — using fal-ai/flux/schnell", fal_endpoint)
                    fal_endpoint = "fal-ai/flux/schnell"
                args = {
                    "prompt": new_prompt,
                    "image_size": "landscape_16_9",
                    "seed": current_seed,
                    "num_inference_steps": 3,
                    "acceleration": "high",
                    "enable_safety_checker": True,
                    "output_format": "jpeg",
                }
                http_timeout = 75.0
                outer_timeout = 80.0

            logger.info(
                "Fal run_async %s seed=%s prompt_preview=%s",
                fal_endpoint,
                current_seed,
                (new_prompt or "")[:120],
            )

            result = await asyncio.wait_for(
                fal_client.run_async(
                    fal_endpoint,
                    arguments=args,
                    timeout=http_timeout,
                ),
                timeout=outer_timeout,
            )

            media_url = _fal_first_image_url(result)
            if media_url:
                final_seed = current_seed
                trace_step(
                    "fal_image",
                    model=fal_endpoint,
                    ok=True,
                    image_url=media_url[:500],
                    seed=current_seed,
                )
                logger.info("[%s] Fal image URL: %s", request_id, media_url[:200])
            else:
                trace_step(
                    "fal_image",
                    model=fal_endpoint,
                    ok=False,
                    raw_keys=list(result.keys()) if isinstance(result, dict) else None,
                    raw_preview=json.dumps(result, default=str)[:600],
                )
                logger.error(
                    "[%s] Fal response had no usable image URL: %s",
                    request_id,
                    json.dumps(result, default=str)[:800],
                )

        except asyncio.TimeoutError:
            trace_step("fal_image", model=FAL_IMAGE_MODEL, ok=False, error="timeout")
            logger.error("[%s] Fal request timed out", request_id)
            media_url = None
        except Exception as e:
            trace_step("fal_image", model=FAL_IMAGE_MODEL, ok=False, error=str(e))
            logger.exception("[%s] Fal error: %s", request_id, e)
            media_url = None

    elif mode == "DIAGRAM":
        raw_code = (new_prompt or "")
        
        # 1. Clean conversational filler
        filler = [r"here is.*", r"sure.*", r"based on.*", r"generating.*"]
        for p in filler: raw_code = re.sub(p, "", raw_code, flags=re.IGNORECASE)
        clean_code = raw_code.replace("```mermaid", "").replace("```", "").strip()

        # 2. VALIDATION (Fixed to allow all types)
        valid_types = [
            "graph", "flowchart", "mindmap", "sequenceDiagram", 
            "classDiagram", "stateDiagram", "pie", "xychart-beta", "gantt", "erDiagram"
        ]
        
        is_valid = any(clean_code.lower().startswith(t.lower()) for t in valid_types)

        if not is_valid:
            logger.warning("[%s] Invalid diagram from model; fallback to mindmap", request_id)
            clean_code = f"mindmap\n  root(({user_text}))"

        diagram_code = clean_code
        trace_step(
            "diagram_mermaid",
            first_line=diagram_code.splitlines()[0][:200] if diagram_code else "",
            code_length=len(diagram_code or ""),
        )
        logger.info(
            "[%s] DIAGRAM first line: %s",
            request_id,
            diagram_code.splitlines()[0][:200] if diagram_code else "",
        )

    uses_now = _increment_demo(resolved_token, client_ip)

    result = {
        "transcript": user_text,
        "mode": mode,
        "visual_prompt": new_prompt,
        "image_url": media_url,
        "diagram_code": diagram_code,
        "seed": final_seed,
        "demo_token": resolved_token,
        "demo_uses_remaining": max(0, _DEMO_LIMIT - uses_now),
    }

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    if mode == "SKETCH" and not media_url:
        outcome = "sketch_no_image_url"
    elif mode == "DIAGRAM" and not diagram_code:
        outcome = "diagram_missing"
    elif media_url or diagram_code:
        outcome = "ok"
    else:
        outcome = "ok_empty"

    _push_trace(
        {
            "request_id": request_id,
            "endpoint": "/upload-audio",
            "duration_ms": elapsed_ms,
            "user_prompt": user_text,
            "history_items_sent": len(history),
            "brain": {
                "mode": mode,
                "visual_prompt": new_prompt,
                "is_refinement": is_refinement,
            },
            "response": {
                "transcript": user_text,
                "mode": mode,
                "visual_prompt": new_prompt,
                "image_url": media_url,
                "diagram_code": (diagram_code[:800] + "…")
                if diagram_code and len(diagram_code) > 800
                else diagram_code,
                "seed": final_seed,
            },
            "process_steps": process_steps,
            "outcome": outcome,
        }
    )

    logger.info(
        "[%s] RESPONSE SUMMARY | mode=%s | has_image=%s | has_diagram=%s | %d ms",
        request_id,
        mode,
        bool(media_url),
        bool(diagram_code),
        elapsed_ms,
    )
    logger.info(
        "[%s] RESPONSE JSON: %s",
        request_id,
        json.dumps(result, ensure_ascii=False, default=str)[:2000],
    )
    logger.info("========== /upload-audio [%s] END ==========", request_id)

    return result

@app.post("/commit-session")
@limiter.limit("5/hour")
async def commit_session(
    request: Request,
    history_json: str = Form(...),
):
    """Build a zip (images + session_summary.pdf) and return it as a file download."""
    try:
        history = json.loads(history_json)
        logger.info("Commit session: %s items", len(history))
        _push_trace(
            {
                "request_id": str(uuid.uuid4())[:10],
                "endpoint": "/commit-session",
                "outcome": "received",
                "item_count": len(history),
                "summaries": [
                    {
                        "transcript": (item.get("transcript") or "")[:300],
                        "mode": item.get("mode"),
                        "has_image": bool(item.get("image_url")),
                    }
                    for item in history[:20]
                ],
            }
        )

        zip_buffer = io.BytesIO()

        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            image_count = 0
            summary_lines = []

            for idx, item in enumerate(history, 1):
                if item.get("image_url") and item.get("mode") != "DIAGRAM":
                    try:
                        image_response = requests.get(item["image_url"], timeout=30)
                        if image_response.status_code == 200:
                            ext = ".jpg"
                            if ".png" in item["image_url"].lower():
                                ext = ".png"
                            elif ".webp" in item["image_url"].lower():
                                ext = ".webp"

                            image_count += 1
                            filename = f"image_{image_count}{ext}"
                            zip_file.writestr(filename, image_response.content)
                    except Exception as e:
                        logger.warning("Error downloading image %s: %s", idx, e)

                transcript = item.get("transcript", "N/A")
                visual_prompt = item.get("visual_prompt", "N/A")
                mode = item.get("mode", "N/A")

                summary_lines.extend(
                    [
                        f"Item {idx}:",
                        f" Mode: {mode}",
                        f" User Transcript: {transcript}",
                        f" AI Prompt: {visual_prompt}",
                        "",
                    ]
                )

            pdf_buffer = io.BytesIO()
            c = canvas.Canvas(pdf_buffer, pagesize=letter)
            page_width, page_height = letter
            left_margin = 40
            top_y = page_height - 50
            bottom_margin = 50
            font_name = "Helvetica"
            font_size = 12
            line_height = 16
            max_text_width = page_width - left_margin * 2

            text_obj = c.beginText(left_margin, top_y)
            text_obj.setFont(font_name, font_size)
            y = top_y

            for line in summary_lines:
                # Wrap each line to the usable page width so words never run off the edge
                wrapped = simpleSplit(line, font_name, font_size, max_text_width) or [""]
                for wrapped_line in wrapped:
                    if y <= bottom_margin:
                        # Reached bottom of page — start a new one
                        c.drawText(text_obj)
                        c.showPage()
                        text_obj = c.beginText(left_margin, top_y)
                        text_obj.setFont(font_name, font_size)
                        y = top_y
                    text_obj.textLine(wrapped_line)
                    y -= line_height

            c.drawText(text_obj)
            c.showPage()
            c.save()

            pdf_buffer.seek(0)
            zip_file.writestr("session_summary.pdf", pdf_buffer.getvalue())

        zip_buffer.seek(0)
        zip_bytes = zip_buffer.getvalue()
        logger.info("Commit session zip ready: %s bytes", len(zip_bytes))

        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="consensus-session-export.zip"',
            },
        )

    except Exception as e:
        logger.exception("Commit session error: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)