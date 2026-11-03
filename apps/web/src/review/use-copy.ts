import {useEffect, useRef, useState} from "react";

const copiedResetMilliseconds = 1_600;

/** Copies text to the clipboard and remembers the copied target briefly. */
export function useCopy<Target>() {
  const [copiedTarget, setCopiedTarget] = useState<Target | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);
  const copy = async (text: string, target: Target, failureMessage: string): Promise<void> => {
    setFailure(null);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopiedTarget(null), copiedResetMilliseconds);
    } catch {
      setCopiedTarget(null);
      setFailure(failureMessage);
    }
  };
  const reset = (): void => {
    setCopiedTarget(null);
    setFailure(null);
  };
  return {copiedTarget, copy, failure, reset};
}
