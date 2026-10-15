import { useCallback, useEffect, useRef, useState } from 'react'

export interface PollState {
  pendingSince: number | null
  nextAt: number | null
}

export function usePoll(task: () => Promise<boolean>, everyMs: number): PollState & { run: () => void } {
  const [state, setState] = useState<PollState>({ pendingSince: null, nextAt: null })
  const timer = useRef<number | null>(null)
  const busy = useRef(false)
  const rerun = useRef(false)
  const live = useRef(true)
  const latest = useRef(task)
  latest.current = task

  const run = useCallback(() => {
    if (busy.current) {
      rerun.current = true
      return
    }
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    busy.current = true
    setState({ pendingSince: Date.now(), nextAt: null })
    void latest
      .current()
      .catch(() => true)
      .then((again) => {
        busy.current = false
        if (!live.current) return
        if (rerun.current) {
          rerun.current = false
          return run()
        }
        if (again) timer.current = window.setTimeout(run, everyMs)
        setState({ pendingSince: null, nextAt: again ? Date.now() + everyMs : null })
      })
  }, [everyMs])

  useEffect(() => {
    live.current = true
    run()
    return () => {
      live.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [run])

  return { ...state, run }
}
