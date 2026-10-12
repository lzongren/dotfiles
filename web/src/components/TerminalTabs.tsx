import { useEffect, useRef } from 'react'
import { TerminalPane } from './Terminal'

export function TerminalTabs({
  tabs,
  active,
  scrollKey,
  onSelect,
  onClose,
}: {
  tabs: string[]
  active: string | null
  scrollKey: number
  onSelect: (name: string) => void
  onClose: (name: string) => void
}) {
  const sectionRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (scrollKey > 0) sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [scrollKey])
  if (tabs.length === 0) return null
  return (
    <section className="terminals" ref={sectionRef}>
      <div className="tabstrip" role="tablist">
        {tabs.map((tab) => (
          <span key={tab} className="tab" data-active={tab === active}>
            <button type="button" role="tab" aria-selected={tab === active} onClick={() => onSelect(tab)}>
              {tab}
            </button>
            <button type="button" aria-label={`close ${tab}`} className="tab-close" onClick={() => onClose(tab)}>
              ×
            </button>
          </span>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab} className="termpane" style={{ display: tab === active ? 'block' : 'none' }}>
          <TerminalPane name={tab} active={tab === active} />
        </div>
      ))}
    </section>
  )
}
