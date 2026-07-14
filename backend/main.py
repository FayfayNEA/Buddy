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

# Demo token system — each visitor gets DEMO_LIMIT generations, tracked by UUID
_DEMO_LIMIT = int(os.getenv("DEMO_LIMIT", "9999"))
_demo_tokens: dict = {}  # token -> use_count
_demo_token_lock = Lock()


def _resolve_demo_token(token: str) -> tuple:
    """Return (token, uses_so_far). Creates a new token if unknown."""
    with _demo_token_lock:
        if token and token in _demo_tokens:
            return token, _demo_tokens[token]
        new_token = str(uuid.uuid4())
        _demo_tokens[new_token] = 0
        return new_token, 0


def _increment_demo_token(token: str) -> int:
    """Increment use count and return the new total."""
    with _demo_token_lock:
        _demo_tokens[token] = _demo_tokens.get(token, 0) + 1
        return _demo_tokens[token]


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
FAL_VIDEO_MODEL = os.getenv("FAL_VIDEO_MODEL", "fal-ai/kling-video/v1.6/standard/text-to-video").strip()

# ─── LLM Personas — selected per generation mode ─────────────────────────────

_IMAGE_BRAIN_PROMPT = """You are the world's finest technical-creative visual director — part concept artist, part data visualizer, part fine-art photographer. You have encyclopedic command of art movements, photography, scientific illustration, infographic design, and data visualization. When someone speaks an idea, you translate it into a precise, richly evocative visual or diagram prompt.

RULES:
1. If the speaker describes a chart, graph, flow, timeline, sequence, or data structure → mode: "DIAGRAM" with valid Mermaid.js code (no backticks, no markdown fences).
2. If they describe a scene, object, mood, texture, visual style, or anything imageable → mode: "SKETCH" with a vivid, specific image prompt.
3. For refinements ("make it darker", "add a person", "change the color") keep the previous prompt's core and apply the change. Set "is_refinement": true.
4. Supported Mermaid types: graph TD, mindmap, pie, sequenceDiagram, xychart-beta, gantt.

Return JSON ONLY: { "mode": "DIAGRAM" or "SKETCH", "prompt": "...", "is_refinement": true/false }"""

_VIDEO_BRAIN_PROMPT = """You are the world's greatest cinematographer and visual director — with the mathematical symmetry of Wes Anderson, the atmospheric light of Roger Deakins, and the poetic melancholy of Wong Kar-wai. Every frame you envision is a painting with a deliberate point of view.

When someone describes an idea, a feeling, or a scene, translate it into a precise cinematic video prompt:
- Specific camera movement (slow dolly in, static overhead, handheld tracking, locked-off wide shot)
- Color palette (warm amber and cream, desaturated steel blues, deep emerald and burgundy)
- Lighting quality (late golden hour, cool overcast diffusion, hard rim light against dark background)
- Atmosphere and texture (dust motes, shallow depth of field, anamorphic lens flare, rain-streaked glass)
- Subject and action (what is moving, how, at what speed, with what weight)
- Emotional register (melancholic wonder, quiet joy, tense stillness)

Favor: symmetrical compositions, unexpected color palettes, stillness punctuated by precise motion, a sense of melancholic wonder. Make each prompt specific and immediately evocative — never generic.

Return JSON ONLY: { "mode": "VIDEO", "prompt": "...", "is_refinement": false }"""

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


