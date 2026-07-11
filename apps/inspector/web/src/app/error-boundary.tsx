import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "react-router-dom";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Inspector surface crashed:", error, info.componentStack);
  }

  public render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="error-boundary-fallback"
        className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 bg-beige-100 p-8 text-center"
      >
        <p className="font-mono text-sm text-ink-700">页面渲染出错</p>
        <p className="font-mono text-xs text-ink-600/80 break-all max-w-md">{error.message}</p>
        <Link
          to="/"
          onClick={() => this.setState({ error: null })}
          className="font-mono text-xs uppercase tracking-widest text-ink-600 hover:text-ink-700 underline"
        >
          返回首页
        </Link>
      </div>
    );
  }
}
