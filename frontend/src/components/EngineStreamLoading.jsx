import './EngineStreamLoading.css'

function formatElapsed(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m <= 0) return `${r}s`
  return `${m}m ${r}s`
}

/**
 * @param {object} props
 * @param {string} [props.title]
 * @param {string} props.stepText
 * @param {number} props.elapsedSec
 * @param {number} props.primaryPct — 0–100
 * @param {boolean} [props.showSecondaryBar]
 * @param {number} [props.secondaryPct] — 0–100
 * @param {string} [props.secondaryCaption]
 */
export default function EngineStreamLoading({
  title = 'Running',
  stepText,
  elapsedSec,
  primaryPct,
  showSecondaryBar = false,
  secondaryPct = 0,
  secondaryCaption = 'Step 2',
}) {
  const p1 = Math.min(100, Math.max(0, Number(primaryPct) || 0))
  const p2 = Math.min(100, Math.max(0, Number(secondaryPct) || 0))

  return (
    <div className="engine-stream-load">
      <div className="engine-stream-load__title">{title}</div>
      <div className="engine-stream-load__step" aria-live="polite">
        {stepText || 'Starting…'}
      </div>
      <div className="engine-stream-load__label">Progress</div>
      <div className="engine-stream-load__bar-wrap">
        <div
          className="engine-stream-load__bar-fill"
          style={{ width: `${p1}%` }}
        />
      </div>
      {showSecondaryBar ? (
        <>
          <div className="engine-stream-load__label" style={{ marginTop: 12 }}>
            {secondaryCaption}
          </div>
          <div className="engine-stream-load__bar-wrap">
            <div
              className="engine-stream-load__bar-fill"
              style={{ width: `${p2}%` }}
            />
          </div>
        </>
      ) : null}
      <div className="engine-stream-load__meta">
        Elapsed {formatElapsed(elapsedSec)}
      </div>
    </div>
  )
}