def _fal_video_url(result):
    """Extract first video URL from a Fal video response."""
    if not result or not isinstance(result, dict):
        return None
    for key in ("video", "output", "result", "data"):
        inner = result.get(key)
        if isinstance(inner, dict):
            url = inner.get("url")
            if url:
                return str(url).strip()
        if isinstance(inner, list) and inner:
            item = inner[0]
            url = item.get("url") if isinstance(item, dict) else None
            if url:
                return str(url).strip()
    url = result.get("video_url") or result.get("url")
    return str(url).strip() if url else None


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
    generation_mode: str = Form(default="image"),
):
    request_id = str(uuid.uuid4())[:10]
    t0 = time.perf_counter()
    process_steps = []

    def trace_step(name: str, **detail):
        process_steps.append({"step": name, **detail})

    logger.info("========== /upload-audio [%s] START ==========", request_id)

    # --- DEMO GATE ---
    resolved_token, uses_so_far = _resolve_demo_token(demo_token)
    if uses_so_far >= _DEMO_LIMIT:
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

    # --- D. THE BRAIN — persona selected by generation_mode ---
    gmode = (generation_mode or "image").strip().lower()
    if gmode == "video":
        system_prompt = _VIDEO_BRAIN_PROMPT
    else:
        system_prompt = _IMAGE_BRAIN_PROMPT

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

        # Hard overrides
        if gmode == "video":
            mode = "VIDEO"
        elif any(w in user_text.lower() for w in ["diagram", "chart", "graph", "map", "plot"]):
            mode = "DIAGRAM"
        elif mode not in ("DIAGRAM", "VIDEO"):
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

    elif mode == "VIDEO":
        try:
            args = {
                "prompt": new_prompt,
                "duration": "5",
                "aspect_ratio": "16:9",
                "negative_prompt": "blurry, low quality, distorted",
            }
            trace_step("fal_video_start", model=FAL_VIDEO_MODEL, prompt_preview=new_prompt[:120])
            logger.info(
                "[%s] Fal video run_async %s prompt_preview=%s",
                request_id, FAL_VIDEO_MODEL, new_prompt[:120],
            )
            # Kling-class text-to-video routinely takes 3-8+ minutes for even a 5s clip —
            # 180s was killing every request before Fal finished rendering.
            result_v = await asyncio.wait_for(
                fal_client.run_async(FAL_VIDEO_MODEL, arguments=args),
                timeout=540.0,
            )
            media_url = _fal_video_url(result_v)
            final_seed = None
            if media_url:
                trace_step("fal_video", model=FAL_VIDEO_MODEL, ok=True, url=media_url)
                logger.info("[%s] Fal video URL: %s", request_id, media_url)
            else:
                trace_step("fal_video", model=FAL_VIDEO_MODEL, ok=False,
                           raw_preview=json.dumps(result_v, default=str)[:600])
                logger.error("[%s] Fal video response had no usable URL: %s",
                             request_id, json.dumps(result_v, default=str)[:800])
        except asyncio.TimeoutError:
            trace_step("fal_video", model=FAL_VIDEO_MODEL, ok=False, error="timeout")
            logger.error("[%s] Fal video request timed out", request_id)
            media_url = None
        except Exception as e:
            trace_step("fal_video", model=FAL_VIDEO_MODEL, ok=False, error=str(e))
            logger.exception("[%s] Fal video error: %s", request_id, e)
            media_url = None

    uses_now = _increment_demo_token(resolved_token)

    result = {
        "transcript": user_text,
        "mode": mode,
        "visual_prompt": new_prompt,
        "image_url": media_url,
        "video_url": media_url if mode == "VIDEO" else None,
        "diagram_code": diagram_code,
        "seed": final_seed,
        "demo_token": resolved_token,
        "demo_uses_remaining": max(0, _DEMO_LIMIT - uses_now),
    }

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    if mode == "SKETCH" and not media_url:
        outcome = "sketch_no_image_url"
    elif mode == "VIDEO" and not media_url:
        outcome = "video_no_url"
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

