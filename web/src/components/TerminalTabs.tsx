import { TerminalPane } from './Terminal'

export function TerminalTabs({
  tabs,
  active,
  onSelect,
  onClose,
}: {
  tabs: string[]
  active: string | null
  onSelect: (name: string) => void
  onClose: (name: string) => void
}) {
  if (tabs.length === 0) return null
  return (
    <section className="terminals">
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
        <div key={tab} className="termpane" style={{ display: tab === active ? 'flex' : 'none' }}>
          <TerminalPane name={tab} active={tab === active} />
        </div>
      ))}
    </section>
  )
}
