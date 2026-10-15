import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { getTheme } from '../api'
import { Icon } from './Icon'
import { applyLook, DEVBOX, ghosttyLook, MEDIA, mediaPrefs, PRESETS, savedLook, saveLook, uiTokens, type Look } from '../theme'

function Mini({ look, mode }: { look: Look; mode: 'dark' | 'light' }) {
  const p = mode === 'light' ? look.lightPalette : look.palette
  if (!p) return null
  return (
    <span className="theme-mini" style={uiTokens(p, false, look.gradient?.[mode]) as CSSProperties}>
      <span className="theme-mini-side">
        <span className="theme-mini-dot" />
        <span className="theme-mini-line" />
        <span className="theme-mini-line" data-dim />
        <span className="theme-mini-pill" />
      </span>
      <span className="theme-mini-term">
        <span className="theme-mini-prompt">❯</span>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} className="theme-mini-ansi" style={{ background: p.ansi[i] }} />
        ))}
      </span>
    </span>
  )
}

export function ThemePicker() {
  const [selected, setSelected] = useState<Look>(() => savedLook() ?? PRESETS[0])
  const [ghostty, setGhostty] = useState<Look | null>(() => (selected.id === 'ghostty' ? selected : null))
  const [prefs, setPrefs] = useState(mediaPrefs)
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  const [open, setOpen] = useState(false)
  const gallery = useId()
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    void getTheme().then((result) => {
      if (!live || result.kind !== 'ok') return
      const saved = savedLook()
      if (!result.data.ghostty) {
        setGhostty(null)
        if (saved?.id === 'ghostty') {
          saveLook(null)
          setSelected(PRESETS[0])
        }
        return
      }
      const fresh = ghosttyLook(result.data.ghostty)
      setGhostty(fresh)
      if (saved === null || saved.id === 'ghostty') {
        saveLook(fresh)
        setSelected(fresh)
      }
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const queries = MEDIA.map((q) => window.matchMedia(q))
    const update = () => setPrefs(mediaPrefs())
    for (const query of queries) query.addEventListener('change', update)
    return () => {
      for (const query of queries) query.removeEventListener('change', update)
    }
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const update = () => setDpr(window.devicePixelRatio || 1)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [dpr])

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.theme-picker'))) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  useEffect(() => {
    try {
      applyLook(selected, prefs)
    } catch {
      try {
        applyLook(DEVBOX, prefs)
      } catch {
        void 0
      }
    }
  }, [selected, prefs, selected.cellHeight?.unit === 'px' ? dpr : 0])

  const looks = ghostty ? [ghostty, ...PRESETS] : PRESETS
  return (
    <div
      className="theme-picker"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        setOpen(false)
        toggle.current?.focus()
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Element && !event.currentTarget.contains(next)) setOpen(false)
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="theme-toggle"
        title={`Theme: ${selected.label}`}
        aria-expanded={open}
        aria-controls={open ? gallery : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="theme" />
        <span className="visually-hidden">Theme</span>
      </button>
      {open ? (
        <fieldset id={gallery} className="theme-gallery">
          <legend>Theme</legend>
          <div className="theme-cards">
            {looks.map((look) => {
              const [name, ...scheme] = look.label.split(' · ')
              const checked = look.id === selected.id
              return (
                <label key={look.id} className="theme-card">
                  <input
                    type="radio"
                    className="visually-hidden"
                    name={gallery}
                    value={look.id}
                    checked={checked}
                    onChange={() => {
                      saveLook(look)
                      setSelected(look)
                    }}
                  />
                  <span className="theme-minis" aria-hidden="true">
                    <Mini look={look} mode="dark" />
                    <Mini look={look} mode="light" />
                  </span>
                  <span className="theme-name">
                    {name}
                    {checked ? <Icon name="check" size={14} /> : null}
                  </span>
                  {scheme.length ? <span className="theme-scheme"> {scheme.join(' · ')}</span> : null}
                </label>
              )
            })}
          </div>
          <p className="theme-note">Light or dark follows your system.</p>
        </fieldset>
      ) : null}
    </div>
  )
}
