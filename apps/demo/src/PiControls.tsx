import { useState, type FormEvent } from "react";
import type { AgentState, ContextView, UsageState } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SerializedAgentChange, PiClient, PiRuntimeState, PiRuntimeStore } from "@usecontextlayer/pi-durable-assistant-ui";
import { conversationInbox, conversationLiveState } from "@usecontextlayer/pi-durable-assistant-ui";

export interface RegisteredModel {
  id: string;
  name: string;
  provider: string;
}

interface PiControlsProps {
  client: Required<PiClient>;
  state: PiRuntimeState;
  actions: PiRuntimeStore;
  models: readonly RegisteredModel[];
}

const thinkingLevels: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function PiControls({ client, state, actions, models }: PiControlsProps) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [context, setContext] = useState<ContextView>();

  const id = state.selectedId;
  const view = state.view;
  if (id === undefined || !view) return null;
  const agent = (view.docs["pi.agent"] ?? {}) as AgentState;
  const live = conversationLiveState(view);
  const inbox = conversationInbox(view);
  const usage = view.docs["pi.usage"] as UsageState | undefined;
  const { model } = agent;
  const modelValue = model ? JSON.stringify([model.provider, model.modelId]) : "";
  const modelOptions = model && !models.some((candidate) => candidate.provider === model.provider && candidate.id === model.modelId)
    ? [{ provider: model.provider, id: model.modelId, name: model.modelId }, ...models]
    : models;
  const children = state.conversations.filter((conversation) => conversation.owner?.conversationId === id);

  async function run(action: () => Promise<string | void>, message?: string) {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await action();
      setNotice(result ?? message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const chosenModel = String(fields.get("model"));
    const thinking = String(fields.get("thinking"));
    const maxTurns = String(fields.get("maxTurns")).trim();
    const cwd = String(fields.get("cwd")).trim();
    const [provider, modelId] = chosenModel ? JSON.parse(chosenModel) as [string, string] : [];
    void run(() => actions.configure({
      model: provider && modelId ? { provider, modelId } : null,
      thinkingLevel: thinking ? thinking as ModelThinkingLevel : null,
      maxTurns: maxTurns ? Number(maxTurns) : null,
      cwd: cwd || null,
    }), "Conversation configuration saved.");
  }

  return (
    <details className="native-controls">
      <summary>Conversation controls</summary>
      <div className="native-controls-body">
        {notice ? <p className="control-notice" role="status">{notice}</p> : null}
        {error ? <p className="control-error" role="alert">{error}</p> : null}

        {view.conversation.parent || view.conversation.owner || children.length > 0 ? (
          <div className="conversation-relations">
            {view.conversation.parent ? (
              <p>Forked from <button onClick={() => actions.selectConversation(view.conversation.parent!.conversationId)}>Conversation {view.conversation.parent.conversationId}</button> at entry {view.conversation.parent.at}.</p>
            ) : null}
            {view.conversation.owner ? (
              <p>Created by task {view.conversation.owner.taskId} in <button onClick={() => actions.selectConversation(view.conversation.owner!.conversationId)}>Conversation {view.conversation.owner.conversationId}</button>.</p>
            ) : null}
            {children.length > 0 ? (
              <div>Child conversations: {children.map((conversation) => <button key={conversation.id} onClick={() => actions.selectConversation(conversation.id)}>Conversation {conversation.id}</button>)}</div>
            ) : null}
          </div>
        ) : null}

        <div className="native-action-row">
          <button
            disabled={pending || live.run !== undefined}
            onClick={() => void run(async () => {
              const submission = await actions.continue();
              return `Continuation ${submission.id}: ${submission.status}.`;
            })}
          >Continue</button>
          <button disabled={pending} onClick={() => void run(async () => {
            setContext(await client.context(id));
          }, "Current model context loaded.")}>Inspect model context</button>
        </div>

        <form className="configuration-form" onSubmit={configure} key={JSON.stringify(agent)}>
          <h2>Configuration</h2>
          <div className="configuration-fields">
            <label>
              <span>Model</span>
              <select name="model" defaultValue={modelValue}>
                <option value="">No model</option>
                {modelOptions.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={JSON.stringify([model.provider, model.id])}>
                    {model.name} · {model.provider}/{model.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Thinking level</span>
              <select name="thinking" defaultValue={agent.thinkingLevel ?? ""}>
                <option value="">Host default</option>
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
            <label>
              <span>Maximum tool rounds</span>
              <input name="maxTurns" type="number" min={1} step={1} defaultValue={agent.maxTurns ?? ""} placeholder="No limit" />
            </label>
            <label>
              <span>Working directory</span>
              <input name="cwd" defaultValue={agent.cwd ?? ""} placeholder="Host default" />
            </label>
          </div>
          <button type="submit" disabled={pending}>Save configuration</button>
        </form>

        <details className="native-inspection">
          <summary>Advanced native configuration</summary>
          <p>Apply a native configuration patch. Omitted fields stay unchanged; null clears a stored choice. Prompt text is supplied by registered instruction sections.</p>
          <form onSubmit={(event) => {
            event.preventDefault();
            const text = String(new FormData(event.currentTarget).get("patch") ?? "{}");
            void run(async () => {
              const patch: unknown = JSON.parse(text);
              if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("The configuration patch must be a JSON object.");
              await actions.configure(patch as SerializedAgentChange);
            }, "Native configuration patch applied.");
          }}>
            <label><span>Native configuration patch</span><textarea name="patch" aria-label="Native configuration patch" rows={6} defaultValue="{}" spellCheck={false} /></label>
            <button className="native-patch-submit" disabled={pending}>Apply native patch</button>
          </form>
          <h3>Current native configuration</h3>
          <pre className="native-json">{JSON.stringify(agent, null, 2)}</pre>
        </details>

        <div className="context-actions">
          <form onSubmit={(event) => {
            event.preventDefault();
            const handoff = String(new FormData(event.currentTarget).get("handoff")).trim();
            void run(() => actions.reset(handoff || undefined), "Context reset requested; previous history is retained.");
          }}>
            <label><span>Reset handoff</span><input name="handoff" placeholder="Optional note for the new context" /></label>
            <button disabled={pending}>Reset context</button>
          </form>
          <form onSubmit={(event) => {
            event.preventDefault();
            const instructions = String(new FormData(event.currentTarget).get("instructions")).trim();
            void run(async () => {
              const taskId = await actions.compact(instructions || undefined);
              return `Compaction task ${taskId} requested.`;
            });
          }}>
            <label><span>Compaction instructions</span><input name="instructions" placeholder="Optional summary instructions" /></label>
            <button disabled={pending}>Compact context</button>
          </form>
        </div>

        <details className="native-inspection">
          <summary>Execution, inbox and usage</summary>
          <h3>Execution</h3>
          <p>{live.run ? live.run.afterRun ? "After-run work is active." : `Running task ${live.run.taskId}, tool round ${live.run.turns}.` : "No active run."}</p>
          {live.runFailure ? <p className="control-error">{live.runFailure.reason}: {live.runFailure.detail}</p> : null}
          {live.generation?.retry ? <p className="control-error">Retrying: {live.generation.retry.error}</p> : null}
          <h3>Pending submissions</h3>
          {inbox.items.length === 0 ? <p>No queued submissions.</p> : (
            <ul className="inbox-items">
              {inbox.items.map((item) => (
                <li key={item.id}>
                  <div><strong>Submission {item.id}</strong><span>{item.mode}</span></div>
                  <pre>{JSON.stringify("content" in item ? item.content : item.entry, null, 2)}</pre>
                  <button disabled={pending} onClick={() => void run(async () => `Submission ${item.id}: ${await actions.abortSubmission(item.id)}.`)}>Withdraw submission {item.id}</button>
                </li>
              ))}
            </ul>
          )}
          <h3>Usage</h3>
          {usage ? <pre className="native-json">{JSON.stringify(usage, null, 2)}</pre> : <p>No usage recorded.</p>}
          {live.compactions || live.compactionFailure ? <><h3>Compaction</h3><pre className="native-json">{JSON.stringify({ tasks: live.compactions, failure: live.compactionFailure }, null, 2)}</pre></> : null}
        </details>

        {context ? (
          <details className="native-inspection" open>
            <summary>Model context snapshot</summary>
            <pre className="native-json">{JSON.stringify(context, null, 2)}</pre>
          </details>
        ) : null}
      </div>
    </details>
  );
}