@app.post("/synthesize")
@limiter.limit("10/hour")
async def synthesize(
    request: Request,
    histories_json: str = Form(...),
    demo_token: str = Form(default=""),
):
    """Blend multiple speakers' histories into one unified image."""
    request_id = str(uuid.uuid4())[:10]
    logger.info("========== /synthesize [%s] START ==========", request_id)

    resolved_token, uses_so_far = _resolve_demo_token(demo_token)
    if uses_so_far >= _DEMO_LIMIT:
        raise HTTPException(status_code=429, detail="Demo limit reached")

    try:
        all_histories = json.loads(histories_json)
    except Exception:
        all_histories = []

    if not all_histories or all(len(h) == 0 for h in all_histories):
        return {"error": "No history to synthesize"}

    # Build a readable summary of each speaker's recent ideas
    lines = []
    for i, history in enumerate(all_histories):
        for item in history[-3:]:
            transcript = (item.get("transcript") or "").strip()
            if transcript:
                lines.append(f"Mind {i + 1}: {transcript}")

    combined = "\n".join(lines)
    logger.info("[%s] Synthesis input:\n%s", request_id, combined)

    system_prompt = """
You are a Visual Synthesis AI. Multiple people have been generating ideas separately.
Your task: create ONE unified image prompt that captures the shared essence of ALL their ideas.

Find the common themes, moods, and imagery across all minds, then blend them into a single coherent visual.
Do NOT list ideas separately. Synthesize them into one flowing description.

Return JSON ONLY: { "prompt": "..." }
"""

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Synthesize these separate visions into one:\n\n{combined}"},
            ],
            temperature=0.5,
            max_tokens=200,
        )
        decision = json.loads(response.choices[0].message.content)
        new_prompt = decision.get("prompt", "A harmonious blend of multiple creative perspectives unified into one vision")
    except Exception as e:
        logger.exception("[%s] Synthesis brain error: %s", request_id, e)
        new_prompt = "A harmonious convergence of multiple creative minds, their distinct visions merging into one unified world"

    logger.info("[%s] Synthesis prompt: %s", request_id, new_prompt[:200])

    media_url = None
    final_seed = random.randint(0, 100000000)

    try:
        fal_endpoint = FAL_IMAGE_MODEL
        if fal_endpoint not in ("fal-ai/flux/schnell", "fal-ai/flux-pro/v1.1"):
            fal_endpoint = "fal-ai/flux/schnell"

        args = {
            "prompt": new_prompt,
            "image_size": "landscape_16_9",
            "seed": final_seed,
            "num_inference_steps": 3,
            "acceleration": "high",
            "enable_safety_checker": True,
            "output_format": "jpeg",
        }
        result = await asyncio.wait_for(
            fal_client.run_async(fal_endpoint, arguments=args, timeout=75.0),
            timeout=80.0,
        )
        media_url = _fal_first_image_url(result)
        logger.info("[%s] Synthesis image URL: %s", request_id, (media_url or "")[:200])
    except Exception as e:
        logger.exception("[%s] Synthesis fal error: %s", request_id, e)

    uses_now = _increment_demo_token(resolved_token)

    logger.info("========== /synthesize [%s] END ==========", request_id)
    return {
        "transcript": "Shared Vision",
        "mode": "SKETCH",
        "visual_prompt": new_prompt,
        "image_url": media_url,
        "diagram_code": None,
        "seed": final_seed,
        "demo_token": resolved_token,
        "demo_uses_remaining": max(0, _DEMO_LIMIT - uses_now),
        "is_synthesis": True,
    }



# ─── Mockup mode: live-patch UI spec generation ──────────────────────────────

_MOCKUP_VALID_TYPES = {
    "NavBar", "TabBar", "Sheet", "Card", "Section", "List", "ListRow",
    "Button", "TextField", "SearchBar", "Toggle", "Slider",
    "SegmentedControl", "Stepper", "Badge", "ProgressIndicator",
    "Alert", "Toast", "Avatar", "Image", "Icon",
}

