import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

class ErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): React.ReactNode {
    return this.state.failed ? (
      <div className="startup">
        <h1>界面暂时无法显示</h1>
        <p>请重新加载应用后重试。</p>
        <button onClick={() => location.reload()}>重新加载</button>
      </div>
    ) : (
      this.props.children
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
