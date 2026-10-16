import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyLook, DEVBOX, PRESETS, savedLook } from './theme'
import { initToken } from './token'
import './styles.css'

initToken()
try {
  applyLook(savedLook() ?? PRESETS[0])
} catch {
  try {
    applyLook(DEVBOX)
  } catch {
    void 0
  }
}
createRoot(document.getElementById('root')!).render(<App />)