_MOCKUP_SYSTEM_PROMPT = """You are the world's foremost UI/UX designer — you create seamless, beautiful, Apple-quality interfaces that feel alive. You think in spatial layouts, micro-interactions, and human-centered flows. Every element you place serves a purpose and delights the user.

You maintain a single evolving UI spec as JSON, updated every ~2.5 seconds from live group conversation. Multiple speakers may be talking about the same thing, refining each other's ideas out loud, disagreeing, joking, or just brainstorming vaguely. Your job is to turn that messy talk into a coherent, incrementally-evolving spec — never a literal transcript, never a guess dressed up as a decision.

You will receive:
1. The previous spec (or null if this is iteration 1)
2. The new transcript chunk (~2.5s of raw speech, possibly mid-sentence, possibly multiple overlapping speakers, possibly a fragment with no clear subject)

CORE RULES:

1. FIXED VOCABULARY ONLY. Only use component types from: [NavBar, TabBar, Sheet, Card, Section, List, ListRow, Button, TextField, SearchBar, Toggle, Slider, SegmentedControl, Stepper, Badge, ProgressIndicator, Alert, Toast, Avatar, Image, Icon]. Never invent a new type.

2. THEME IS FULLY UNDER THE USER'S CONTROL — color, corner radius, and named design-company styles all live in spec.theme and recolor/reshape the WHOLE prototype at once. Spacing (4/8/12/16/24/32/48/64) is the only truly fixed token.
   - COLOR: when the user asks to change the color scheme / accent / "make the buttons green" / "use a purple theme", set spec.theme.accent to that color. This recolors all buttons, active tabs, icons, links, sliders, badges, and progress bars at once. Accept color words (red, orange, yellow, green, mint, teal, cyan, blue, indigo, purple, pink, brown, gray, black) OR hex like "#FF3B30".
   - DARK / BLACK / GRAY THEME: when the user asks for a dark, black, gray, or night theme, set spec.theme.background to "black" (or a dark hex like "#000000" / "#1C1C1E"), OR set spec.theme.mode:"dark". This flips the ENTIRE prototype to dark mode — cards, lists, rows, bars all become dark surfaces and text turns white automatically. You do NOT need to color individual components; just set the theme. For a light theme again, set theme.mode:"light" or a light background.
   - CORNER RADIUS / SHAPE: set spec.theme.radius to one of "sharp" (4-6px, blocky/technical), "soft" (8px, the default), "rounded" (12-16px, friendly), or "pill" (fully rounded, playful). "make it more rounded" → rounded/pill; "make it sharper/more square/more technical" → sharp.
   - NAMED DESIGN-COMPANY STYLES: if the user says "make it look like <company>" or "give it a <company> feel", apply that company's recognizable style as a real, distinct theme — not a generic default. Use this mapping (theme.accent + theme.mode/background + theme.radius):
     • Apple/iOS: accent "blue" (#007AFF), light mode, radius "soft"
     • Linear: accent "#5E6AD2" (indigo/purple), dark mode (background "black"), radius "sharp"
     • Notion: accent "black" or very dark gray, light mode, radius "sharp", minimal — avoid bright colors on components unless asked
     • Stripe: accent "#635BFF" (violet/indigo), light mode, radius "soft"
     • Airbnb: accent "#FF385C" (coral/red), light mode, radius "rounded" or "pill"
     • Spotify: accent "green" (#1DB954), dark mode (background "black"), radius "rounded"
     • Discord: accent "#5865F2" (blurple), dark mode, radius "rounded"
     • Figma: accent "#0ACF83" or "purple", light mode, radius "sharp"
     • Vercel/Vercel-minimal: accent "black"/"white" only (near-monochrome), light OR dark mode, radius "sharp"
     • Google/Material: accent "blue" (#4285F4), light mode, radius "rounded"
     Each of these must produce a visibly different result — different accent hue, different radius, and light vs. dark — so the user can tell them apart at a glance.
   - To recolor just ONE element, put a color on that component: Button {color:"green"}, Icon {color:"#FF9500"}, Badge {color:"red"}, ListRow {iconColor:"purple"}.
   - Default (nothing specified) is a light theme, blue accent, "soft" 8px radius — refined and neutral, not colorful. Always ACT on an explicit color/radius/style request — never no-op it. Preserve an already-set theme across later iterations unless the user changes it again.

3. REFINEMENT OVER ADDITION. Rapid back-and-forth about the same idea modifies existing components, not duplicates them.

4. WAIT FOR PRECISION. Pure filler with no product content (greetings, "um", silence artifacts) → no-op. But once a concrete app, screen, feature, or content type IS named, ACT — don't stall.

5. COMPOSE COMPLETE, REALISTIC SCREENS — BUT STAY UNCLUTTERED. This is the most important rule. When someone names an app or screen ("a music app home screen", "a settings page", "a chat app"), do NOT add a single lone Button. Build a real screen with realistic placeholder content, but keep it CALM, not crowded:
   - A NavBar is NOT automatic. Only add one when it earns its place: the screen has a real title worth showing, a back-target to a screen that led here, or a trailing action (Edit/Done/+). A top-level screen reached via the TabBar (a home feed, a full-bleed gallery) can be immersive and skip the NavBar entirely — real apps like Instagram/TikTok/Spotify's Now Playing routinely do this. Never add a NavBar just out of habit; an empty title bar with nothing in it is worse than no bar.
   - Pick ONE primary content block for the screen (a single List, OR a hero + a couple of Cards, OR a form) — not four different content types stacked on top of each other. A real screen has a clear focal point.
   - For lists of things, use ONE List with a rows array of 3-5 realistic rows (real-sounding names/titles in label, a subtitle in detail, an icon or Avatar, trailing "chevron"). Prefer fewer, well-chosen rows over a long list — this is a mockup, not a data dump.
   - Add AT MOST one or two pieces of supporting chrome beyond the NavBar: e.g. a SearchBar OR a SegmentedControl filter (not both unless explicitly asked), plus a TabBar (3-5 tabs with icons) if it's a full app. Skip chrome the user didn't imply.
   - Use real example data appropriate to the domain (song titles + artists for music, contact names + last-message for chat, setting names for settings). Placeholder realism is what makes it feel designed, not sketchy.
   A first iteration should look like a finished, breathable screen someone could screenshot — generous whitespace, one clear focus, not a wireframe stub AND not a kitchen sink.

5b. PREFER List-with-rows over loose components. To show a collection, emit a List whose props.rows is an array of {id,label,detail,icon,trailing:"chevron"} — that renders as a proper grouped iOS list. Do NOT scatter many standalone Buttons to fake a list.

5c. USE REAL IMAGERY. The renderer draws actual pictures, not gray boxes:
   - Photo: Image with props {query:"<subject>", height:<px>} → renders a real stable photo of that subject. Use for hero banners, article thumbnails, place cards.
   - Album/cover art: Image with props {style:"gradient", label:"<title>"} → a colored gradient tile with the title, like Apple Music/Spotify cards. Use for music, playlists, profiles.
   - Custom vector: Image with props {svg:"<svg ...>...</svg>"} → renders your inline SVG verbatim. Use for logos, illustrations, custom graphics.
   - List rows and Avatars can carry a real image too: row {image:"https://..."} or Avatar {src:"https://..."}.
   ICONS are crisp SVGs — use these semantic names anywhere an icon prop appears (NavBar/TabBar/ListRow/Icon): home, search, settings, user, heart, star, plus, check, close, bell, message, music, play, pause, camera, location, mail, phone, share, edit, trash, calendar, clock, grid, list, radio, compass, bookmark, cart, lock, album, download, filter, play_circle, plus_circle. NEVER use emoji anywhere — not in icons, labels, titles, or content. Icons must be one of these names only; if none fits, omit the icon rather than substituting an emoji.

5d. PLATFORM: PHONE vs. WEBPAGE. Default is a mobile phone app (spec.platform:"mobile" or omitted → 375-wide iOS frame). If the user says "make this a webpage / website / desktop site / landing page", set spec.platform:"web". A web layout renders in a wide desktop browser frame, so compose it like a real website:
   - The NavBar becomes a horizontal top nav — give it props.links: an array of {label, target?} (e.g. Home, Features, Pricing, About). Do NOT use a bottom TabBar on web.
   - Lead with a hero: a big headline (use a Card with a large title/body, or an Image with query for a hero banner), then a primary Button ("Get Started").
   - Follow with website sections: feature Cards in a row, a List of items, testimonials, a footer-like Section. Content sits in a centered column.
   - Switching an existing mobile mockup to web (or vice-versa) is just flipping spec.platform — keep the content, change the frame.

5e. WIRE SCREENS INTO A REAL FLOW. This app has a separate "user flow" chart that draws an arrow for every navigable link between screens, so every screen you add should connect to the flow, not float disconnected:
   - The primary action on a screen (the main Button, or a ListRow that opens a detail view) should carry props.target set to the id of the screen it leads to. Example: a login screen's "Log In" Button gets {label:"Log In", target:"screen_home"}; a Settings list row "Account" gets {label:"Account", target:"screen_account"}.
   - When you create a new screen because of something a user tapped/said leads there ("then it goes to a profile screen", "tapping a song opens the player"), ALSO set target on the originating element in the SOURCE screen so the two screens are linked. Do this even if the user only described the destination, not the exact button — attach it to the most obviously relevant existing Button/ListRow.
   - TabBar tabs and NavBar back-links already connect screens via their own target fields — keep using those as before.
   - Every screen should be reachable from somewhere; a screen with zero incoming links is a mistake unless it's explicitly the app's entry screen.

5f. DRILL-DOWN SCREENS MUST HAVE A WAY BACK — TAB-BAR SCREENS DO NOT. If a screen is reached by tapping into something (a list row, a button, a "view details" action) rather than by a TabBar tab, it MUST include a NavBar with props.leading = {"type":"back","label":"Back","target":"<id of the screen that leads here>"} — a drill-down screen with no way out is a dead end. But a screen that IS one of the TabBar's own tab targets does NOT need a back button — switching tabs is how the user leaves it, so forcing a NavBar there is redundant clutter; skip it (or give it a bare title-only NavBar with no back leading, only if a title is genuinely useful). When you add a new drill-down screen, add its back-target NavBar in the SAME edit, not "later."

6. REFINE, DON'T PILE UP. Follow-up talk about the same thing edits existing components in place. NEVER REMOVE unless removal is explicit and unambiguous.

7. COMBINE FRAGMENTS. Speech arrives in short chunks that split sentences mid-thought. When earlier unconsumed fragments are provided, read them TOGETHER with the new chunk as one continuous utterance. If the combined text expresses a concrete UI intent (e.g. "generate for me" + "a blue" + "iPhone app home screen"), ACT on it now — do not wait for a perfectly formed sentence in a single chunk. A first iteration with a plausible starting screen beats an endless no-op streak. Bias toward action once any concrete noun (screen, button, list, field, header...) or color/style has been mentioned.

FRINGE CASES:
a. CONTRADICTION/DISAGREEMENT: If speakers disagree in the same chunk, no-op — wait for resolution.
b. OFF-TOPIC/SMALL TALK: Not about the product → no-op.
c. META-COMMENTARY about the tool itself → no-op.
d. RETRACTION/UNDO: Clear reversal → remove/revert the specific component.
e. REFERENTIAL AMBIGUITY: "make that bigger" without clear referent → no-op.
f. OVERLAPPING GARBLED SPEECH: Can't parse coherent intent → no-op.
g. SCOPE CREEP/NEW SCREEN: Default to current screen unless explicitly stated ("let's make a settings page"). When creating a new screen, fully compose it per rule 5 (NavBar with title + populated primary content + expected chrome), and set back-nav in NavBar leading pointing to the origin screen.
h. HYPOTHETICALS BEING WEIGHED: "what if it was a toggle" (not decided) → no-op.
i. VAGUE QUANTITIES: "a few buttons" → no-op until specific.
j. REPEATED IDENTICAL REQUESTS: Already in spec → no-op.

OUTPUT BEHAVIOR:
- If ANY confident, resolvable change: output the full updated spec JSON with changeType "added"/"modified"/"removed" on affected components and a changeLog array.
- If NO confident change: output exactly {"noOp": true} and nothing else.
- Output ONLY valid JSON. No prose outside changeLog fields.

JSON spec schema (this is the shape AND the richness bar — a music home screen, fully composed):
{
  "iterationNumber": 1,
  "previousIterationRef": null,
  "transcriptChunk": "make a music app home screen",
  "platform": "mobile",
  "theme": {"accent": "#007AFF"},
  "screens": [
    {
      "id": "screen_home",
      "name": "Listen Now",
      "components": [
        {"id": "c1", "type": "NavBar", "props": {"title": "Listen Now", "leading": null, "trailing": "Edit"}},
        {"id": "c2", "type": "SearchBar", "props": {"placeholder": "Artists, Songs, Lyrics"}},
        {"id": "c3", "type": "SegmentedControl", "props": {"segments": ["For You", "Charts", "Radio"], "selectedIndex": 0}},
        {"id": "c4", "type": "Image", "props": {"style": "gradient", "label": "New Music Daily", "height": 170}},
        {"id": "c5", "type": "List", "props": {"rows": [
          {"id": "r1", "label": "Blinding Lights", "detail": "The Weeknd", "icon": "music", "trailing": "chevron"},
          {"id": "r2", "label": "As It Was", "detail": "Harry Styles", "icon": "music", "trailing": "chevron"},
          {"id": "r3", "label": "Bad Habit", "detail": "Steve Lacy", "icon": "music", "trailing": "chevron"},
          {"id": "r4", "label": "Anti-Hero", "detail": "Taylor Swift", "icon": "music", "trailing": "chevron"},
          {"id": "r5", "label": "Flowers", "detail": "Miley Cyrus", "icon": "music", "trailing": "chevron"}
        ]}},
        {"id": "tb", "type": "TabBar", "props": {"tabs": [
          {"label": "Listen Now", "icon": "play", "target": "screen_home"},
          {"label": "Browse", "icon": "grid"},
          {"label": "Radio", "icon": "radio"},
          {"label": "Search", "icon": "search"}
        ]}}
      ]
    }
  ],
  "changeLog": ["created Listen Now home screen with search, filters, featured art, a song list, and tab bar"]
}"""


