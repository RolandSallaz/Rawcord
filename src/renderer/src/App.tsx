import { useState } from 'react'
import TitleBar from './components/TitleBar'
import NicknamePage from './pages/NicknamePage'
import ChannelPage from './pages/ChannelPage'

export default function App() {
  const [nickname, setNickname] = useState<string | null>(null)

  return (
    <div className="app-root">
      <TitleBar />
      {!nickname
        ? <NicknamePage onJoin={setNickname} />
        : <ChannelPage nickname={nickname} onLeave={() => setNickname(null)} />
      }
    </div>
  )
}
