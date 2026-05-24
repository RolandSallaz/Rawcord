// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

export default function TitleBar() {
  return (
    <div className="titlebar">
      <span className="titlebar-title">disAnalog</span>
      <div className="titlebar-controls">
        <button className="tb-btn tb-min" onClick={() => ipcRenderer.send('win:minimize')} title="Свернуть">
          <svg viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        <button className="tb-btn tb-max" onClick={() => ipcRenderer.send('win:maximize')} title="Развернуть">
          <svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
        </button>
        <button className="tb-btn tb-close" onClick={() => ipcRenderer.send('win:close')} title="Закрыть">
          <svg viewBox="0 0 12 12"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
    </div>
  )
}
