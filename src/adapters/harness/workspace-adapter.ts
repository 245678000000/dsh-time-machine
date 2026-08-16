import type { HarnessWorkspaceAdapter } from "./types.ts";

export class ConfiguredWorkspaceAdapter implements HarnessWorkspaceAdapter {
  constructor(private readonly workspaceRoot: string) {}

  root(): string {
    return this.workspaceRoot;
  }
}