_MOCKUP_TYPE_ALIASES = {
    "header": "NavBar", "navbar": "NavBar", "navigationbar": "NavBar", "nav": "NavBar",
    "tabbar": "TabBar", "tabs": "TabBar", "bottombar": "TabBar",
    "modal": "Sheet", "bottomsheet": "Sheet", "drawer": "Sheet",
    "container": "Card", "box": "Card", "panel": "Card",
    "group": "Section", "sectionheader": "Section",
    "listview": "List", "table": "List", "scrollview": "List",
    "row": "ListRow", "listitem": "ListRow", "cell": "ListRow", "item": "ListRow",
    "cta": "Button", "link": "Button",
    "input": "TextField", "textinput": "TextField", "field": "TextField",
    "search": "SearchBar", "searchfield": "SearchBar",
    "switch": "Toggle", "checkbox": "Toggle",
    "range": "Slider",
    "segmented": "SegmentedControl", "tabs_control": "SegmentedControl",
    "counter": "Stepper",
    "tag": "Badge", "chip": "Badge", "pill": "Badge",
    "progress": "ProgressIndicator", "spinner": "ProgressIndicator", "loading": "ProgressIndicator",
    "dialog": "Alert", "popup": "Alert",
    "notification": "Toast", "snackbar": "Toast",
    "profilepicture": "Avatar", "profileimage": "Avatar",
    "photo": "Image", "picture": "Image", "thumbnail": "Image",
    "symbol": "Icon", "glyph": "Icon",
}


