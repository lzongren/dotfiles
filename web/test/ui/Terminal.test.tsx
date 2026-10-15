import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboardText, TerminalPane } from '../../src/components/Terminal'
import { TerminalTabs } from '../../src/components/TerminalTabs'
import { applyLook, DEVBOX, PRESETS } from '../../src/theme'

const hoisted = vi.hoisted(() => {
  class FakeXTerm {
    static instances: FakeXTerm[] = []
    cols = 80
    rows = 24
    modes = { mouseTrackingMode: 'none' }
    write = vi.fn()
    writeln = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    options: Record<string, unknown>
    dataCb: ((data: string) => void) | null = null
    resizeCb: ((size: { cols: number; rows: number }) => void) | null = null
    osc = new Map<number, (data: string) => boolean>()
    parser = {
      registerOscHandler: (code: number, cb: (data: string) => boolean) => {
        this.osc.set(code, cb)
        return { dispose: vi.fn(() => this.osc.delete(code)) }
      },
    }

    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options }
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
  class FakeWebgl {
    static instances: FakeWebgl[] = []
    dispose = vi.fn()
    lossCb: (() => void) | null = null
    constructor() {
      FakeWebgl.instances.push(this)
    }
    onContextLoss(cb: () => void) {
      this.lossCb = cb
      return { dispose: vi.fn() }
    }
  }
  return { FakeXTerm, FakeWebgl }
})

const xterms = hoisted.FakeXTerm.instances
const webgls = hoisted.FakeWebgl.instances

vi.mock('@xterm/xterm', () => ({ Terminal: hoisted.FakeXTerm }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: hoisted.FakeWebgl }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const sockets: FakeWebSocket[] = []

class FakeWebSocket {
  static OPEN = 1
  url: string
  binaryType = 'blob'
  readyState = 1
  sent: Array<string | Uint8Array> = []
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }
  send(data: string | Uint8Array) {
    this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data))
  }
  close(code = 1005) {
    this.serverClose(code)
  }
  serverReady() {
    this.onmessage?.({ data: JSON.stringify({ t: 'ready' }) })
  }
  serverMessage(data: string | ArrayBuffer) {
    this.onmessage?.({ data })
  }
  serverClose(code: number) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code })
  }
  binaryPayloads(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string')
  }
  controls(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d) as Record<string, unknown>)
  }
}

