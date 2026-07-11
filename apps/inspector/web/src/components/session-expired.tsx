interface SessionExpiredProps {
  readonly reason?: string;
}

export default function SessionExpired({ reason }: SessionExpiredProps) {
  const message =
    reason ??
    "Inspector token rejected. Please re-run `alaya inspect` to obtain a fresh URL.";

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-beige-100 p-8 text-center">
      <h1 className="text-2xl font-bold text-ink-600 mb-4 font-mono uppercase tracking-widest">
        Session Expired
      </h1>
      <p className="text-ink-700 max-w-md font-mono text-sm leading-relaxed mb-8">
        {message}
      </p>
      <pre className="bg-beige-150 text-ink-600 px-4 py-2 rounded text-xs font-mono">
        rtk pnpm exec alaya inspect --open
      </pre>
      <div className="mt-8 pt-8 border-t border-beige-300 w-full max-w-xs">
        <code className="text-xs text-ink-500">ERROR_CODE: AUTH_TOKEN_REJECTED</code>
      </div>
    </div>
  );
}
