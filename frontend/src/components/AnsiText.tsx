import { useMemo } from "react";
import { parseAnsiText } from "../model/ansiText";

export function AnsiText({ text, className = "" }: { text: string; className?: string }) {
  const parsed = useMemo(() => parseAnsiText(text), [text]);
  const classes = [className, parsed.hasAnsi ? "has-ansi" : ""].filter(Boolean).join(" ");
  return (
    <pre className={classes || undefined}>
      {parsed.runs.map((run, index) => (
        <span className="ansi-text-run" style={run.style} key={index}>{run.text}</span>
      ))}
    </pre>
  );
}
