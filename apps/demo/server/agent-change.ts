import type { AgentChange, RegistryReader } from "@earendil-works/pi-durable";
import type { SerializedAgentChange } from "@usecontextlayer/pi-durable-assistant-ui";

/** Pi's stored choices are names; its imperative API accepts registered objects. */
export function resolveAgentChange(change: SerializedAgentChange, registry: RegistryReader): AgentChange {
  const snapshot = registry.snapshot();
  const extension = (name: string) => {
    const value = snapshot.extension(name);
    if (!value) throw new RangeError(`Unknown registered extension: ${name}`);
    return value;
  };
  const tool = (name: string) => {
    const value = snapshot.tools().find((item) => item.tool.name === name)?.tool;
    if (!value) throw new RangeError(`Unknown registered tool: ${name}`);
    return value;
  };

  const { extensions, tools, modelTools, ...fields } = change;
  return {
    ...fields,
    extensions: extensions === undefined || extensions === null
      ? extensions
      : Array.isArray(extensions)
        ? extensions.map(extension)
        : {
          ...(extensions.add === undefined ? {} : { add: extensions.add.map(extension) }),
          ...(extensions.remove === undefined ? {} : { remove: extensions.remove.map(extension) }),
        },
    tools: tools === undefined || tools === null
      ? tools
      : Array.isArray(tools)
        ? tools.map(tool)
        : { remove: tools.remove.map(tool) },
    modelTools: modelTools === undefined || modelTools === null
      ? modelTools
      : Array.isArray(modelTools)
        ? modelTools.map(tool)
        : {
          ...(modelTools.add === undefined ? {} : { add: modelTools.add.map(tool) }),
          ...(modelTools.remove === undefined ? {} : { remove: modelTools.remove.map(tool) }),
        },
  };
}
