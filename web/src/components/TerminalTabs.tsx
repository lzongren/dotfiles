import { TerminalPane } from './Terminal'

export function TerminalTabs({
  tabs,
  active,
  focusSignal = 0,
  onSelect,
  onClose,
}: {
  tabs: string[]
  active: string | null
  focusSignal?: number
  onSelect: (name: string | null) => void
  onClose: (name: string) => void
}) {
  if (tabs.length === 0) return null
  return (
    <section className="terminals" data-overview={active === null}>
      <div className="tabstrip" role="tablist">
        <span className="tab" data-active={active === null}>
          <button type="button" role="tab" aria-selected={active === null} onClick={() => onSelect(null)}>
            Overview
          </button>
        </span>
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
        <div key={tab} className="termpane" style={{ display: tab === active ? 'flex' : 'none' }}>
          <TerminalPane name={tab} active={tab === active} focusSignal={tab === active ? focusSignal : 0} />
        </div>
      ))}
    </section>
  )
}
