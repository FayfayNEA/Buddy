import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import RecordRTC from 'recordrtc';
import hark from 'hark';
import { ChevronLeft, ChevronRight, Zap, Loader2, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  securityLevel: 'loose',
  flowchart: { useMaxWidth: true },
  pie: { useMaxWidth: true },
  xychart: { width: 800, height: 500 },
  themeVariables: {
    fontSize: '18px',
  },
});

// Map high-level status text to badge image assets
const STATUS_IMAGES = {
  'Idle': '/images/Off.svg',
  'Hearing': '/images/listening.svg',
  'Listening': '/images/listening.svg',
  'Waiting': '/images/waiting.svg',
  'Processing': '/images/generating.svg',
  'Generating': '/images/generating.svg',
  'Zipping': '/images/generating.svg',
  'Done': '/images/generated.svg',
  'Saved!': '/images/generated.svg',
  default: '/images/Off.svg',
};

// Status label colors: Idle (neutral), Hearing/Listening (red), Waiting (blue), Thinking (orange), Done (green)
const STATUS_COLORS = {
  Idle: '#374151',
  Hearing: '#dc2626',
  Listening: '#dc2626',
  Waiting: '#2563eb',
  Processing: '#ea580c',
  Generating: '#ea580c',
  Zipping: '#ea580c',
  Done: '#16a34a',
  'Saved!' : '#16a34a',
  default: '#374151',
};

const API_BASE = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");
const ACCESS_NOTICE_KEY = "buddy_access_notice_dismissed";
const CONTACT_EMAIL = (import.meta.env.VITE_CONTACT_EMAIL || "failennaselta@gmail.com").trim();
const HIDE_ACCESS_NOTICE = import.meta.env.VITE_HIDE_ACCESS_NOTICE === "true";
const DEMO_TOKEN_KEY = "buddy_demo_token";
const DEMO_REMAINING_KEY = "buddy_demo_remaining";
const DEMO_LIMIT = 3;

// Liquid glass button component used to toggle vibe mode.
// Uses a base #333 fill on the button and an ::after pseudo-element
// (styled in CSS) to render the Figma gradient + blend modes.
function LiquidButton({ active, onClick, demoComplete }) {
  return (
    <button
      type="button"
      onClick={demoComplete ? undefined : onClick}
      disabled={demoComplete}
      className={
        `liquid-btn inline-flex items-center justify-center rounded-full px-6 py-2.5 ` +
        `w-[640px] h-[60px]` +
        (active ? ' liquid-btn--active' : '') +
        (demoComplete ? ' opacity-40 cursor-not-allowed' : '')
      }
    >
      <span className="select-none">
        {demoComplete ? 'Demo Complete' : active ? 'Stop Vibing' : 'Start Vibing'}
      </span>
    </button>
  );
}

