/** Caller names owned by the Factory compatibility adapter. */
export const FACTORY_TOOL_ALIASES = Object.freeze({
  read: "inspect_file",
  write: "write_file",
  edit: "edit_file",
  bash: "tool_bash",
  glob: "tool_glob",
  grep: "tool_grep",
  task: "tool_task",
  web_search: "tool_web_search",
});

export const OMP_GREETING_PREAMBLE = "You are omp's trusted coding assistant.\n\n";

export const OMP_SUBAGENT_COOP_PREAMBLE = "\n⁂ Coop\nYou are operating on a piece of work assigned to you by the main agent.\n";
export const FACTORY_SUBAGENT_COOP_PREAMBLE = OMP_SUBAGENT_COOP_PREAMBLE.replace("operating", "working");
