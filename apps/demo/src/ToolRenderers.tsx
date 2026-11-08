import { useState, type FormEvent } from "react";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";

export function HumanInputTool(props: ToolCallMessagePartProps) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const request = props.approval;
  if (!request || request.display !== "text") return <ToolResult {...props} />;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = String(new FormData(event.currentTarget).get("response") ?? "").trim();
    if (!response) {
      setError("Enter a response.");
      return;
    }
    setSending(true);
    setError(undefined);
    void props.respondToApproval({ text: response })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false));
  }

  return (
    <section className="human-input" aria-label="Agent question">
      <h3>Pi needs your input</h3>
      <p>{request.prompt}</p>
      {request.approved !== undefined ? (
        <div className="human-answer"><strong>Your response</strong><p>{request.text}</p></div>
      ) : (
        <form onSubmit={submit}>
          <label><span>Response</span><textarea name="response" aria-label="Response" required rows={3} disabled={sending} /></label>
          <button className="send-button" disabled={sending}>{sending ? "Sending response…" : "Send response"}</button>
        </form>
      )}
      {error ? <p className="control-error" role="alert">{error}</p> : null}
    </section>
  );
}

function ToolResult({ label, toolName, args, result, artifact, status, isError, modelContent }: ToolCallMessagePartProps & { label?: string }) {
  const files = modelContent?.filter((part) => part.type === "file") ?? [];
  const text = modelContent?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const output = result ?? text;

  return (
    <details className="tool-result" data-error={isError || undefined} open={status.type === "running" || isError || files.length > 0}>
      <summary>
        <span>{label ?? toolName}</span>
        <span className="tool-status">{isError ? "error" : status.type}</span>
      </summary>
      <div className="tool-details">
        <h3>Input</h3>
        <pre>{JSON.stringify(args, null, 2)}</pre>
        {output !== undefined && output !== "" ? (
          <>
            <h3>Result</h3>
            <pre>{typeof output === "string" ? output : JSON.stringify(output, null, 2)}</pre>
          </>
        ) : null}
        {artifact != null ? (
          <>
            <h3>Details</h3>
            <pre>{typeof artifact === "string" ? artifact : JSON.stringify(artifact, null, 2)}</pre>
          </>
        ) : null}
        {files.map((part, index) => {
          const url = /^(data:|https?:)/.test(part.data) ? part.data : `data:${part.mediaType};base64,${part.data}`;
          return part.mediaType.startsWith("image/") ? (
            <img key={index} className="tool-output-image" src={url} alt={part.filename ?? `${toolName} output ${index + 1}`} />
          ) : (
            <a key={index} className="tool-output-file" href={url} download={part.filename ?? `${toolName}-output`}>{part.filename ?? `Download ${part.mediaType} output`}</a>
          );
        })}
      </div>
    </details>
  );
}

function ShellTool(props: ToolCallMessagePartProps) { return <ToolResult {...props} label="Shell command" />; }
function ReadTool(props: ToolCallMessagePartProps) { return <ToolResult {...props} label="Read file" />; }
function WriteTool(props: ToolCallMessagePartProps) { return <ToolResult {...props} label="Write file" />; }
function EditTool(props: ToolCallMessagePartProps) { return <ToolResult {...props} label="Edit file" />; }

export const toolRenderers = {
  Fallback: ToolResult,
  by_name: { bash: ShellTool, read: ReadTool, write: WriteTool, edit: EditTool },
};
