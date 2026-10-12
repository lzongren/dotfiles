import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from '../../src/components/Terminal'
import { TerminalTabs } from '../../src/components/TerminalTabs'

const hoisted = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = []
    cols = 80
    rows = 24
    write = vi.fn()
    writeln = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    dispose = vi.fn()
    dataCb: ((data: string) => void) | null = null
    resizeCb: ((size: { cols: number; rows: number }) => void) | null = null

    constructor() {
      FakeXTerm.instances.push(this)
    }
    onData(cb: (data: string) => void) {
      this.dataCb = cb
      return { dispose: vi.fn() }
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      this.resizeCb = cb
      return { dispose: vi.fn() }
    }
  }
  return { FakeXTerm }
})

const xterms = hoisted.FakeXTerm.instances

vi.mock('@xterm/xterm', () => ({ Terminal: hoisted.FakeXTerm }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const sockets: FakeWebSocket[] = []

class FakeWebSocket {
  static OPEN = 1
  static instances = sockets
  url: string
  binaryType = 'blob'
  readyState = 0
  send = vi.fn()
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }
  close(code = 1005) {
    this.serverClose(code)
  }
  serverOpen() {
    this.readyState = 1
    this.onopen?.()
  }
  serverMessage(data: string | ArrayBuffer) {
    this.onmessage?.({ data })
  }
  serverClose(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  sessionStorage.setItem('devbox-web-token', 'tok')
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  xterms.length = 0
  sockets.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
})

describe('TerminalPane', () => {
  it('opens a websocket with the token, session, and initial size', () => {
    render(<TerminalPane name="api" active />)
    expect(sockets).toHaveLength(1)
    const url = new URL(sockets[0].url)
    expect(url.pathname).toBe('/ws/terminal')
    expect(url.searchParams.get('token')).toBe('tok')
    expect(url.searchParams.get('session')).toBe('api')
    expect(url.searchParams.get('cols')).toBe('80')
    expect(url.searchParams.get('rows')).toBe('24')
    expect(sockets[0].binaryType).toBe('arraybuffer')
  })

  it('writes binary frames into the terminal and forwards keystrokes', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverOpen())
    act(() => sockets[0].serverMessage(new TextEncoder().encode('hi').buffer as ArrayBuffer))
    expect(xterms[0].write).toHaveBeenCalledWith(new Uint8Array([104, 105]))
    act(() => xterms[0].dataCb?.('ls'))
    expect(sockets[0].send).toHaveBeenCalledWith('ls')
  })

  it('sends resize control frames from terminal resizes', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverOpen())
    act(() => xterms[0].resizeCb?.({ cols: 120, rows: 40 }))
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }))
  })

  it('shows the exit note and reconnects manually on the same terminal instance', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverOpen())
    act(() => sockets[0].serverMessage(JSON.stringify({ t: 'exit', code: 0 })))
    act(() => sockets[0].serverClose(1000))
    expect(xterms[0].writeln).toHaveBeenCalledWith(expect.stringContaining('session ended'))
    const button = screen.getByRole('button', { name: 'reconnect' })
    fireEvent.click(button)
    expect(sockets).toHaveLength(2)
    expect(xterms).toHaveLength(1)
  })

  it('auto-reconnects with exponential backoff after an unexpected close', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverOpen())
    act(() => sockets[0].serverClose(1006))
    expect(sockets).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(sockets).toHaveLength(2)
    act(() => sockets[1].serverClose(1006))
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(sockets).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sockets).toHaveLength(3)
  })

  it('does not retry a rejected attach', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverClose(4404))
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(sockets).toHaveLength(1)
    expect(screen.getByText('attach rejected')).toBeInTheDocument()
  })

  it('closes the socket and disposes the terminal on unmount without reconnecting', () => {
    const { unmount } = render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverOpen())
    unmount()
    expect(sockets[0].readyState).toBe(3)
    expect(xterms[0].dispose).toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(sockets).toHaveLength(1)
  })
})

describe('TerminalTabs', () => {
  it('renders tabs, marks the active one, and keeps inactive panes mounted but hidden', () => {
    const { container } = render(
      <TerminalTabs tabs={['api', 'main']} active="api" onSelect={() => {}} onClose={() => {}} />,
    )
    const tabButtons = screen.getAllByRole('tab')
    expect(tabButtons).toHaveLength(2)
    expect(tabButtons[0]).toHaveAttribute('aria-selected', 'true')
    const panes = container.querySelectorAll('.termpane')
    expect(panes).toHaveLength(2)
    expect((panes[0] as HTMLElement).style.display).toBe('block')
    expect((panes[1] as HTMLElement).style.display).toBe('none')
    expect(sockets).toHaveLength(2)
  })

  it('fires select and close callbacks', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<TerminalTabs tabs={['api', 'main']} active="api" onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getAllByRole('tab')[1])
    expect(onSelect).toHaveBeenCalledWith('main')
    fireEvent.click(screen.getByRole('button', { name: 'close api' }))
    expect(onClose).toHaveBeenCalledWith('api')
  })

  it('renders nothing without tabs', () => {
    const { container } = render(<TerminalTabs tabs={[]} active={null} onSelect={() => {}} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
