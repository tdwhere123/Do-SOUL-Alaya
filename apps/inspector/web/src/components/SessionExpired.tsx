interface SessionExpiredProps {
  readonly reason?: string;
}

export default function SessionExpired({ reason }: SessionExpiredProps) {
  const message =
    reason ??
    "Inspector token rejected. Please re-run `alaya inspect` to obtain a fresh URL.";

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#FDF6E3] p-8 text-center">
      <h1 className="text-2xl font-bold text-[#586E75] mb-4 font-mono uppercase tracking-widest">
        Session Expired
      </h1>
      <p className="text-[#657B83] max-w-md font-mono text-sm leading-relaxed mb-8">
        {message}
      </p>
      <pre className="bg-[#EEE8D5] text-[#586E75] px-4 py-2 rounded text-xs font-mono">
        rtk pnpm exec alaya inspect --open
      </pre>
      <div className="mt-8 pt-8 border-t border-[#D4CDB8] w-full max-w-xs">
        <code className="text-xs text-[#93A1A1]">ERROR_CODE: AUTH_TOKEN_REJECTED</code>
      </div>
    </div>
  );
}
