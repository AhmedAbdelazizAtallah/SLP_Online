import os
os.environ['TF_ENABLE_ONEDNN_OPTS']='0'
os.environ['TF_CPP_MIN_LOG_LEVEL']='2'
import sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Literal
import numpy as np
import asyncio, json, time, threading, hashlib, re

# Label order matches each TFLite model's TRAINING class order (verified empirically):
#  - arsl_model.tflite (33 classes): ArASL order (Ain, Al, Alef, Beh, Dad, ... Zain)
#  - asl_model.tflite  (28 classes): A-Z then del, space
AR_LABELS_ENG = ['Ain', 'Al', 'Alef', 'Beh', 'Dad', 'Dal', 'Feh', 'Ghain', 'Hah', 'Heh', 'Jeem', 'Kaf', 'Khah', 'Laa', 'Lam', 'Meem', 'Noon', 'Qaf', 'Reh', 'Sad', 'Seen', 'Sheen', 'Tah', 'Teh', 'Teh_Marbuta', 'Thal', 'Theh', 'Waw', 'Yeh', 'Zah', 'Zain', 'del', 'space']
AR_FINAL = ['ع', 'ال', 'ا', 'ب', 'ض', 'د', 'ف', 'غ', 'ح', 'ه', 'ج', 'ك', 'خ', 'لا', 'ل', 'م', 'ن', 'ق', 'ر', 'ص', 'س', 'ش', 'ط', 'ت', 'ة', 'ذ', 'ث', 'و', 'ي', 'ظ', 'ز', 'DEL', 'SPACE']
EN_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'del', 'space']
EN_FINAL = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'DEL', 'SPACE']

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(BASE_DIR, "app.html")
VENDOR_DIR = os.path.join(BASE_DIR, "vendor")
ICONS_DIR = os.path.join(BASE_DIR, "icons")

Factory = None
ENGINE = "unknown"
interpreter_ar = None
interpreter_en = None
inference_lock = threading.Lock()

try:
    import tensorflow as tf                                          # linux deploy: tensorflow-cpu
    print(f"TF {tf.__version__}")
    resolver = tf.lite.experimental.OpResolverType.AUTO
    from tensorflow.lite.python.interpreter import Interpreter as _TFI
    Factory = lambda p: _TFI(model_path=p, experimental_op_resolver_type=resolver)
    ENGINE = "tensorflow"
    print("OK Engine: tensorflow (TFLite + Flex AUTO)")
except Exception as e:
    try:
        from tensorflow.lite.python.interpreter import Interpreter as _TFI2
        Factory = lambda p: _TFI2(model_path=p)
        ENGINE = "tensorflow-fallback"
        print(f"Fallback {e}")
    except Exception as e2:
        Factory = None
        ENGINE = "none"
        print(f"No TF interpreter available: {e2}")

