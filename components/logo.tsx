import { CAP_HEIGHT, FONE_PATH, FULL, NOVA_PATH, SUBLINE_PATH, WORDMARK } from "@/components/logo-paths"

/**
 * Brand lockup, drawn inline rather than shipped as a bitmap or a webfont.
 *
 * The mark is a handset in brand blue holding a four-point nova spark. The wordmark is
 * Inter ExtraBold, the site's own headline face, cut to outlines: eight characters and a
 * subline do not justify loading a typeface, and outlines cannot reflow or shift if a
 * font request is slow or fails. Regenerate them with brand/build-logo-paths.py.
 *
 * Both fills read from the theme tokens, so the whole lockup inverts with the page
 * instead of needing a second dark-mode asset.
 *
 * Everything scales from the root font-size: set `text-[20px]` (or any font-size) on the
 * wrapper and the mark and wordmark follow. Cap height lands at 0.72em either way, so
 * dropping the subline does not change how large the wordmark reads.
 */

type LogoProps = {
  className?: string
  /** The subline is unreadable below roughly 16px of root size; drop it there. */
  withSubline?: boolean
}

/** Cap height as a fraction of the nominal em, matching the type it sits beside. */
const CAP_EM = 0.72

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={className}>
      <rect x="26" y="10" width="48" height="80" rx="13" fill="var(--primary)" />
      <path d="M50 28 Q54.8 45.6 74 50 Q54.8 54.4 50 72 Q45.2 54.4 26 50 Q45.2 45.6 50 28 Z" fill="var(--background)" />
    </svg>
  )
}

export function Logo({ className = "", withSubline = true }: LogoProps) {
  const box = withSubline ? FULL : WORDMARK

  return (
    <span className={`inline-flex items-center gap-[0.5em] ${className}`}>
      <LogoMark className="h-[1.9em] w-auto shrink-0" />
      <svg
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        role="img"
        aria-label={withSubline ? "FoneNova, wholesale distribution" : "FoneNova"}
        // overflow-visible: an inline SVG clips to its box by default, and the box ends exactly at
        // the subline's lowest pixel, so at fractional positions the last row of the tiny
        // subline was being shaved off. The box is only here for layout, so let ink spill.
        className="w-auto shrink-0 overflow-visible text-foreground"
        style={{ height: `${((box.h / CAP_HEIGHT) * CAP_EM).toFixed(4)}em` }}
      >
        {/* Centred under the subline when it is present, which is wider than neither run
            on its own; the offsets come from the generator so nothing is eyeballed. */}
        <g transform={withSubline ? `translate(${FULL.wordDx} 0)` : undefined}>
          <path fill="currentColor" d={FONE_PATH} />
          <path fill="var(--primary)" d={NOVA_PATH} />
        </g>
        {withSubline && (
          <path
            transform={`translate(${FULL.subDx} 0)`}
            fill="currentColor"
            fillOpacity="0.55"
            d={SUBLINE_PATH}
          />
        )}
      </svg>
    </span>
  )
}