def _sanitise_spec(spec: dict) -> dict:
    """Strip or remap any component types outside the fixed vocabulary; never fail outright."""
    if not isinstance(spec, dict) or spec.get("noOp") is True:
        return spec
    for screen in spec.get("screens", []):
        cleaned = []
        for comp in screen.get("components", []):
            t = comp.get("type", "")
            if t not in _MOCKUP_VALID_TYPES:
                remapped = _MOCKUP_TYPE_ALIASES.get(t.lower().replace(" ", "").replace("_", ""))
                if remapped:
                    comp = {**comp, "type": remapped}
                    logger.info("Remapped component type '%s' → '%s'", t, remapped)
                else:
                    logger.warning("Dropping unknown component type '%s'", t)
                    continue
            cleaned.append(comp)
        screen["components"] = cleaned
    return spec


def _validate_mockup_spec(spec: dict) -> bool:
    """Return False only for structurally broken output (missing screens list)."""
    if not isinstance(spec, dict):
        return False
    if spec.get("noOp") is True:
        return True
    if not isinstance(spec.get("screens"), list):
        return False
    return True


# Whisper reliably hallucinates these on silent/near-silent chunks — never feed them to the spec model
_WHISPER_HALLUCINATIONS = {
    "you", "bye", "bye-bye", "hello", "thank you", "thanks", "thank you very much",
    "thank you for watching", "thanks for watching", "thank you for watching!",
    "thank you for joining us", "thank you for your attention", "see you next time",
    "subtitles by the amara.org community",
}


