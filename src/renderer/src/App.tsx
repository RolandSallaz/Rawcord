import { useState } from 'react'
import TitleBar from './components/TitleBar'
import NicknamePage from './pages/NicknamePage'
import LobbyPage from './pages/LobbyPage'
import ChannelPage from './pages/ChannelPage'

type Screen =
  | { name: 'nickname' }
  | { name: 'lobby'; nickname: string }
  | { name: 'channel'; nickname: string; signalingUrl: string; isHost: boolean }

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'nickname' })

  return (
    <div className="app-root">
      <TitleBar />
      {screen.name === 'nickname' && (
        <NicknamePage onJoin={(nick) => setScreen({ name: 'lobby', nickname: nick })} />
      )}
      {screen.name === 'lobby' && (
        <LobbyPage
          nickname={screen.nickname}
          onConnect={(url, isHost) =>
            setScreen({ name: 'channel', nickname: screen.nickname, signalingUrl: url, isHost })
          }
          onBack={() => setScreen({ name: 'nickname' })}
        />
      )}
      {screen.name === 'channel' && (
        <ChannelPage
          nickname={screen.nickname}
          signalingUrl={screen.signalingUrl}
          isHost={screen.isHost}
          onLeave={() => setScreen({ name: 'lobby', nickname: screen.nickname })}
        />
      )}
    </div>
  )
}
