import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { reportProblem, toast } from './notify';
import './app.css';

// Anything that breaks in the browser is shown and sent to the Problems log.
window.addEventListener('error', (e) => {
  reportProblem(`Page error: ${e.message}`, e.error?.stack);
  toast(`Page error: ${e.message}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason as Error | undefined;
  if ((err as { status?: number })?.status !== undefined) return; // API errors already showed a toast
  reportProblem(`Page error: ${err?.message ?? String(e.reason)}`, err?.stack);
  toast(`Page error: ${err?.message ?? String(e.reason)}`);
});

/** Shows a readable crash screen instead of a blank page when a component crashes. */
class CrashScreen extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportProblem(`Page crashed: ${error.message}`, `${error.stack}\n${info.componentStack ?? ''}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto mt-20 max-w-xl rounded-lg border border-red-800 bg-red-950/40 p-6">
        <h1 className="mb-2 text-lg font-semibold text-red-300">Something crashed in the page</h1>
        <p className="mb-3 text-sm text-slate-300">It was sent to the Problems log. Reload to continue.</p>
        <pre className="mb-4 max-h-60 overflow-auto whitespace-pre-wrap text-xs text-red-200">{this.state.error.stack ?? this.state.error.message}</pre>
        <button className="btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
