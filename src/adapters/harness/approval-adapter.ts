import type { HarnessApprovalAdapter, HarnessContext } from "./types.ts";

export class OfficialApprovalAdapter implements HarnessApprovalAdapter {
  constructor(private readonly ctx: HarnessContext) {}

  async requestRestoreApproval(previewText: string): Promise<boolean> {
    const approval = this.ctx.approval ?? (this.ctx.get?.("approval") as HarnessContext["approval"]);
    if (!approval?.request) return false;
    const result = await approval.request({
      title: "Time Machine restore",
      message: previewText,
    });
    if (typeof result === "boolean") return result;
    return result.kind === "allow";
  }
}

export class AlwaysAskAdapter implements HarnessApprovalAdapter {
  constructor(private readonly fn: (text: string) => Promise<boolean> | boolean) {}

  async requestRestoreApproval(previewText: string): Promise<boolean> {
    return this.fn(previewText);
  }
}
