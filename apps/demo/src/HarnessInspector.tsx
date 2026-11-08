import { useState } from "react";
import type { ConversationId, HarnessInspection } from "@earendil-works/pi-durable";

interface HarnessInspectorProps {
  load: () => Promise<HarnessInspection>;
  onSelectConversation: (id: ConversationId) => void;
}

export function HarnessInspector({ load, onSelectConversation }: HarnessInspectorProps) {
  const [snapshot, setSnapshot] = useState<HarnessInspection>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [readAt, setReadAt] = useState<Date>();

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await load());
      setReadAt(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="harness-inspector" onToggle={(event) => {
      if (event.target === event.currentTarget && event.currentTarget.open) void refresh();
    }}>
      <summary>Harness inspection</summary>
      <div className="harness-inspector-body">
        <div className="inspector-toolbar">
          <button disabled={loading} onClick={() => void refresh()}>{loading ? "Reading harness…" : "Refresh inspection"}</button>
          {readAt ? <span>Snapshot read at {readAt.toLocaleTimeString()}</span> : null}
        </div>
        {error ? <p className="control-error" role="alert">{error}</p> : null}
        {snapshot ? (
          <>
            <p>Scheduling: <strong>{snapshot.scheduling}</strong></p>
            <h2>Live tasks</h2>
            {snapshot.tasks.length === 0 ? <p>No live tasks.</p> : (
              <div className="task-table-wrapper">
                <table className="task-table">
                  <thead><tr><th>Task</th><th>Conversation</th><th>State</th><th>Ownership</th></tr></thead>
                  <tbody>
                    {snapshot.tasks.map(({ record, state }) => (
                      <tr key={record.id}>
                        <td><span>{record.kind}</span><small>Task {record.id}</small></td>
                        <td><button className="text-button" onClick={() => onSelectConversation(record.conversationId)}>Conversation {record.conversationId}</button></td>
                        <td>{state.kind}</td>
                        <td>{record.owner !== undefined ? `Task ${record.owner}` : "Conversation"}{record.background ? " · background" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h2>Unsettled submissions</h2>
            {snapshot.submissions.length === 0 ? <p>No unsettled submissions.</p> : (
              <ul className="inspector-submissions">
                {snapshot.submissions.map((submission) => (
                  <li key={submission.id}>
                    <span>Submission {submission.id} · {submission.type} · {submission.status}</span>
                    <button className="text-button" onClick={() => onSelectConversation(submission.conversationId)}>Conversation {submission.conversationId}</button>
                  </li>
                ))}
              </ul>
            )}
            <details className="native-inspection">
              <summary>Native inspection data</summary>
              <pre className="native-json">{JSON.stringify(snapshot, null, 2)}</pre>
            </details>
          </>
        ) : null}
      </div>
    </details>
  );
}