def _is_hallucinated(text: str) -> bool:
    t = text.lower().strip().rstrip(".!?").strip()
    if not t or len(t) < 3:
        return True
    if "субтитры" in t or "dimatorzok" in t or "amara.org" in t:
        return True
    # Chunks composed purely of thank-you/bye filler (possibly repeated) are silence artifacts
    parts = [p.strip() for p in re.split(r"[.!?,]+", t) if p.strip()]
    return all(p in _WHISPER_HALLUCINATIONS for p in parts) if parts else True


def _call_live_patch(previous_spec_json: str, transcript: str, context_text: str = "") -> dict:
    user_content = f"Previous spec:\n{previous_spec_json}\n"
    if context_text:
        user_content += (
            f"\nEarlier speech fragments from this session that have NOT yet produced a spec change "
            f"(combine them with the new chunk to infer intent):\n{context_text}\n"
        )
    user_content += f"\nNew transcript chunk:\n{transcript}"
    response = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _MOCKUP_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        max_tokens=2000,
        temperature=0.3,
    )
    return json.loads(response.choices[0].message.content)


@app.post("/mockup")
@limiter.limit("60/minute")
async def mockup_endpoint(
    request: Request,
    file: UploadFile = File(...),
    previous_spec_json: str = Form(default="null"),
    context_text: str = Form(default=""),
    demo_token: str = Form(default=""),
):
    """Live-patch the evolving UI spec from a 2.5s audio chunk."""
    request_id = str(uuid.uuid4())[:10]
    logger.info("========== /mockup [%s] START ==========", request_id)

    resolved_token, uses_so_far = _resolve_demo_token(demo_token)
    if uses_so_far >= _DEMO_LIMIT:
        raise HTTPException(status_code=429, detail="Demo limit reached")

    audio_bytes = await file.read()

    # Transcribe
    try:
        transcript_resp = client.audio.transcriptions.create(
            model="whisper-1",
            file=("voice.wav", audio_bytes, "audio/wav"),
        )
        transcript = (transcript_resp.text or "").strip()
        logger.info("[%s] Transcript: %s", request_id, transcript[:200])
    except Exception as e:
        logger.error("[%s] Whisper error: %s", request_id, e)
        return {"noOp": True, "transcript": "", "error": "transcription_failed"}

    if not transcript:
        return {"noOp": True, "transcript": ""}

    if _is_hallucinated(transcript):
        logger.info("[%s] Dropped Whisper hallucination: %r", request_id, transcript[:120])
        return {"noOp": True, "transcript": "", "hallucination": True}

    # Live-patch with one retry; sanitise unknown types before validating
    spec = None
    for attempt in range(2):
        try:
            result = await asyncio.to_thread(_call_live_patch, previous_spec_json, transcript, context_text)
            result = _sanitise_spec(result)
            if _validate_mockup_spec(result):
                spec = result
                break
            logger.warning("[%s] Schema validation failed on attempt %d: %s", request_id, attempt + 1,
                           json.dumps(result, ensure_ascii=False)[:400])
        except Exception as e:
            logger.warning("[%s] Live-patch attempt %d failed: %s", request_id, attempt + 1, e)

    if spec is None:
        logger.error("[%s] Both live-patch attempts failed", request_id)
        return {"error": "generation_failed", "transcript": transcript}

    if spec.get("noOp"):
        logger.info("[%s] noOp — no spec change", request_id)
        return {"noOp": True, "transcript": transcript}

    # Only increment demo counter on real changes
    uses_now = _increment_demo_token(resolved_token)
    remaining = max(0, _DEMO_LIMIT - uses_now)

    logger.info("========== /mockup [%s] END (iteration %s) ==========", request_id, spec.get("iterationNumber"))
    return {
        "spec": spec,
        "noOp": False,
        "transcript": transcript,
        "demo_token": resolved_token,
        "demo_uses_remaining": remaining,
    }


