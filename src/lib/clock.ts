// Injectable clock. Server-owned: the browser never supplies timestamps.
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Test clock with manual advance. */
export function fixedClock(start: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}
