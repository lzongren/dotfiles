import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { getToken } from '../token'

type Status = 'connecting' | 'connected' | 'closed' | 'rejected'

const REJECT_CODES = [4401, 4403, 4404, 1011]

export function TerminalPane({ name, active }: { name: string; active: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const retryRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const closedByUs = useRef(false)
  const reconnectRef = useRef<() => void>(() => undefined)
  const [status, setStatus] = useState<Status>('connecting')

  useEffect(() => {
    const term = new XTerm({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      scrollback: 5000,
      theme: { background: '#16181d', foreground: '#d7dae0' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    if (containerRef.current) term.open(containerRef.current)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      void 0
    }
    try {
      fit.fit()
    } catch {
      void 0
    }

    const dataSub = term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', cols, rows }))
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

    const connect = () => {
      setStatus('connecting')
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const params = new URLSearchParams({
        token: getToken() ?? '',
        session: name,
        cols: String(term.cols),
        rows: String(term.rows),
      })
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/terminal?${params.toString()}`)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      ws.onopen = () => {
        retryRef.current = 0
        setStatus('connected')
      }
      ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data === 'string') {
          let msg: { t?: string; code?: number; msg?: string }
          try {
            msg = JSON.parse(event.data) as typeof msg
          } catch {
            return
          }
          if (msg.t === 'exit') term.writeln(`\r\n[session ended (exit ${msg.code ?? 0})]`)
          if (msg.t === 'error') term.writeln(`\r\n[${msg.msg ?? 'error'}]`)
        } else {
          term.write(new Uint8Array(event.data))
        }
      }
      ws.onclose = (event: CloseEvent) => {
        wsRef.current = null
        if (closedByUs.current) return
        if (REJECT_CODES.includes(event.code)) {
          setStatus('rejected')
          return
        }
        if (event.code === 1000 || event.code === 1001) {
          setStatus('closed')
          return
        }
        if (document.visibilityState === 'hidden') {
          setStatus('closed')
          return
        }
        setStatus('connecting')
        const delay = Math.min(8000, 500 * 2 ** retryRef.current)
        retryRef.current += 1
        timerRef.current = window.setTimeout(connect, delay)
      }
    }
    reconnectRef.current = () => {
      retryRef.current = 0
      connect()
    }
    connect()

    return () => {
      closedByUs.current = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      if (fitTimer !== null) window.clearTimeout(fitTimer)
      observer.disconnect()
      wsRef.current?.close()
      dataSub.dispose()
      resizeSub.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [name])

  return (
    <div className="terminal" data-active={active}>
      <div className="terminal-bar">
        <span className="terminal-name">{name}</span>
        <span className={`terminal-status terminal-status-${status}`}>
          {status === 'rejected' ? 'attach rejected' : status}
        </span>
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
