// --- The injectable process-execution seam. Pure type, no imports.
//
// It lived in plugins/plugin-install.ts, which forced fs/default-filemanager.ts
// (the LOWEST layer) to import UP into plugins/ for a function signature —
// pulling the whole plugin API into its dependency graph. plugins/ may depend
// on lib/ but not the other way round, so the leaf has to live here.

export type ExecResult = { exit: number; output: string };

export type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;
