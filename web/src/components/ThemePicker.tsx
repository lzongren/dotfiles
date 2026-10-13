import { useEffect, useState } from 'react'
import { getTheme } from '../api'
import { applyLook, DEVBOX, ghosttyLook, prefersLight, PRESETS, savedLook, saveLook, type Look } from '../theme'

export function ThemePicker() {
  const [selected, setSelected] = useState<Look>(() => savedLook() ?? DEVBOX)
  const [ghostty, setGhostty] = useState<Look | null>(() => (selected.id === 'ghostty' ? selected : null))
  const [light, setLight] = useState(prefersLight)

  useEffect(() => {
    let live = true
    void getTheme().then((result) => {
      if (!live || result.kind !== 'ok' || !result.data.ghostty) return
      const fresh = ghosttyLook(result.data.ghostty)
      setGhostty(fresh)
      const saved = savedLook()
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
    const query = window.matchMedia('(prefers-color-scheme: light)')
    const update = () => setLight(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    applyLook(selected, light)
  }, [selected, light])

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