def load():
    global interpreter_ar, interpreter_en
    for filename, name in [("arsl_model.tflite", "ar"), ("asl_model.tflite", "en")]:
        full_path = os.path.join(BASE_DIR, filename)
        if not os.path.exists(full_path):
            print(f"[MISS] {full_path} missing")
            continue
        if Factory is None:
            print("[FAIL] Interpreter factory is None")
            continue
        try:
            it = Factory(full_path)
            it.allocate_tensors()
            if name == "ar":
                interpreter_ar = it
            else:
                interpreter_en = it
            print(f"[OK] {name} {filename} Input {it.get_input_details()[0]['shape']} Output {it.get_output_details()[0]['shape']}")
        except Exception as e:
            import traceback; traceback.print_exc()
            print(f"[FAIL] loading {filename}: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load models in the background so the port binds immediately and
    # platform health checks pass while TF warms up.
    threading.Thread(target=load, daemon=True).start()
    yield

app = FastAPI(title="Sign Language Platform NEXT - Studio + Sign Rooms", lifespan=lifespan)
# No allow_credentials with wildcard origins (invalid per CORS spec; the app
# doesn't use cookies - plain token-free JSON + WebSocket only).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

MAX_SEQUENCE_FRAMES = 120  # model needs 23 frames; generous cap for padding variants

class Req(BaseModel):
    sequence: list
    language: Literal["ar", "en"] = "ar"

def prep(s):
    try:
        if not isinstance(s, list) or not s:
            raise ValueError("sequence must be a non-empty list")
        if len(s) > MAX_SEQUENCE_FRAMES:
            raise ValueError(f"sequence too long (max {MAX_SEQUENCE_FRAMES} frames)")
        a = np.asarray(s, dtype=np.float32)
        if a.size > MAX_SEQUENCE_FRAMES * 63:
            raise ValueError("payload too large")
        if not np.all(np.isfinite(a)):
            raise ValueError("sequence contains non-finite values")
        if a.ndim == 1 and a.size == 63:
            a = np.tile(a, (23, 1))
        elif a.ndim == 2 and a.shape[1] == 63:
            if a.shape[0] < 23:
                # Pad with the last frame if sequence length is under 23
                pad = np.tile(a[-1:], (23 - a.shape[0], 1))
                a = np.vstack([a, pad])
            elif a.shape[0] > 23:
                a = a[-23:]
        if a.shape != (23, 63):
            raise ValueError("expected one 63-value frame or a sequence of 63-value frames")
        return np.expand_dims(a, 0)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid sequence data: {str(e)}")

@app.api_route("/", methods=["GET", "HEAD"])
def home():
    if os.path.exists(INDEX_PATH):
        return FileResponse(INDEX_PATH)
    return {"status": "ok", "ar_loaded": interpreter_ar is not None, "en_loaded": interpreter_en is not None}

@app.get("/health")
def health():
    return {"status": "ok", "engine": ENGINE, "ar_loaded": interpreter_ar is not None, "en_loaded": interpreter_en is not None}

@app.get("/models")
def models():
    def info(it):
        if it is None:
            return None
        return {
            "input": [int(x) for x in it.get_input_details()[0]['shape']],
            "output": [int(x) for x in it.get_output_details()[0]['shape']],
            "dtype": str(it.get_input_details()[0]['dtype'])
        }
    return {"ar": info(interpreter_ar), "en": info(interpreter_en)}

@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    icon = os.path.join(ICONS_DIR, "icon-192.png")
    if os.path.exists(icon):
        return FileResponse(icon, media_type="image/png")
    return FileResponse(INDEX_PATH) if os.path.exists(INDEX_PATH) else {"status": "ok"}

@app.get("/app.compiled.js", include_in_schema=False)
def compiled_js():
    path = os.path.join(BASE_DIR, "app.compiled.js")
    if os.path.exists(path):
        return FileResponse(path, media_type="text/javascript")
    raise HTTPException(status_code=404, detail="compiled bundle missing - run build.ps1")

def _static_file(rel_dir, fname):
    """Serve a whitelisted static file by bare filename only (no path traversal)."""
    fname = fname or ""
    safe = os.path.basename(fname)
    if not safe or safe != fname:
        raise HTTPException(status_code=404)
    path = os.path.join(BASE_DIR, rel_dir, safe)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404)
    ext = safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
    mime = {
        "js": "text/javascript",
        "json": "application/json",
        "webmanifest": "application/manifest+json",
        "png": "image/png",
        "svg": "image/svg+xml",
        "html": "text/html; charset=utf-8",
    }.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=mime)

@app.get("/vendor/{fname}", include_in_schema=False)
def vendor_file(fname: str):
    return _static_file("vendor", fname)

@app.get("/icons/{fname}", include_in_schema=False)
def icons_file(fname: str):
    return _static_file("icons", fname)

@app.get("/manifest.json", include_in_schema=False)
def manifest_file():
    return _static_file(".", "manifest.json")

@app.get("/sw.js", include_in_schema=False)
def sw_file():
    return _static_file(".", "sw.js")

STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun2.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
    "stun:stun.relay.metered.ca:80",
]