let visibility: DocumentVisibilityState = 'visible'

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
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  xterms.length = 0
  webgls.length = 0
  sockets.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  sessionStorage.clear()
})

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

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

  it('repaints an open terminal when the theme changes', () => {
    render(<TerminalPane name="api" active />)
    expect(xterms[0].options.theme).toMatchObject({ background: '#0e1014' })
    act(() => applyLook(PRESETS.find((l) => l.id === 'tokyo-night')!, { light: false, more: false }))
    expect(xterms[0].options.theme).toMatchObject({ background: '#1a1b26', blue: '#7aa2f7' })
    act(() => applyLook(DEVBOX, { light: false, more: false }))
    expect(xterms[0].options.theme).toMatchObject({ background: '#0e1014' })
  })

  it('sends keystrokes as binary frames, never as text', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    act(() => xterms[0].dataCb?.('ls\r'))
    const binary = sockets[0].binaryPayloads()
    expect(binary).toHaveLength(1)
    expect(decode(binary[0])).toBe('ls\r')
    expect(sockets[0].sent.filter((d) => d === 'ls\r')).toHaveLength(0)
  })

  it('queues input typed before ready and flushes it after ready', () => {
    render(<TerminalPane name="api" active />)
    act(() => xterms[0].dataCb?.('early'))
    expect(sockets[0].binaryPayloads()).toHaveLength(0)
    act(() => sockets[0].serverReady())
    expect(decode(sockets[0].binaryPayloads()[0])).toBe('early')
  })

  it('drops input typed into a closed pane instead of replaying it into the next session', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    act(() => sockets[0].serverMessage(JSON.stringify({ t: 'exit', code: 0 })))
    act(() => sockets[0].serverClose(1000))
    act(() => xterms[0].dataCb?.('make deploy\r'))
    fireEvent.click(screen.getByRole('button', { name: 'reconnect' }))
    act(() => sockets[1].serverReady())
    expect(sockets[1].binaryPayloads()).toHaveLength(0)
  })

  it('caps input queued while connecting', () => {
    render(<TerminalPane name="api" active />)
    act(() => xterms[0].dataCb?.('a'.repeat(60 * 1024)))
    act(() => xterms[0].dataCb?.('b'.repeat(10 * 1024)))
    act(() => sockets[0].serverReady())
    const sent = sockets[0].binaryPayloads().reduce((n, f) => n + f.length, 0)
    expect(sent).toBe(60 * 1024)
  })

  it('splits a large paste into 16 KiB binary frames', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    act(() => xterms[0].dataCb?.('x'.repeat(40 * 1024)))
    const frames = sockets[0].binaryPayloads()
    expect(frames.map((f) => f.length)).toEqual([16384, 16384, 8192])
  })

  it('writes binary frames from the server into the terminal', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    act(() => sockets[0].serverMessage(new TextEncoder().encode('hi').buffer as ArrayBuffer))
    expect(xterms[0].write).toHaveBeenCalledWith(new Uint8Array([104, 105]))
  })

  it('sends its current size on ready and on every resize', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    expect(sockets[0].controls()).toEqual([{ t: 'resize', cols: 80, rows: 24 }])
    act(() => xterms[0].resizeCb?.({ cols: 120, rows: 40 }))
    xterms[0].cols = 120
    xterms[0].rows = 40
    act(() => xterms[0].resizeCb?.({ cols: 120, rows: 40 }))
    expect(sockets[0].controls().at(-1)).toEqual({ t: 'resize', cols: 120, rows: 40 })
  })

  it('treats a clean session exit as final and reconnects manually on the same terminal', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    act(() => sockets[0].serverMessage(JSON.stringify({ t: 'exit', code: 0 })))
    act(() => sockets[0].serverClose(1000))
    expect(xterms[0].writeln).toHaveBeenCalledWith(expect.stringContaining('session ended'))
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(sockets).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'reconnect' }))
    expect(sockets).toHaveLength(2)
    expect(xterms).toHaveLength(1)
  })

  it('auto-reconnects when ssh itself failed (exit 255)', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    act(() => sockets[0].serverMessage(JSON.stringify({ t: 'exit', code: 255 })))
    act(() => sockets[0].serverClose(1000))
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(sockets).toHaveLength(2)
  })

  it('backs off exponentially across failed attempts and resets only after a healthy connection', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverClose(1013))
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(sockets).toHaveLength(2)
    act(() => sockets[1].serverReady())
    act(() => sockets[1].serverClose(1006))
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(sockets).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(sockets).toHaveLength(3)
    act(() => sockets[2].serverReady())
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    act(() => sockets[2].serverClose(1006))
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(sockets).toHaveLength(4)
  })

  it('stops retrying after repeated failures and offers a manual reconnect', () => {
    render(<TerminalPane name="api" active />)
    for (let i = 0; i < 6; i += 1) {
      act(() => sockets[sockets.length - 1].serverClose(1006))
      act(() => {
        vi.advanceTimersByTime(8000)
      })
    }
    expect(sockets).toHaveLength(7)
    act(() => sockets[6].serverClose(1006))
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(sockets).toHaveLength(7)
    expect(screen.getByRole('button', { name: 'reconnect' })).toBeInTheDocument()
  })

  it('does not hammer a persistently failing ssh: exit 255 right after ready backs off', () => {
    render(<TerminalPane name="api" active />)
    const failFast = (i: number) => {
      act(() => sockets[i].serverReady())
      act(() => sockets[i].serverMessage(JSON.stringify({ t: 'exit', code: 255 })))
      act(() => sockets[i].serverClose(1000))
    }
    failFast(0)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(sockets).toHaveLength(2)
    failFast(1)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(sockets).toHaveLength(2)
    act(() => {
      vi.advanceTimersByTime(500)
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

  it('waits for the tab to be visible again instead of retrying in the background', () => {
    render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
    visibility = 'hidden'
    act(() => sockets[0].serverClose(1006))
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(sockets).toHaveLength(1)
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(sockets).toHaveLength(2)
  })

  it('takes keyboard focus once attached when it is the active tab', () => {
    render(<TerminalPane name="api" active />)
    xterms[0].focus.mockClear()
    act(() => sockets[0].serverReady())
    expect(xterms[0].focus).toHaveBeenCalled()
  })

  it('does not grab focus on a reconnect while the user is typing elsewhere', () => {
    render(<TerminalPane name="api" active />)
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    xterms[0].focus.mockClear()
    act(() => sockets[0].serverReady())
    expect(xterms[0].focus).not.toHaveBeenCalled()
    elsewhere.remove()
  })

  it('focuses again on every open request for the active tab', () => {
    const { rerender } = render(<TerminalPane name="api" active focusSignal={1} />)
    xterms[0].focus.mockClear()
    rerender(<TerminalPane name="api" active focusSignal={2} />)
    expect(xterms[0].focus).toHaveBeenCalledTimes(1)
  })

  it('does not steal focus for a background tab, but takes it when activated', () => {
    const { rerender } = render(<TerminalPane name="api" active={false} />)
    act(() => sockets[0].serverReady())
    expect(xterms[0].focus).not.toHaveBeenCalled()
    rerender(<TerminalPane name="api" active />)
    expect(xterms[0].focus).toHaveBeenCalled()
  })

  it('says nothing was copied, once per pane, when a drag on the rows of an app that keeps the mouse sends no copy', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } })
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.useFakeTimers()
    const later = (ms: number) =>
      act(async () => {
        vi.advanceTimersByTime(ms)
      })
    try {
      const pane = (name: string, connect = true) => {
        const view = render(<TerminalPane name={name} active />)
        const { container } = view
        const socket = sockets[sockets.length - 1]
        if (connect) act(() => socket.serverReady())
        const term = xterms[xterms.length - 1]
        const area = container.querySelector('.terminal-screen')!
        const rows = area.appendChild(document.createElement('div'))
        rows.className = 'xterm-screen'
        const status = () => within(container).getByRole('status')
        const press = (init: MouseEventInit = {}, on: Element = rows) => {
          fireEvent.mouseDown(on, { button: 0, ...init })
          term.dataCb!(`\x1b[<${(init.button ?? 0) + (init.shiftKey ? 4 : 0) + (init.altKey ? 8 : 0) + (init.ctrlKey ? 16 : 0)};5;1M`)
        }
        const move = (cell = '6;1') => term.dataCb!(`\x1b[<32;${cell}M`)
        const release = (button = 0) => fireEvent.mouseUp(window, { button })
        const drag = (init: MouseEventInit = {}, on: Element = rows, moved = true) => {
          press(init, on)
          if (moved) move()
          release()
        }
        const show = (active: boolean) => view.rerender(<TerminalPane name={name} active={active} />)
        return { area, status, press, move, release, drag, term, socket, show }
      }

      const a = pane('api')
      a.drag()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()

      a.term.modes.mouseTrackingMode = 'drag'
      a.drag({}, a.area)
      a.drag({}, undefined, false)
      a.drag({ shiftKey: true })
      a.drag({ button: 1 })
      a.press()
      a.term.dataCb!('\x1b[<34;6;1M')
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      fireEvent.mouseDown(a.area.querySelector('.xterm-screen')!, { button: 0 })
      a.move()
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.press()
      a.move('6;1')
      a.move('5;1')
      a.release()
      fireEvent.mouseDown(a.area.querySelector('.xterm-screen')!, { button: 0 })
      a.term.dataCb!('\x1b[<64;5;1M')
      a.move()
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()

      a.press()
      a.move()
      await act(async () => {
        a.term.osc.get(52)!(';aGk=')
      })
      expect(a.status()).toHaveTextContent(/^copied$/)
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.drag()
      await later(500)
      await act(async () => {
        a.term.osc.get(52)!(';aGk=')
      })
      await later(1000)
      expect(a.status()).toHaveTextContent(/^copied$/)
      await later(1500)

      a.press()
      a.move()
      fireEvent.blur(window)
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.drag()
      fireEvent.blur(window)
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.press()
      a.move()
      fireEvent.mouseDown(document.body, { button: 0 })
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.drag()
      await later(500)
      a.drag({ shiftKey: true })
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()

      const h = pane('hidden')
      h.term.modes.mouseTrackingMode = 'drag'
      h.drag()
      h.show(false)
      await later(6500)
      expect(h.status()).toBeEmptyDOMElement()
      h.show(true)
      h.drag()
      await later(1500)
      expect(h.status()).toHaveTextContent('nothing copied')

      const c = pane('closing')
      c.term.modes.mouseTrackingMode = 'drag'
      c.drag()
      await act(async () => {
        c.socket.serverClose(1006)
      })
      await later(1500)
      expect(c.status()).toBeEmptyDOMElement()

      const offline = pane('offline', false)
      offline.term.modes.mouseTrackingMode = 'drag'
      offline.drag()
      await later(1500)
      expect(offline.status()).toBeEmptyDOMElement()

      a.press({ ctrlKey: true })
      fireEvent.contextMenu(a.area.querySelector('.xterm-screen')!)
      a.move()
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.press()
      a.move()
      fireEvent.mouseMove(window, { buttons: 1 })
      fireEvent.mouseMove(window, { buttons: 0 })
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      const rows = a.area.querySelector('.xterm-screen')!
      rows.addEventListener('contextmenu', (event) => event.stopPropagation(), { once: true })
      a.press()
      a.move()
      fireEvent.mouseDown(rows, { button: 2, buttons: 3 })
      fireEvent.contextMenu(rows, { button: 2, buttons: 3 })
      a.release()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.drag()
      fireEvent.contextMenu(document.body, { button: 2, buttons: 2 })
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()

      a.press({ altKey: true })
      a.move()
      fireEvent.mouseMove(window, { buttons: 1 })
      fireEvent.mouseDown(document.body, { button: 1, buttons: 5 })
      a.release(1)
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()
      a.release()
      await later(500)
      fireEvent.mouseMove(window, { buttons: 0 })
      fireEvent.mouseDown(document.body, { button: 1, buttons: 4 })
      await later(1000)
      expect(a.status()).toHaveTextContent('nothing copied: shift-drag, then ctrl-insert')
      await later(5000)
      a.drag()
      await later(1500)
      expect(a.status()).toBeEmptyDOMElement()

      vi.stubGlobal('navigator', { platform: 'MacIntel', clipboard: { writeText: vi.fn(async () => undefined) } })
      const m = pane('mac')
      m.term.modes.mouseTrackingMode = 'drag'
      m.drag({ altKey: true })
      await later(1500)
      expect(m.status()).toBeEmptyDOMElement()
      m.drag({ shiftKey: true })
      await later(1500)
      expect(m.status()).toHaveTextContent('nothing copied: ⌥-drag, then ⌘C')
      vi.stubGlobal('navigator', { platform: 'MacIntel' })
      await act(async () => {
        m.term.osc.get(52)!(';aGk=')
      })
      expect(m.status()).toHaveTextContent('copy blocked: ⌥-drag, then ⌘C')
    } finally {
      focus.mockRestore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('puts text the session copies (OSC 52) on the clipboard, says whether it worked, and never reads the clipboard', async () => {
    const writeText = vi.fn(async () => undefined)
    const readText = vi.fn(async () => 'secret')
    vi.stubGlobal('navigator', { clipboard: { writeText, readText } })
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.useFakeTimers()
    try {
      render(<TerminalPane name="api" active />)
      const osc = xterms[0].osc.get(52)!
      expect(xterms[0].options.macOptionClickForcesSelection).toBe(true)
      await act(async () => {
        expect(osc('c;aMOpbGxvIOKckw==')).toBe(true)
      })
      expect(writeText).toHaveBeenCalledWith('héllo ✓')
      expect(screen.getByRole('status')).toHaveTextContent(/^copied$/)
      await act(async () => {
        vi.advanceTimersByTime(1500)
      })
      expect(screen.getByRole('status')).toHaveTextContent('')
      osc('c;?')
      expect(readText).not.toHaveBeenCalled()
      expect(writeText).toHaveBeenCalledTimes(1)

      writeText.mockRejectedValueOnce(new Error('NotAllowedError'))
      await act(async () => {
        osc(';aGk=')
      })
      expect(screen.getByRole('status')).toHaveTextContent('copy blocked: shift-drag, then ctrl-insert')

      const { rerender } = render(<TerminalPane name="web" active />)
      rerender(<TerminalPane name="web" active={false} />)
      xterms[1].osc.get(52)!(';aGk=')
      expect(writeText).toHaveBeenCalledTimes(2)

      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      focus.mockReturnValue(false)
      await act(async () => {
        osc(';aGk=')
      })
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(screen.getAllByRole('status')[0]).toHaveTextContent('')
    } finally {
      focus.mockRestore()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('decodes OSC 52 payloads and ignores queries and garbage', () => {
    expect(clipboardText('c;aGVsbG8=')).toBe('hello')
    expect(clipboardText(';aGk=')).toBe('hi')
    expect(clipboardText('pc;aGk=')).toBe('hi')
    expect(clipboardText('s;aGk=')).toBe('hi')
    for (const bad of ['c;?', 'c;', 'c; ', 'c;***', '', 'aGk=', 'p;aGk=', 'q0;aGk=', 'xyzc;aGk=', '?c;aGk=']) expect(clipboardText(bad)).toBeNull()
  })

  it('drops the WebGL renderer when its context is lost', () => {
    render(<TerminalPane name="api" active />)
    expect(webgls).toHaveLength(1)
    act(() => webgls[0].lossCb?.())
    expect(webgls[0].dispose).toHaveBeenCalled()
  })

  it('closes the socket and disposes the terminal on unmount without reconnecting', () => {
    const { unmount } = render(<TerminalPane name="api" active />)
    act(() => sockets[0].serverReady())
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
      <TerminalTabs tabs={['api', 'main']} active="api" sessions={[]} insights={new Map()} now={0} onSelect={() => {}} onClose={() => {}} />,
    )
    const tabButtons = screen.getAllByRole('tab')
    for (const [i, name] of ['Overview', 'api', 'main'].entries()) expect(tabButtons[i]).toHaveAccessibleName(name)
    expect(tabButtons[1]).toHaveAttribute('aria-selected', 'true')
    const panes = container.querySelectorAll('.termpane')
    expect(panes).toHaveLength(2)
    expect((panes[0] as HTMLElement).style.display).toBe('flex')
    expect((panes[1] as HTMLElement).style.display).toBe('none')
    expect(sockets).toHaveLength(2)
  })

  it('selects the Overview tab and hides every pane while it is active', () => {
    const { container } = render(<TerminalTabs tabs={['api']} active={null} sessions={[]} insights={new Map()} now={0} onSelect={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect((container.querySelector('.termpane') as HTMLElement).style.display).toBe('none')
  })

  it('fires select and close callbacks', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<TerminalTabs tabs={['api', 'main']} active="api" sessions={[]} insights={new Map()} now={0} onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getAllByRole('tab')[2])
    expect(onSelect).toHaveBeenCalledWith('main')
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }))
    expect(onSelect).toHaveBeenLastCalledWith(null)
    fireEvent.click(screen.getByTitle('Close api'))
    expect(onClose).toHaveBeenCalledWith('api')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'main' }), { key: 'Delete' })
    expect(onClose).toHaveBeenLastCalledWith('main')
  })

  it('closes a focused tab with Delete or Backspace and moves focus to its neighbour', () => {
    const onClose = vi.fn()
    render(<TerminalTabs tabs={['a', 'b', 'c']} active="a" sessions={[]} insights={new Map()} now={0} onSelect={() => {}} onClose={onClose} />)
    const b = screen.getByRole('tab', { name: 'b' })
    b.focus()
    fireEvent.keyDown(b, { key: 'Backspace' })
    expect(onClose).toHaveBeenCalledWith('b')
    act(() => {
      vi.advanceTimersToNextFrame()
    })
    expect(screen.getByRole('tab', { name: 'c' })).toHaveFocus()
  })

  it('keeps the date on tabs whose names would otherwise look the same', () => {
    render(<TerminalTabs tabs={['0412_fix-auth', '0415_fix-auth', '0420_docs']} active={null} sessions={[]} insights={new Map()} now={0} onSelect={() => {}} onClose={() => {}} />)
    const shown = (n: string) => screen.getByRole('tab', { name: n }).querySelector('.tab-name')?.textContent
    expect([shown('0412_fix-auth'), shown('0415_fix-auth'), shown('0420_docs')]).toEqual(['0412_fix-auth', '0415_fix-auth', 'docs'])
  })

  it('shows and describes the counts and each tab session state in words, without changing tab names', () => {
    const api = { name: 'api', attached: false, clients: 0, activityEpoch: 0, bell: false, cmd: 'claude', title: '', path: '/w/api', attachable: true }
    const agent = { agent: 'claude' as const, artifacts: [], commits: 0 }
    const insights = new Map([
      ['api', { ...agent, session: 'api', state: 'waiting' as const }],
      ['1014_build', { ...agent, session: '1014_build', state: 'working' as const, since: 0 }],
    ])
    const shell = { ...api, name: 'sh', cmd: 'zsh', bell: true }
    const build = { ...api, name: '1014_build' }
    render(
      <TerminalTabs
        tabs={['api', 'sh', '1014_build']}
        active="api"
        sessions={[api, shell, build]}
        insights={insights}
        now={23 * 60_000}
        counts={{ needs: 1, working: 2, fresh: 3 }}
        seenAt={() => -1}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAccessibleDescription('1 needs you, 2 working, 3 new')
    expect(screen.getByRole('tab', { name: 'api' })).toHaveAccessibleDescription('waiting on you')
    expect(screen.getByRole('tab', { name: 'api' })).toHaveTextContent('needs you')
    expect(screen.getByRole('tab', { name: 'sh' })).toHaveAccessibleDescription('bell rang')
    expect(screen.getByRole('tab', { name: '1014_build' })).toHaveTextContent('quiet 23m')
  })

  it('drops the date from tab labels and keeps the last word whole so a cut tab stays recognizable', () => {
    const names = ['1013_database_modernizer', '1014_SkillHarness_PerformanceFactory', 'shellprobe', 'x_averyveryverylongtail']
    render(<TerminalTabs tabs={names} active={null} sessions={[]} insights={new Map()} now={0} onSelect={() => {}} onClose={() => {}} />)
    const parts = names.map((n) => {
      const tab = screen.getByRole('tab', { name: n })
      return [tab.querySelector('.tab-head')?.textContent, tab.querySelector('.tab-tail')?.textContent]
    })
    expect(parts).toEqual([
      ['database_', 'modernizer'],
      ['SkillHarness_Performance', 'Factory'],
      ['shellprobe', undefined],
      ['x_averyveryverylongtail', undefined],
    ])
  })

  it('renders nothing without tabs', () => {
    const { container } = render(<TerminalTabs tabs={[]} active={null} sessions={[]} insights={new Map()} now={0} onSelect={() => {}} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
