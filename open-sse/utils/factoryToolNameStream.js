/** Hold Factory Chat headers until the wire name is complete, before translation. */
export function createFactoryToolNameStream(map) {
  const pending = new Map();
  const released = new Set();
  const wires = [...map.keys()];
  const isPrefix = (name) => wires.some((wire) => wire.startsWith(name));
  const header = (entry) => ({
    ...entry.event,
    choices: [{ ...entry.choice, index: entry.choiceKey, delta: { tool_calls: [{ ...entry.call, index: entry.callIndex, function: { ...entry.call.function, name: map.get(entry.name) ?? entry.name } }] }, finish_reason: null }],
    usage: undefined,
  });
  const resolve = (key, output) => {
    const entry = pending.get(key);
    if (!entry) return;
    output.push(header(entry));
    pending.delete(key);
    released.add(key);
  };
  return {
    push(chunk) {
      if (chunk?.error || chunk?.type === "error") {
        pending.clear();
        return [chunk];
      }
      if (!Array.isArray(chunk?.choices)) return [chunk];
      const output = [];
      let changed = false;
      const choices = chunk.choices.map((choice, choicePosition) => {
        const choiceKey = choice.index ?? choicePosition;
        const calls = choice.delta?.tool_calls;
        const remaining = [];
        if (Array.isArray(calls)) {
          for (let position = 0; position < calls.length; position++) {
            const call = calls[position];
            const key = `${choiceKey}:${call.index ?? position}`;
            if (released.has(key)) {
              remaining.push(call.index === undefined ? { ...call, index: position } : call);
              changed ||= call.index === undefined;
              continue;
            }
            const fragment = call.function?.name ?? "";
            const args = call.function?.arguments;
            const hasArguments = typeof args === "string" && args.length > 0;
            let entry = pending.get(key);
            if (!entry && fragment && !isPrefix(fragment)) {
              released.add(key);
              remaining.push(call.index === undefined ? { ...call, index: position } : call);
              changed ||= call.index === undefined;
              continue;
            }
            if (!entry) {
              entry = { event: chunk, choice, choiceKey, callIndex: call.index ?? position, call: { ...call, function: { ...call.function } }, name: "" };
              delete entry.call.function.arguments;
              pending.set(key, entry);
            } else {
              entry.call = { ...entry.call, ...call, function: { ...entry.call.function, ...call.function } };
              delete entry.call.function.arguments;
            }
            entry.name += fragment;
            changed = true;
            const diverged = entry.name.length > 0 && !isPrefix(entry.name);
            if (hasArguments || diverged) {
              resolve(key, output);
              if (hasArguments) {
                const remainder = { ...call, index: call.index ?? position, function: { ...call.function } };
                delete remainder.function.name;
                delete remainder.id;
                delete remainder.type;
                remaining.push(remainder);
              }
            }
          }
        }
        if (choice.finish_reason != null) {
          for (const [key, entry] of pending) if (entry.choiceKey === choiceKey) resolve(key, output);
        }
        if (!Array.isArray(calls) || !changed) return choice;
        const delta = { ...choice.delta };
        if (remaining.length) delta.tool_calls = remaining;
        else delete delta.tool_calls;
        return { ...choice, index: choiceKey, delta };
      });
      if (!changed) output.push(chunk);
      else {
        // Text, role, reasoning, usage and terminal metadata must not wait for names.
        const remainder = { ...chunk, choices };
        if (chunk.usage || choices.some((choice) => choice.finish_reason != null || Object.keys(choice.delta ?? {}).length > 0)) output.push(remainder);
      }
      return output;
    },
    flush() {
      const output = [];
      for (const key of pending.keys()) resolve(key, output);
      return output;
    },
  };
}
