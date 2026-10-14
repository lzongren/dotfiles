import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { onTerminalLook, TERMINAL_OPTIONS, terminalLook } from '../theme'
import { getToken } from '../token'

type Status = 'connecting' | 'connected' | 'closed' | 'rejected'

const REJECT_CODES = [4401, 4403, 4404, 1011]
const CHUNK = 16 * 1024
const SSH_FAILED = 255
const MAX_RETRIES = 6
const HEALTHY_MS = 5000
const QUEUE_MAX = 64 * 1024
const COPIED_MS = 1500
const BLOCKED_MS = 5000
const BLOCKED = 'copy blocked: ⌥-drag, then ⌘C'
const decoder = new TextDecoder()

export function clipboardText(data: string): string | null {
  const split = data.indexOf(';')
  if (split < 0) return null
  const target = data.slice(0, split)
  const payload = data.slice(split + 1)
  if (!/^[cpqs0-7]*$/.test(target) || (target && !/[cs]/.test(target)) || !payload || payload === '?') return null
  try {
    return decoder.decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))) || null
  } catch {
    return null
  }
}

export function TerminalPane({
  name,
  active,
  focusSignal = 0,
  tools,
}: {
  name: string
  active: boolean
  focusSignal?: number
  tools?: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const reconnectRef = useRef<() => void>(() => undefined)
  const focusRef = useRef<() => void>(() => undefined)
  const activeRef = useRef(active)
  activeRef.current = active
  const [status, setStatus] = useState<Status>('connecting')
  const [copyNote, setCopyNote] = useState('')

  useEffect(() => {
    const term = new XTerm({ ...TERMINAL_OPTIONS, ...terminalLook() })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (containerRef.current) term.open(containerRef.current)
    focusRef.current = () => term.focus()
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      void 0
    }
    try {
      fit.fit()
    } catch {
      void 0
    }

    const encoder = new TextEncoder()
    let ws: WebSocket | null = null
    let ready = false
    let queued: string[] = []
    let queuedBytes = 0
    let retry = 0
    let retryTimer: number | null = null
    let healthyTimer: number | null = null
    let lastExit: number | null = null
    let resumeWhenVisible = false
    let disposed = false

    const sendInput = (data: string) => {
      if (!ws) return
      if (!ready || ws.readyState !== WebSocket.OPEN) {
        if (queuedBytes + data.length <= QUEUE_MAX) {
          queued.push(data)
          queuedBytes += data.length
        }
        return
      }
      const bytes = encoder.encode(data)
      for (let i = 0; i < bytes.length; i += CHUNK) ws.send(bytes.subarray(i, i + CHUNK))
    }
    const sendResize = () => {
      if (ws && ready && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
      }
    }

    const dataSub = term.onData(sendInput)
    const resizeSub = term.onResize(sendResize)
    let copiedTimer: number | null = null
    const flash = (note: string) => {
      if (disposed) return
      setCopyNote(note)
      if (copiedTimer !== null) window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => setCopyNote(''), note === BLOCKED ? BLOCKED_MS : COPIED_MS)
    }
    const clipSub = term.parser.registerOscHandler(52, (data) => {
      const text = clipboardText(data)
      if (text === null || !activeRef.current || !document.hasFocus()) return true
      if (!navigator.clipboard) flash(BLOCKED)
      else
        void navigator.clipboard.writeText(text).then(
          () => flash('copied'),
          () => flash(BLOCKED),
        )
      return true
    })

    let fitTimer: number | null = null
    const observer = new ResizeObserver(() => {
      if (fitTimer !== null) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        try {
          fit.fit()
        } catch {
          void 0
        }
      }, 150)
    })
    if (containerRef.current) observer.observe(containerRef.current)
    const stopLook = onTerminalLook(() => {
      Object.assign(term.options, terminalLook())
      try {
        fit.fit()
      } catch {
        void 0
      }
    })

    const scheduleRetry = () => {
      if (retry >= MAX_RETRIES) {
        setStatus('closed')
        return
      }
      if (document.visibilityState === 'hidden') {
        resumeWhenVisible = true
        setStatus('closed')
        return
      }
      setStatus('connecting')
      const delay = Math.min(8000, 500 * 2 ** retry)
      retry += 1
      retryTimer = window.setTimeout(connect, delay)
    }

    function connect() {
      retryTimer = null
      ready = false
      lastExit = null
      setStatus('connecting')
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({
        token: getToken() ?? '',
        session: name,
        cols: String(term.cols),
        rows: String(term.rows),
      })
      const socket = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`)
      socket.binaryType = 'arraybuffer'
      ws = socket
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data !== 'string') {
          term.write(new Uint8Array(event.data))
          return
        }
        let msg: { t?: string; code?: number; msg?: string }
        try {
          msg = JSON.parse(event.data) as typeof msg
        } catch {
          return
        }
        if (msg.t === 'ready') {
          ready = true
          setStatus('connected')
          const focused = document.activeElement
          if (activeRef.current && (focused === null || focused === document.body || containerRef.current?.contains(focused))) {
            term.focus()
          }
          healthyTimer = window.setTimeout(() => {
            retry = 0
          }, HEALTHY_MS)
          sendResize()
          const pending = queued
          queued = []
          queuedBytes = 0
          for (const data of pending) sendInput(data)
        } else if (msg.t === 'exit') {
          lastExit = msg.code ?? 0
          term.writeln(`\r\n[session ended (exit ${lastExit})]`)
        } else if (msg.t === 'error') {
          term.writeln(`\r\n[${msg.msg ?? 'error'}]`)
        }
      }
      socket.onclose = (event: CloseEvent) => {
        if (ws === socket) ws = null
        ready = false
        queued = []
        queuedBytes = 0
        if (healthyTimer !== null) window.clearTimeout(healthyTimer)
        healthyTimer = null
        if (disposed) return
        if (REJECT_CODES.includes(event.code)) {
          setStatus('rejected')
          return
        }
        if (event.code === 1001 || (event.code === 1000 && lastExit !== SSH_FAILED)) {
          setStatus('closed')
          return
        }
        scheduleRetry()
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && resumeWhenVisible) {
        resumeWhenVisible = false
        retry = 0
        connect()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    reconnectRef.current = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      resumeWhenVisible = false
      retry = 0
      connect()
    }
    connect()

    return () => {
      disposed = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      if (healthyTimer !== null) window.clearTimeout(healthyTimer)
      if (fitTimer !== null) window.clearTimeout(fitTimer)
      if (copiedTimer !== null) window.clearTimeout(copiedTimer)
      setCopyNote('')
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
      stopLook()
      ws?.close()
      dataSub.dispose()
      resizeSub.dispose()
      clipSub.dispose()
      term.dispose()
    }
  }, [name])

  useEffect(() => {
    if (active) focusRef.current()
  }, [active, focusSignal])

  return (
    <div className="terminal" data-active={active}>
      <div className="terminal-bar">
        <span className="terminal-name">{name}</span>
        <span className={`terminal-status terminal-status-${status}`}>
          {status === 'rejected' ? 'attach rejected' : status}
        </span>
        <span className="terminal-copied" role="status">
          {copyNote}
        </span>
        {tools}
        {status === 'closed' || status === 'rejected' ? (
          <button type="button" onClick={() => reconnectRef.current()}>
            reconnect
          </button>
        ) : null}
      </div>
      <div ref={containerRef} className="terminal-screen" />
    </div>
  )
}
