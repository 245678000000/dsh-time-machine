import type { CheckpointStore } from "../storage/store.ts";
import type { SideEffectRecord } from "../domain/types.ts";

export function appendEffect(store: CheckpointStore, effect: SideEffectRecord): number {
  const seq = store.addSideEffect(effect);
  store.appendLedger("timemachine/side-effect-observed", { ...effect, seq });
  if (effect.reversibility === "irreversible") {
    store.appendLedger("timemachine/irreversible-action", { ...effect, seq });
  }
  return seq;
}
