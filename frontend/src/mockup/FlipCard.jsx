import { useState } from 'react';
import axios from 'axios';

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');

export default function FlipCard({ front, transcript, changeLog, iterationNumber }) {
  const [flipped, setFlipped] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e) => {
    e.stopPropagation();
    setDownloading(true);
    try {
      const formData = new FormData();
      // front.props.spec is MockupRenderer's spec prop — access via iteration data from parent
      formData.append('spec_json', JSON.stringify(front?.props?.spec || {}));
      formData.append('transcript', transcript || '');
      formData.append('iteration_number', String(iterationNumber));
      const res = await axios.post(`${API_BASE}/mockup-export`, formData, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `iteration-${String(iterationNumber).padStart(2, '0')}.zip`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed', e);
    } finally {
      setDownloading(false);
    }
  };

  // Match the card size to the mockup's form factor (phone vs. desktop browser)
  const platform = String(front?.props?.spec?.platform || front?.props?.spec?.formFactor || '').toLowerCase();
  const isWeb = ['web', 'website', 'desktop', 'browser'].includes(platform);
  const cardSize = isWeb ? { width: 880, height: 560 } : { width: 375, height: 667 };

  return (
    <div className={`flip-card-shell${isWeb ? ' flip-card-shell--web' : ''}`}>
      {/* Side toggle — flips the card without stealing clicks from the live mockup */}
      <button
        className="flip-card-toggle"
        onClick={() => setFlipped(f => !f)}
        title={flipped ? 'Back to mockup' : 'See transcript'}
      >
        {flipped ? '‹ mockup' : 'transcript ›'}
      </button>

      <div className={`flip-card${flipped ? ' flip-card--flipped' : ''}`} style={cardSize}>
        <div className="flip-card-inner">
          {/* Front: the live mockup — fully interactive, clicks go to the prototype */}
          <div className="flip-card-face flip-card-front">
            {front}
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
    </div>
  );
}
