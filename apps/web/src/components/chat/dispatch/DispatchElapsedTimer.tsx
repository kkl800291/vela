import { useEffect, useState } from "react";

import { formatElapsedDuration } from "./dispatchModel";

export function DispatchElapsedTimer({
  startedAt,
  className,
}: {
  readonly startedAt?: string | undefined;
  readonly className?: string | undefined;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives 1s elapsed timer in an isolated leaf while a dispatch step is active
  useEffect(() => {
    if (!startedAt) return;
    const immediate = window.setTimeout(() => {
      setNowMs(Date.now());
    }, 0);
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearTimeout(immediate);
      window.clearInterval(timer);
    };
  }, [startedAt]);

  const label = formatElapsedDuration(startedAt, nowMs);
  if (!label) return null;

  return <span className={className}>{label}</span>;
}