export default function App() {
  const [history, setHistory] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [vibeMode, setVibeMode] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [isGenerating, setIsGenerating] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [demoToken, setDemoToken] = useState(() => {
    try { return localStorage.getItem(DEMO_TOKEN_KEY) || ""; } catch { return ""; }
  });
  const [demoUsesLeft, setDemoUsesLeft] = useState(() => {
    try {
      const stored = localStorage.getItem(DEMO_REMAINING_KEY);
      return stored !== null ? parseInt(stored, 10) : DEMO_LIMIT;
    } catch { return DEMO_LIMIT; }
  });
  // 3-phase intro: 0 = Spiral Down, 1 = Explosion, 2 = Header (main app)
  const [introPhase, setIntroPhase] = useState(0);
  const [showAccessNotice, setShowAccessNotice] = useState(() => {
    if (HIDE_ACCESS_NOTICE) return false;
    try {
      return !localStorage.getItem(ACCESS_NOTICE_KEY);
    } catch {
      return true;
    }
  });

  // --- REFS ---
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const mermaidRef = useRef(null);
  
  // FIX 1: HISTORY REF
  // We use this to cheat the "stale closure" problem. 
  // The recorder will look at this Ref instead of the State.
  const historyRef = useRef([]);

  // QUEUE SYSTEM
  const audioQueueRef = useRef([]); 
  const isProcessingRef = useRef(false);
  const silenceTimeoutRef = useRef(null);

  // --- SYNC REF WITH STATE ---
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    setImgError(false);
  }, [currentIndex]);

  // --- INTRO PHASE TIMING ---
  useEffect(() => {
    if (introPhase === 0) {
      // Phase 0: Spiral runs 1.5s, then advance to Phase 1
      const t = setTimeout(() => setIntroPhase(1), 1500);
      return () => clearTimeout(t);
    }
    if (introPhase === 1) {
      // Phase 1: Explosion visible, short delay then advance to Phase 2
      const t = setTimeout(() => setIntroPhase(2), 800);
      return () => clearTimeout(t);
    }
  }, [introPhase]);

  const dismissAccessNotice = () => {
    try {
      localStorage.setItem(ACCESS_NOTICE_KEY, "1");
    } catch {
      /* ignore */
    }
    setShowAccessNotice(false);
  };

  // --- 1. RENDER DIAGRAMS ---
  const runMermaidOnMount = (el, diagramCode) => {
    if (!el || !diagramCode) return;
    if (el.getAttribute('data-processed')) return;
    
    // Clean code again just in case
    const cleanCode = diagramCode
      .replace(/```mermaid/g, '')
      .replace(/```/g, '')
      .trim();
      
    if (!cleanCode) return;
    
    el.innerHTML = cleanCode;
    el.removeAttribute('data-processed');
    
    mermaid.run({ nodes: [el], suppressErrors: false }).catch((err) => {
        el.innerHTML = `
          <div style="color:red; text-align:center; padding:20px;">
            <p>⚠️ Diagram Error</p>
            <p style="font-size:12px; opacity:0.7;">${err.message}</p>
            <p style="font-size:10px; margin-top:10px; font-family:monospace;">${cleanCode.substring(0,50)}...</p>
          </div>
        `;
      });
  };

  const setMermaidRef = (el) => {
    mermaidRef.current = el;
    const item = history[currentIndex];
    if (el && item?.mode === "DIAGRAM" && item?.diagram_code) {
      runMermaidOnMount(el, item.diagram_code);
    }
  };

  // --- 2. KEYBOARD NAV ---
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'ArrowLeft') prevItem();
      if (e.key === 'ArrowRight') nextItem();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [history]); // This one can depend on history state safely

  const prevItem = () => setCurrentIndex(c => Math.max(0, c - 1));
  const nextItem = () => setCurrentIndex(c => Math.min(history.length - 1, c + 1));

  // --- DIAL LOGIC ---
  const dialRef = useRef(null);
  const dialAngleRef = useRef(0);
  const dialStartRef = useRef(null);
  const ROTATION_THRESHOLD = 25;

  const getAngle = (clientX, clientY) => {
    if (!dialRef.current) return 0;
    const rect = dialRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx) * (180 / Math.PI);
  };

  const handleDialPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dialStartRef.current = { angle: getAngle(e.clientX, e.clientY), index: currentIndex };
    dialAngleRef.current = 0;
  };

  const handleDialPointerMove = (e) => {
    if (dialStartRef.current == null) return;
    const currentAngle = getAngle(e.clientX, e.clientY);
    let delta = currentAngle - dialStartRef.current.angle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    dialAngleRef.current += delta;
    dialStartRef.current.angle = currentAngle;
    if (dialAngleRef.current >= ROTATION_THRESHOLD && history.length > 1) {
      nextItem();
      dialAngleRef.current = 0;
    } else if (dialAngleRef.current <= -ROTATION_THRESHOLD && history.length > 1) {
      prevItem();
      dialAngleRef.current = 0;
    }
  };

  const handleDialPointerUp = () => {
    dialStartRef.current = null;
  };

  // --- 3. QUEUE PROCESSOR ---
  const processQueue = async () => {
    if (isProcessingRef.current || audioQueueRef.current.length === 0) return;

    isProcessingRef.current = true;
    const nextBlob = audioQueueRef.current.shift();
    
    setStatus("Generating");
    setIsGenerating(true); // Show loader animation

    // Add a timeout to prevent hanging indefinitely
    const timeoutId = setTimeout(() => {
      console.error("Request timeout - resetting generating state");
      setIsGenerating(false);
      setStatus("Error");
      isProcessingRef.current = false;
    }, 60000); // 60 second timeout

    try {
        await sendAudio(nextBlob);
        clearTimeout(timeoutId);
    } catch (e) {
        clearTimeout(timeoutId);
        console.error("Queue Error:", e);
        setStatus("Error");
    } finally {
        clearTimeout(timeoutId);
        isProcessingRef.current = false;
        setIsGenerating(false);
        if (audioQueueRef.current.length > 0) {
            processQueue();
        } else {
            // Briefly show a "Done" state before returning to listening
            setStatus("Done");
            setTimeout(() => {
              setStatus((prev) => (prev === "Done" ? "Listening" : prev));
            }, 2000);
        }
    }
  };

  // --- 4. VIBE MODE LOGIC ---
  const startVibeSession = async () => {
    try {
      // Request audio with noise suppression and echo cancellation to reduce background noise
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100,
          channelCount: 1
        } 
      });
      streamRef.current = stream;
      
      recorderRef.current = new RecordRTC(stream, { 
        type: 'audio', 
        mimeType: 'audio/wav', 
        recorderType: RecordRTC.StereoAudioRecorder,
        numberOfAudioChannels: 1 
      });
      recorderRef.current.startRecording();
      
      // Use a slightly higher threshold to filter out background noise
      const speech = hark(stream, { interval: 100, threshold: -45 });
      
      speech.on('stopped_speaking', () => {
        if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
        
        setStatus("Waiting");
        
        silenceTimeoutRef.current = setTimeout(() => {
          silenceTimeoutRef.current = null;
          setStatus("Processing");
          
          if (recorderRef.current) {
              recorderRef.current.stopRecording(() => {
                  const blob = recorderRef.current.getBlob();
                  // Ignore tiny blips
                  if (blob.size > 2000) { 
                      audioQueueRef.current.push(blob);
                      processQueue();
                  }
                  
                  if (streamRef.current?.active) {
                      recorderRef.current.reset();
                      recorderRef.current.startRecording();
                      setStatus("Listening");
                  }
              });
          }
        }, 2000); // 2 seconds silence to trigger
      });

      speech.on('speaking', () => {
        if (silenceTimeoutRef.current) {
          clearTimeout(silenceTimeoutRef.current);
          silenceTimeoutRef.current = null;
        }
        setStatus("Hearing");
      });
      setStatus("Listening");

    } catch (err) {
      console.error(err);
      setStatus("Mic Error");
    }
  };

  const stopVibeSession = () => {
    setVibeMode(false);
    if (silenceTimeoutRef.current) clearTimeout(silenceTimeoutRef.current);
    if (recorderRef.current) recorderRef.current.stopRecording();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    // Reset generating state if stuck
    setIsGenerating(false);
    isProcessingRef.current = false;
    setStatus("Idle");
  };

  const toggleVibe = () => {
    if (vibeMode) stopVibeSession();
    else {
      setVibeMode(true);
      startVibeSession();
    }
  };

  // --- 5. SEND TO BACKEND (THE CRITICAL FIX) ---
  const sendAudio = async (blob) => {
    const formData = new FormData();
    formData.append("file", blob, "voice.wav");

    // FIX 2: Use historyRef.current instead of history state
    // This ensures we always get the LATEST history, even inside closures
    const currentHistory = historyRef.current; 
    
    const historySummary = currentHistory.slice(-5).map(item => ({
        id: item.id || Date.now(),
        transcript: item.transcript,
        visual_prompt: item.visual_prompt, // Backend needs this to know what to edit
        image_url: item.image_url,
        mode: item.mode,
        seed: item.seed // FIX 3: Pass the seed back!
    }));

    formData.append("history_json", JSON.stringify(historySummary));
    formData.append("demo_token", demoToken);

    try {
      const res = await axios.post(`${API_BASE}/upload-audio`, formData);

      if (res.data.error) {
          console.warn("Backend ignored audio (silence/hallucination)");
          return;
      }

      if (res.data.demo_token) {
        const newToken = res.data.demo_token;
        const remaining = res.data.demo_uses_remaining ?? 0;
        setDemoToken(newToken);
        setDemoUsesLeft(remaining);
        try {
          localStorage.setItem(DEMO_TOKEN_KEY, newToken);
          localStorage.setItem(DEMO_REMAINING_KEY, String(remaining));
        } catch { /* ignore */ }
        if (remaining === 0) stopVibeSession();
      }

      const newItem = {
          ...res.data,
          id: Date.now()
      };

      setHistory(prev => {
        const newHistory = [...prev, newItem];
        setCurrentIndex(newHistory.length - 1);
        return newHistory;
      });

    } catch (err) {
      if (err?.response?.status === 429) {
        setDemoUsesLeft(0);
        try {
          localStorage.setItem(DEMO_REMAINING_KEY, "0");
        } catch { /* ignore */ }
        stopVibeSession();
        return;
      }
      console.error("Backend Error:", err);
      setStatus("Backend Error");
      throw err;
    }
  };

  // --- 6. COMMIT SESSION (download ZIP to user's machine) ---
  const commitSession = async () => {
    if (history.length === 0) return;
    
    setStatus("Zipping"); 
    
    try {
      const historyData = history.map(item => ({
        transcript: item.transcript,
        visual_prompt: item.visual_prompt,
        image_url: item.image_url,
        mode: item.mode,
      }));

      const formData = new FormData();
      formData.append("history_json", JSON.stringify(historyData));

      const response = await axios.post(
        `${API_BASE}/commit-session`,
        formData,
        { responseType: "blob" }
      );

      const blob = response.data;
      const cd = response.headers["content-disposition"] || "";
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename =
        m?.[1]?.trim() || `consensus-session-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.zip`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus("Saved!");

      setTimeout(() => {
        setStatus(vibeMode ? "Listening" : "Idle");
      }, 2000);

    } catch (err) {
      console.error("Commit Error:", err);
      let detail = err?.message || "Export failed";
      const data = err?.response?.data;
      if (data instanceof Blob) {
        try {
          const t = await data.text();
          const j = JSON.parse(t);
          if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
        } catch {
          /* ignore */
        }
      }
      console.error(detail);
      setStatus("Export Error");
      setTimeout(() => {
        setStatus(vibeMode ? "Listening" : "Idle");
      }, 2000);
    }
  };
  
  const currentItem = history[currentIndex];
  const isLongCaption =
    currentItem?.transcript && currentItem.transcript.length > 80;
  const hasCaption = !!currentItem;
  // While an image request runs, the mic stays active and new clips queue — don't hide Hearing/Listening.
  const displayStatus =
    vibeMode &&
    (status === "Hearing" ||
      status === "Waiting" ||
      status === "Processing" ||
      status === "Listening")
      ? status
      : isGenerating
        ? "Generating"
        : status;
  const statusImageSrc = STATUS_IMAGES[displayStatus] || STATUS_IMAGES.default;

  return (
    <div className="app">
      <AnimatePresence>
        {introPhase === 2 && showAccessNotice && (
          <motion.div
            key="access-notice"
            className="access-notice-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="access-notice-title"
          >
            <motion.div
              className="access-notice-card"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <h2 id="access-notice-title" className="access-notice-title">
                Buddy — free demo
              </h2>
              <p className="access-notice-body">
                You get <strong>{DEMO_LIMIT} free generations</strong> — speak a request and Buddy will sketch or diagram it in real time. After that, reach out if you want to keep going.
              </p>
              <button type="button" className="access-notice-btn" onClick={dismissAccessNotice}>
                Let's go
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== PHASE 0: Spiral Down (full-screen white + spiral, scale 5→0, rotate 360, opacity 1→0) ========== */}
      <AnimatePresence mode="wait">
        {introPhase === 0 && (
          <motion.div
            key="phase0"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="intro-overlay intro-overlay--white"
          >
            <motion.div
              initial={{ scale: 5, opacity: 1, rotate: 0 }}
              animate={{ scale: 0, opacity: 0, rotate: 360 }}
              transition={{ duration: 1.5, ease: 'easeInOut' }}
              className="intro-spiral-wrapper"
            >
              {/* [INSERT SPIRAL SVG HERE] - buddyname.svg spins clockwise while getting smaller; replace with Figma SVG if needed */}
              <img
                src="/images/buddyname.svg"
                alt=""
                className="intro-spiral-svg"
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== PHASE 1: The Explosion (mask group scales 0→5 in center); fade out when going to Phase 2 ========== */}
      <AnimatePresence mode="wait">
        {introPhase === 1 && (
          <motion.div
            key="phase1"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="intro-overlay intro-overlay--white"
          >
            <motion.div
              layoutId="buddy-logo"
              initial={{ scale: 0 }}
              animate={{ scale: 5 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="intro-explosion-wrapper"
            >
              {/* [INSERT MASK GROUP SVG HERE] - using img for layoutId continuity with header */}
              <img src="/images/Mask group.svg" alt="" className="intro-mask-svg" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ========== PHASE 2: Header (fixed) + main content ========== */}
      {introPhase === 2 && (
        <>
          {/* COMMIT BUTTON - Fixed to upper left corner */}
          {history.length > 0 && (
        <button
          type="button"
          onClick={commitSession}
          className="commit-btn"
          aria-label="Commit session"
        >
          <img
            src="/images/commit-arrow.png"
            alt="Commit session"
            className="w-6 h-6 object-contain pointer-events-none select-none"
          />
            </button>
          )}

          {/* STATUS BADGE - Fixed to viewport, outside app-inner */}
      <AnimatePresence mode="wait">
        <motion.div
          key={statusImageSrc}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          style={{
            position: 'fixed',
            bottom: '4%',
            left: '4%',
            zIndex: 50
          }}
          className="flex flex-col items-center gap-3 pointer-events-none select-none"
        >
          <img
            src={statusImageSrc}
            alt={`Status: ${displayStatus}`}
            style={{ height: '80px', width: 'auto' }}
            className="status-badge-label"
          />
          <span className="status-text"
            style={{
              display: 'block',
              position: 'relative',
              color: STATUS_COLORS[displayStatus] ?? STATUS_COLORS.default,
              right: displayStatus === "Idle" 
                ? "7px" 
                : displayStatus === "Hearing"
                  ? "2px"
                  : displayStatus === "Listening"
                    ? "8px"
                    : displayStatus === "Waiting"
                      ? "2px" 
                      : displayStatus === "Generating"
                        ? "12px" 
                        : displayStatus === "Done" 
                          ? "8px"
                            : displayStatus === "Saved!" 
                            ? "4px"
                              : displayStatus === "Zipping" 
                                ? "2px"
                                : displayStatus === "Export Error" 
                                  ? "7px"
                                  : "-10px"
                          
            }}
          >
            {displayStatus}
          </span>
        </motion.div>
      </AnimatePresence>

          <div className="app-inner">
            {/* HEADER - fixed at top; buddyname.svg only, click replays splash animation (centered) */}
            <header className="header header--fixed">
              <button
                type="button"
                onClick={() => setIntroPhase(0)}
                className="header-logo-btn"
                aria-label="Replay intro"
              >
                <img src="/images/buddyname.svg" alt="Buddy" className="header-logo-img" />
              </button>
            </header>

            {/* Main app content - fades in after mask group splash fades out */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
              className="app-main"
            >

        {/* STAGE */}
        <div className="stage">
          <AnimatePresence mode="wait">
             {!currentItem ? (
              <motion.div 
                key="empty"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="stage-empty"
              >
                <img 
                  src="/images/loading.svg" 
                  alt="Loading" 
                  className="stage-empty-image"
                />
                <p className="stage-empty-overlay-text">Let's kick it.</p>
              </motion.div>
            ) : (
              <motion.div
                key={currentIndex}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="stage-content"
              >
                {/* --- CONTENT SWITCHER --- */}
                {currentItem.mode === "DIAGRAM" ? (
                  <div key={`diagram-${currentItem.id}`} className="stage-diagram">
                    <div ref={setMermaidRef} className="mermaid" />
                  </div>
                ) : !currentItem.image_url ? (
                  <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-black/80">
                      <div className="text-4xl mb-4">⚠️</div>
                      <p className="text-red-400 font-bold mb-2">Image Generation Failed</p>
                      <p className="text-gray-400 text-sm mt-2">Check backend logs for details</p>
                  </div>
                ) : currentItem.image_url?.endsWith(".mp4") ? (
                  <video
                    src={currentItem.image_url}
                    className="stage-media"
                    autoPlay loop muted playsInline
                  />
                ) : imgError ? (
                  <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-black/80">
                      <div className="text-4xl mb-4">❌</div>
                      <p className="text-red-400 font-bold mb-2">Image Failed to Load</p>
                  </div>
                ) : (
                  <img 
                    src={currentItem.image_url} 
                    alt="Generated Content" 
                    className="stage-media" 
                    onError={() => setImgError(true)}
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {history.length > 1 && (
            <>
              <button type="button" onClick={prevItem} className="stage-nav stage-nav-prev">
                <ChevronLeft />
              </button>
              <button type="button" onClick={nextItem} className="stage-nav stage-nav-next">
                <ChevronRight />
              </button>
            </>
          )}
        </div>

        {/* Caption below stage */}
        {currentItem && (
          <div className={`stage-caption ${isLongCaption ? 'stage-caption-long' : ''}`}>
            {history.length > 0 && (
              <span className="stage-caption-index">
                {currentIndex + 1} of {history.length}
              </span>
            )}
            <span className="stage-caption-text">"{currentItem.transcript}"</span>
          </div>
        )}

        {/* CONTROLS */}
        <div
          className={`controls ${
            hasCaption ? (isLongCaption ? 'controls-caption-long' : 'controls-caption') : ''
          }`}
        >
          <LiquidButton active={vibeMode} onClick={toggleVibe} demoComplete={demoUsesLeft === 0} />
          <div className="demo-counter" style={{ marginTop: '10px', textAlign: 'center', fontSize: '13px', opacity: 0.5, fontFamily: 'inherit', letterSpacing: '0.05em' }}>
            {demoUsesLeft === 0
              ? CONTACT_EMAIL
                ? <>want more? reach out → <a href={`mailto:${CONTACT_EMAIL}`} style={{ textDecoration: 'underline' }}>{CONTACT_EMAIL}</a></>
                : 'demo complete'
              : demoUsesLeft < DEMO_LIMIT
                ? `${demoUsesLeft} of ${DEMO_LIMIT} generations left`
                : null}
          </div>
        </div>
            </motion.div>
          </div>
        </>
      )}
    </div>
  );
}