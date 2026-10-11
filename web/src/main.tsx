import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initToken } from './token'
import './styles.css'

initToken()
createRoot(document.getElementById('root')!).render(<App />)
