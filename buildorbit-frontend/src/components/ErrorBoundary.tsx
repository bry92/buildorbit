import { Component, type ErrorInfo, type ReactNode } from 'react';
import './ErrorBoundary.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] Unhandled React error:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="bo-error-page" role="alert">
        <section className="bo-error-card">
          <div className="bo-error-kicker">Runtime interrupted</div>
          <h1>BuildOrbit hit a UI error.</h1>
          <p>
            The server is still reachable, but this screen could not render cleanly.
            Reload the app or return to the dashboard.
          </p>
          {this.state.message && (
            <pre className="bo-error-detail">{this.state.message}</pre>
          )}
          <div className="bo-error-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
            <a href="/dashboard">Dashboard</a>
          </div>
        </section>
      </main>
    );
  }
}
