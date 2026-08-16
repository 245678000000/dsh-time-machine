import type { SideEffectRecord, UndoAdapter, UndoPreview, UndoResult } from "../domain/types.ts";

/** v0.1: tell the truth. No fake external undo. */
export class NoopUndoAdapter implements UndoAdapter {
  async canUndo(_effect: SideEffectRecord): Promise<boolean> {
    return false;
  }

  async previewUndo(effect: SideEffectRecord): Promise<UndoPreview> {
    return {
      possible: false,
      summary: `No undo adapter is registered for ${effect.toolName} (${effect.category}).`,
      reversibility: effect.reversibility,
    };
  }

  async undo(effect: SideEffectRecord): Promise<UndoResult> {
    return {
      status: "not-supported",
      summary: `Time Machine will not pretend to undo ${effect.summary}`,
    };
  }
}