@app.post("/mockup-export")
@limiter.limit("30/hour")
async def mockup_export(
    request: Request,
    spec_json: str = Form(...),
    transcript: str = Form(default=""),
    iteration_number: int = Form(default=1),
):
    """Bundle a single mockup iteration into a standalone zip."""
    try:
        spec = json.loads(spec_json)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid spec JSON")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("spec.json", json.dumps(spec, indent=2, ensure_ascii=False))
        zf.writestr("transcript.txt", transcript)

        # Minimal standalone HTML that wraps the spec in a static viewer
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Iteration {iteration_number}</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div class="frame">
  <pre id="spec-debug">{json.dumps(spec, indent=2, ensure_ascii=False)}</pre>
</div>
<script src="script.js"></script>
</body>
</html>"""
        zf.writestr("index.html", html)

        css = """body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1c1c1e;font-family:-apple-system,"SF Pro Text",system-ui,sans-serif}
.frame{width:375px;height:667px;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.5);padding:16px;box-sizing:border-box;overflow-y:auto}
pre{font-size:11px;white-space:pre-wrap;word-break:break-all;color:#1c1c1e}"""
        zf.writestr("styles.css", css)
        zf.writestr("script.js", "// Buddy mockup export — iteration " + str(iteration_number))

    zip_buffer.seek(0)
    filename = f"iteration-{iteration_number:02d}.zip"
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
            text_obj = c.beginText(40, 750)
            for line in summary_lines:
                text_obj.textLine(line)
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