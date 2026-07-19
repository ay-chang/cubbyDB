import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defense against an uncaught render error. Without this, any
 * exception thrown while rendering (e.g. a stale index into a result set)
 * unmounts the entire React tree, leaving a blank page with no way back short
 * of a full restart. This catches it and shows a small recoverable message
 * instead — inline, not a modal, matching the rest of the app's error style.
 *
 * Error boundaries must be class components; React has no hook equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[cubbydb] render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-guard">
          <div className="crash-guard__card">
            <span className="crash-guard__title">Something went wrong</span>
            <span className="crash-guard__detail mono">
              {this.state.error.message}
            </span>
            <button
              className="btn btn--outline"
              onClick={() => this.setState({ error: null })}
            >
              Try to recover
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