@app.get("/api/ice-servers")
def ice_servers():
    """Return public STUN servers and an optional environment-managed TURN relay."""
    turn_url = os.getenv("TURN_URL", "").strip()
    turn_user = os.getenv("TURN_USERNAME", "").strip()
    turn_cred = os.getenv("TURN_CREDENTIAL", "").strip()
    servers = [{"urls": STUN_SERVERS}]
    urls = [u.strip() for u in turn_url.split(",") if u.strip()]
    if urls:
        entry = {"urls": urls}
        if turn_user:
            entry["username"] = turn_user
        if turn_cred:
            entry["credential"] = turn_cred
        servers.append(entry)
    return {"iceServers": servers}

# ---- Client error reporting (lightweight field diagnostics) ----
ERRORS_LOG = os.path.join(BASE_DIR, "client_errors.log")
_err_hits = {}  # ip -> [timestamps]
ERR_RATE_LIMIT = int(os.getenv("ERR_RATE_LIMIT", "20"))  # per minute per IP

class ClientErr(BaseModel):
    message: str = ""
    stack: str = ""
    url: str = ""

@app.post("/api/client-error")
def client_error(e: ClientErr, request: Request):
    ip = request.client.host if request.client else "?"
    now = time.time()
    hits = [t for t in _err_hits.get(ip, []) if now - t < 60]
    if len(hits) >= ERR_RATE_LIMIT:
        _err_hits[ip] = hits
        return {"ok": True, "throttled": True}
    hits.append(now)
    _err_hits[ip] = hits
    line = json.dumps({
        "ts": round(now, 3), "ip": ip,
        "url": (e.url or "")[:300],
        "message": (e.message or "")[:500],
        "stack": (e.stack or "")[:2000],
    }, ensure_ascii=False)
    try:
        with open(ERRORS_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    return {"ok": True}

@app.post("/predict")
def predict(r: Req):
    lang = r.language.lower()
    interp = interpreter_ar if lang == "ar" else interpreter_en
    letters = AR_FINAL if lang == "ar" else EN_FINAL
    eng_names = AR_LABELS_ENG if lang == "ar" else EN_LABELS
    data = prep(r.sequence)
    if interp is None:
        raise HTTPException(status_code=503, detail=f"{lang} model is not ready")

    with inference_lock:
        in_d = interp.get_input_details()
        out_d = interp.get_output_details()
        interp.set_tensor(in_d[0]['index'], data.astype(in_d[0]['dtype']))
        interp.invoke()
        probs = interp.get_tensor(out_d[0]['index'])[0]

    idx = int(np.argmax(probs))
    conf = float(np.max(probs))
    letter = letters[idx] if idx < len(letters) else f"cls_{idx}"
    top3 = np.argsort(probs)[-3:][::-1]
    top3_list = [{"letter": letters[i] if i < len(letters) else f"cls_{i}", "eng": eng_names[i] if i < len(eng_names) else f"cls_{i}", "conf": float(probs[i])} for i in top3 if i < len(probs)]
    english_name = eng_names[idx] if idx < len(eng_names) else f"cls_{idx}"
    return {"letter": letter, "english_name": english_name, "class_id": idx, "confidence": conf, "top3": top3_list, "language": lang}

# ---- WebRTC mesh signaling for SIGN ROOMS and ONLINE CALL (room codes supported) ----
ROOMS = {}      # room -> {client_id: WebSocket}
ROOM_PINS = {}  # room -> sha256(pin) hex - set by the room creator on first join
WS_SEND_LOCKS = {}
MAX_ROOM_SIZE = int(os.getenv("MAX_ROOM_SIZE", "8"))
MAX_WS_MESSAGE = 300_000  # bytes; stream_frame JPEGs (~20KB) fit comfortably
ALLOWED_WS_TYPES = {"hello", "offer", "answer", "candidate", "cap", "stream_frame"}

async def _send_json(sock, msg):
    lock = WS_SEND_LOCKS.setdefault(sock, asyncio.Lock())
    async with lock:
        await sock.send_text(json.dumps(msg))

async def _broadcast(room, msg, exclude=None):
    for cid, sock in list(ROOMS.get(room, {}).items()):
        if cid == exclude:
            continue
        try:
            await _send_json(sock, msg)
        except Exception:
            pass

@app.websocket("/ws")
async def ws(websocket: WebSocket, room: str = "default", client: str = "", pin: str = ""):
    await websocket.accept()
    room = re.sub(r"[^A-Z0-9_-]", "", (room or "DEFAULT").strip().upper())[:16] or "DEFAULT"
    client = re.sub(r"[^A-Za-z0-9_-]", "", (client or "").strip())[:32]
    if not client:
        client = "p" + str(int(time.time() * 1000))
    # Room PIN: first joiner who supplies one locks the room to that PIN.
    expected = ROOM_PINS.get(room)
    if expected is not None:
        supplied = hashlib.sha256((pin or "").encode("utf-8")).hexdigest()
        if supplied != expected:
            try:
                await _send_json(websocket, {"type": "room-denied"})
                await websocket.close(code=1008)
            except Exception:
                pass
            WS_SEND_LOCKS.pop(websocket, None)
            return
    elif pin:
        ROOM_PINS[room] = hashlib.sha256(pin.encode("utf-8")).hexdigest()
    peers = ROOMS.setdefault(room, {})
    if client not in peers and len(peers) >= MAX_ROOM_SIZE:
        try:
            await _send_json(websocket, {"type": "room-full"})
            await websocket.close(code=1013)
        except Exception:
            pass
        WS_SEND_LOCKS.pop(websocket, None)
        return
    # Reconnect with the same client id: register the new socket FIRST, then
    # close the stale one. The stale handler's cleanup is identity-checked (see
    # finally below) so it can never evict the live connection from the room.
    old = ROOMS.get(room, {}).get(client)
    ROOMS[room][client] = websocket
    if old is not None and old is not websocket:
        try:
            await old.close(code=4000)
        except Exception:
            pass
    try:
        await _send_json(websocket, {"type": "roster", "self": client, "ids": [k for k in ROOMS[room] if k != client]})
    except Exception:
        pass
    await _broadcast(room, {"type": "peer-joined", "id": client}, exclude=client)
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_WS_MESSAGE:
                await websocket.close(code=1009)
                return
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                # Heartbeat - used by clients to detect dead connections.
                try:
                    await _send_json(websocket, {"type": "pong", "t": msg.get("t")})
                except Exception:
                    pass
                continue
            if mtype not in ALLOWED_WS_TYPES:
                continue
            if "name" in msg:
                msg["name"] = str(msg.get("name") or "")[:80]
            if "role" in msg:
                msg["role"] = "hearing" if msg.get("role") == "hearing" else "deaf"
            if mtype == "cap":
                if not isinstance(msg.get("text"), str):
                    continue
                msg["text"] = msg["text"][:4000]
                msg["kind"] = msg.get("kind") if msg.get("kind") in {"chat", "sign"} else "chat"
            if mtype == "stream_frame" and not isinstance(msg.get("image"), str):
                continue
            msg["from"] = client
            to = re.sub(r"[^A-Za-z0-9_-]", "", str(msg.get("to") or ""))[:32]
            if to:
                target = ROOMS.get(room, {}).get(to)
                if target is not None:
                    try:
                        await _send_json(target, msg)
                    except Exception:
                        pass
            else:
                await _broadcast(room, msg, exclude=client)
    except WebSocketDisconnect:
        pass
    finally:
        # Identity check: only clean up if THIS socket is still the registered
        # one. A reconnect (same id) replaces the entry — without this check a
        # dying stale socket would evict the fresh connection and broadcast a
        # bogus peer-left, making peers tear down live video ("visible for a
        # few seconds then gone").
        if room in ROOMS and ROOMS[room].get(client) is websocket:
            ROOMS[room].pop(client, None)
            if not ROOMS[room]:
                ROOMS.pop(room, None)
                ROOM_PINS.pop(room, None)
            await _broadcast(room, {"type": "peer-left", "id": client})
        WS_SEND_LOCKS.pop(websocket, None)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8010"))
    print(f"\nNEXT http://localhost:{port}  (engine: {ENGINE})\n")
    uvicorn.run(app, host="0.0.0.0", port=port)
