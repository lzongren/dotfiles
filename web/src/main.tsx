import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyLook, DEVBOX, savedLook } from './theme'
import { initToken } from './token'
import './styles.css'

initToken()
try {
  applyLook(savedLook() ?? DEVBOX)
} catch {
  applyLook(DEVBOX)
}
createRoot(document.getElementById('root')!).render(<App />)
