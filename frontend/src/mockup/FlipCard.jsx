import { useState } from 'react';
import axios from 'axios';

const API_BASE = (
  import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? window.location.origin : 'http://localhost:8000')
).replace(/\/$/, '');

export default function FlipCard({
  front,
  transcript,
  changeLog,
  iterationNumber,
  /** Full mind stack — when present, download packs every iteration into one zip */
  iterations = null,
  compact = false,
  flipped: controlledFlipped,
  onToggleFlip,
  hideToggle = false,
}) {
  const [internalFlipped, setInternalFlipped] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const flipped = controlledFlipped ?? internalFlipped;
  const toggleFlipped = () => {
    if (onToggleFlip) onToggleFlip();
    else setInternalFlipped(f => !f);
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    setDownloading(true);
    try {
      const formData = new FormData();
      const stack = Array.isArray(iterations) && iterations.length > 0
        ? iterations
        : null;

      if (stack) {
        formData.append('iterations_json', JSON.stringify(stack.map((it, i) => ({
          iterationNumber: it.iterationNumber ?? i + 1,
          spec: it.spec || {},
          transcript: it.transcript || '',
          changeLog: it.changeLog || it.spec?.changeLog || [],
        }))));
      } else {
        // front.props.spec is MockupRenderer's spec prop — single-iteration fallback
        formData.append('spec_json', JSON.stringify(front?.props?.spec || {}));
        formData.append('transcript', transcript || '');
        formData.append('iteration_number', String(iterationNumber));
      }

      const res = await axios.post(`${API_BASE}/mockup-export`, formData, {
        responseType: 'blob', timeout: 120000,
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers?.['content-disposition'] || '';
      const m = cd.match(/filename="?([^";]+)"?/i);
      a.download = m?.[1]?.trim()
        || (stack && stack.length > 1
          ? `buddy-mockup-${stack.length}-iterations.zip`
          : `iteration-${String(iterationNumber).padStart(2, '0')}.zip`);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed', err);
    } finally {
      setDownloading(false);
    }
  };

  // Match the card size to the mockup's form factor (phone vs. desktop browser).
  // iPhone 17's standard logical viewport is 402×874. The responsive width keeps
  // that aspect ratio while fitting shorter desktop and narrower mobile viewports.
  const platform = String(front?.props?.spec?.platform || front?.props?.spec?.formFactor || '').toLowerCase();
  const isWeb = ['web', 'website', 'desktop', 'browser'].includes(platform);
  const cardSize = isWeb
    ? compact
      ? undefined
      : {
          width: '100%',
          height: '100%',
        }
    : compact
      ? undefined
      : {
          // iPhone 17 logical viewport: 402×874. Cap so the full phone fits
          // above Start Vibing without forcing page scroll.
          width: 'min(402px, 78vw, calc((100dvh - var(--single-mockup-chrome, 290px)) * 402 / 874))',
          maxHeight: 'calc(100dvh - var(--single-mockup-chrome, 290px))',
          height: 'auto',
          aspectRatio: '402 / 874',
        };

  const isInterpretive = !!front?.props?.spec?.interpretive;

  const exportLabel = Array.isArray(iterations) && iterations.length > 1
    ? `Download all ${iterations.length} iterations`
    : 'Download this iteration';

  return (
    <div className={`flip-card-shell${isWeb ? ' flip-card-shell--web' : ''}${compact ? ' flip-card-shell--compact' : ''}`}>
      <div className={`flip-card${flipped ? ' flip-card--flipped' : ''}${compact ? ' mind-card' : ''}`} style={cardSize}>
        <div className="flip-card-inner">
          {/* Front: the live mockup — fully interactive, clicks go to the prototype */}
          <div className="flip-card-face flip-card-front">
            {front}
            {/* Buddy built this off a vibe rather than an explicit UI request — say so, so
                nobody wonders why they got a cocktail app out of "deep red, late night". */}
            {isInterpretive && (
              <span className="mockup-interpretive-badge" title="Built from the mood, not a direct request — keep talking to steer it">
                interpreted
              </span>
            )}
          </div>

          {/* Back: transcript + changeLog */}
          <div className="flip-card-face flip-card-back">
            <div className="flip-card-back-inner">
              <div className="flip-card-back-header">
                <span className="flip-card-iteration-badge">iteration {iterationNumber}</span>
                <button
                  className={`flip-card-export-btn${downloading ? ' flip-card-export-btn--loading' : ''}`}
                  onClick={handleDownload}
                  disabled={downloading}
                  title={exportLabel}
                  aria-label={exportLabel}
                >
                  {downloading ? '…' : '↓'}
                </button>
              </div>

              <div className="flip-card-section">
                <div className="flip-card-section-label">transcript</div>
                <div className="flip-card-transcript">
                  {transcript || <em style={{ opacity: 0.5 }}>no transcript</em>}
                </div>
              </div>

              {Array.isArray(changeLog) && changeLog.length > 0 && (
                <div className="flip-card-section">
                  <div className="flip-card-section-label">changes</div>
                  <ul className="flip-card-changelog">
                    {changeLog.map((entry, i) => <li key={i}>{entry}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {!hideToggle && (
        <button
          className="flip-card-toggle"
          onClick={toggleFlipped}
          title={flipped ? 'Back to mockup' : 'See transcript'}
        >
          {flipped ? 'mockup' : 'transcript'}
        </button>
      )}
    </div>
  );
}
