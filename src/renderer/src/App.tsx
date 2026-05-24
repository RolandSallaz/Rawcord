import { useState } from 'react'
import TitleBar from './components/TitleBar'
import OnboardingPage from './pages/OnboardingPage'
import ChannelPage from './pages/ChannelPage'
import { loadProfile } from './lib/profile'

export default function App() {
  const [hasProfile, setHasProfile] = useState(() => loadProfile() !== null)

  return (
    <div className="app-root">
      <TitleBar />
      {hasProfile
        ? <ChannelPage />
        : <OnboardingPage onDone={() => setHasProfile(true)} />
      }
    </div>
  )
}
