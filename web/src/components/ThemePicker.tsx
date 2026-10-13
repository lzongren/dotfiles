import { useEffect, useState } from 'react'
import { getTheme } from '../api'
import { applyLook, DEVBOX, ghosttyLook, MEDIA, mediaPrefs, PRESETS, savedLook, saveLook, type Look } from '../theme'

export function ThemePicker() {
  const [selected, setSelected] = useState<Look>(() => savedLook() ?? DEVBOX)
  const [ghostty, setGhostty] = useState<Look | null>(() => (selected.id === 'ghostty' ? selected : null))
  const [prefs, setPrefs] = useState(mediaPrefs)

  useEffect(() => {
    let live = true
    void getTheme().then((result) => {
      if (!live || result.kind !== 'ok') return
      const saved = savedLook()
      if (!result.data.ghostty) {
        setGhostty(null)
        if (saved?.id === 'ghostty') {
          saveLook(null)
          setSelected(DEVBOX)
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
    applyLook(selected, prefs)
  }, [selected, prefs])

  const looks = ghostty ? [ghostty, ...PRESETS] : PRESETS
  return (
    <label className="theme-picker">
      <span className="visually-hidden">Theme</span>
      <select
        value={selected.id}
        onChange={(e) => {
          const look = looks.find((l) => l.id === e.target.value) ?? DEVBOX
          saveLook(look)
          setSelected(look)
        }}
      >
        {looks.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  )
}
