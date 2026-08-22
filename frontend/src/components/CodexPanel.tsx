import { FormEvent, useState } from "react";
import { SparkIcon } from "./icons";

interface Message {
  role: "user" | "assistant";
  text: string;
}

interface CodexPanelProps {
  available: boolean | null;
}

export function CodexPanel({ available }: CodexPanelProps) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: "I can see this workspace and help reason about the notebook. Select a cell or ask about the whole project.",
    },
  ]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value) return;
    setMessages((current) => [
      ...current,
      { role: "user", text: value },
      {
        role: "assistant",
        text: "The local transport is ready; streamed UI events are the next backend milestone.",
      },
    ]);
    setPrompt("");
  }

  return (
    <aside className="codex-panel" aria-label="Codex assistant">
      <div className="codex-heading">
        <span><SparkIcon />CODEX</span>
        <span className={`connection-state ${available ? "is-ready" : ""}`}>
          <i />{available === null ? "checking" : available ? "CLI ready" : "CLI unavailable"}
        </span>
      </div>
      <div className="context-strip">
        <span>Context</span>
        <button>analysis.ipynb</button>
        <button>cell 3</button>
      </div>
      <div className="conversation">
        {messages.map((message, index) => (
          <div className={`message message-${message.role}`} key={index}>
            <span>{message.role === "assistant" ? "CODEX" : "YOU"}</span>
            <p>{message.text}</p>
            {message.role === "assistant" && index === 0 && (
              <div className="suggestions">
                <button>Explain this cell</button>
                <button>Find the error</button>
                <button>Write the next cell</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <form className="prompt-box" onSubmit={submit}>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask about this notebook…"
          rows={3}
        />
        <div className="prompt-actions">
          <button type="button" className="context-button">@ context</button>
          <span>↵ send · ⇧↵ newline</span>
          <button type="submit" className="send-button" disabled={!prompt.trim()}>↑</button>
        </div>
      </form>
    </aside>
  );
}
