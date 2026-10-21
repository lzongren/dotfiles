import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startLook } from './theme'
import { initToken } from './token'
import './styles.css'

initToken()
startLook()
createRoot(document.getElementById('root')!).render(<App />)
