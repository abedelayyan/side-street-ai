import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { roleSchema, type Role, type SignedEvent } from "@side-street/core";
import { SessionClient, type SessionStatus } from "./lib/session-client.js";
import { SessionView } from "./SessionView.js";

interface JoinDetails {
  baseUrl: string;
  sessionId: string;
  participantId: string;
  role: Role;
}

export function App(): ReactElement {
  const [details, setDetails] = useState<JoinDetails | null>(null);
  return details === null ? (
    <JoinForm onJoin={setDetails} />
  ) : (
    <Session details={details} onLeave={() => setDetails(null)} />
  );
}

function JoinForm({ onJoin }: { onJoin(details: JoinDetails): void }): ReactElement {
  const [baseUrl, setBaseUrl] = useState("http://localhost:8787");
  const [sessionId, setSessionId] = useState("demo");
  const [participantId, setParticipantId] = useState("");
  const [role, setRole] = useState<Role>("observer");

  return (
    <main className="join">
      <h1>Side Street</h1>
      <p className="tagline">Drop into a live agent session.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (participantId.trim() === "") return;
          onJoin({ baseUrl, sessionId, participantId: participantId.trim(), role });
        }}
      >
        <label>
          Server
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          Session
          <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
        </label>
        <label>
          Your name
          <input
            value={participantId}
            onChange={(e) => setParticipantId(e.target.value)}
            placeholder="ada"
            autoFocus
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(roleSchema.parse(e.target.value))}>
            <option value="driver">Driver — steer and approve</option>
            <option value="navigator">Navigator — suggest</option>
            <option value="observer">Observer — watch</option>
          </select>
        </label>
        <button type="submit">Join session</button>
      </form>
    </main>
  );
}

function Session({ details, onLeave }: { details: JoinDetails; onLeave(): void }): ReactElement {
  const [events, setEvents] = useState<SignedEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const clientRef = useRef<SessionClient | null>(null);

  useEffect(() => {
    const client = new SessionClient({
      baseUrl: details.baseUrl,
      sessionId: details.sessionId,
      participantId: details.participantId,
      displayName: details.participantId,
      role: details.role,
      onEvent: (event) => setEvents((prev) => [...prev, event]),
      onStatus: setStatus,
      onRejection: (_messageId, reason) => setNotice(reason),
      onError: (error) => setNotice(error.message),
    });
    clientRef.current = client;
    client.connect();
    return () => {
      clientRef.current = null;
      client.close();
    };
  }, [details]);

  const steer = useCallback((text: string, delivery: "queue" | "interrupt") => {
    setNotice(null);
    clientRef.current?.steer(text, delivery);
  }, []);
  const takeWheel = useCallback(() => {
    setNotice(null);
    clientRef.current?.takeWheel();
  }, []);

  return (
    <SessionView
      events={events}
      status={status}
      notice={notice}
      self={details.participantId}
      onSteer={steer}
      onTakeWheel={takeWheel}
      onLeave={onLeave}
    />
  );
}
