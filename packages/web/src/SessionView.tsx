import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { SignedEvent } from "@side-street/core";
import { deriveSession, type TimelineItem } from "./lib/derive.js";
import type { SessionStatus } from "./lib/session-client.js";

export function SessionView({
  events,
  status,
  notice,
  self,
  onSteer,
  onTakeWheel,
  onLeave,
}: {
  events: SignedEvent[];
  status: SessionStatus;
  notice: string | null;
  self: string;
  onSteer(text: string, delivery: "queue" | "interrupt"): void;
  onTakeWheel(): void;
  onLeave(): void;
}): ReactElement {
  const { timeline, roster, driverId } = useMemo(() => deriveSession(events), [events]);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline.length]);

  const submit = (delivery: "queue" | "interrupt"): void => {
    const text = draft.trim();
    if (text === "") return;
    onSteer(text, delivery);
    setDraft("");
  };

  return (
    <main className="session">
      <header>
        <div>
          <strong>Side Street</strong>
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <div className="roster">
          {roster.map((p) => (
            <span key={p.id} className={`chip chip-${p.role}`} title={p.role}>
              {p.id === driverId ? "🛞 " : ""}
              {p.displayName}
            </span>
          ))}
          <button className="ghost" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <section className="timeline">
        {timeline.map((item) => (
          <TimelineRow key={item.key} item={item} />
        ))}
        <div ref={bottomRef} />
      </section>

      {notice !== null && <div className="notice">{notice}</div>}

      <footer>
        <button
          className="ghost"
          onClick={onTakeWheel}
          disabled={driverId === self}
          title="Become the Driver"
        >
          🛞 Take the wheel
        </button>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit("queue");
            }
          }}
          placeholder={driverId === self ? "Steer the agent…" : "Suggest to the driver…"}
        />
        <button onClick={() => submit("queue")}>Send</button>
        <button
          className="danger"
          onClick={() => submit("interrupt")}
          title="Cancel the running turn and send now"
        >
          Interrupt
        </button>
      </footer>
    </main>
  );
}

function TimelineRow({ item }: { item: TimelineItem }): ReactElement {
  switch (item.kind) {
    case "agent_text":
      return <div className="row agent">{item.text}</div>;
    case "human":
      return (
        <div className={`row human human-${item.role}`}>
          <span className="author">
            {item.authorId}
            {item.role !== "driver" ? " (suggestion)" : ""}
            {item.delivery === "interrupt" ? " ⚡" : ""}
          </span>
          {item.text}
        </div>
      );
    case "tool":
      return (
        <div className={`row tool tool-${item.status}`}>
          <span className="tool-status">{toolIcon(item.status)}</span>
          {item.title}
          {item.output !== undefined && <pre>{item.output}</pre>}
        </div>
      );
    case "system":
      return <div className="row system">{item.text}</div>;
  }
}

function toolIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      return "…";
  }
}
