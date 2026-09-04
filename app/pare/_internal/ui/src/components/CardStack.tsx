// The deck. Owns every bit of motion: pointer drag, two-finger trackpad
// swipes, keyboard-triggered exits, and the card that slides back in after
// an undo. It also reports how far the card has been pulled toward either
// side, so the side actions and the card's edge can answer.
//
// Decisions are committed the moment a gesture crosses the threshold. The
// leaving card becomes a detached "ghost" that finishes its flight while the
// next card is already live, so a fast run of keypresses never waits on an
// animation.

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { DISPOSE, KEEP, type Item } from "../../../schema";
import { Card } from "./Card";

export type ExitKind = "keep" | "dispose" | "skip" | "fade";

export interface StackApi {
  // Animate `itemId` off the deck. The caller updates state in the same tick.
  exit(itemId: string, kind: ExitKind): void;
}

interface CardStackProps {
  items: Item[];
  onSwipe: (itemId: string, action: typeof KEEP | typeof DISPOSE) => void;
  onOpenLink: (url: string) => void;
  apiRef: MutableRefObject<StackApi | null>;
  // Written by the stack: -1 fully toward dispose, 1 fully toward keep.
  pull: MotionValue<number>;
}

interface Ghost {
  key: number;
  item: Item;
  kind: ExitKind;
  fromX: number;
  fromY: number;
  fromOpacity: number;
}

const VISIBLE_BEHIND = 2;
const PULL_DISTANCE = 110;
const FLY_DURATION = 0.34;
const EASE_OUT = [0.2, 0, 0, 1] as const;
const SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 } as const;
const SETTLE = { type: "spring", stiffness: 420, damping: 38 } as const;

export function CardStack({ items, onSwipe, onOpenLink, apiRef, pull }: CardStackProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion() ?? false;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const opacity = useMotionValue(1);
  // The card thins a little as it is pushed and never reaches the iframe
  // edge opaque.
  const dragFade = useTransform(x, [-260, -60, 0, 60, 260], [0.2, 1, 1, 1, 0.2]);
  // The pull only reads while the user is moving the card, not when a card
  // slides back in after an undo.
  const gate = useMotionValue(0);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [dragging, setDragging] = useState(false);
  const ghostSeq = useRef(0);
  const lastExit = useRef(new Map<string, ExitKind>());
  const top = items[0];
  const topId = top?.id;

  const stageWidth = () => stageRef.current?.clientWidth ?? 480;
  const commitDistance = () => Math.min(140, stageWidth() * 0.34);
  const flyDistance = () => stageWidth() * 0.75;

  const latest = useRef({ items, onSwipe });
  latest.current = { items, onSwipe };

  function launchGhost(itemId: string, kind: ExitKind) {
    const item = latest.current.items.find((i) => i.id === itemId);
    if (!item) return;
    const isTop = latest.current.items[0]?.id === itemId;
    lastExit.current.set(itemId, kind);
    setGhosts((current) => [
      ...current,
      {
        key: ++ghostSeq.current,
        item,
        kind,
        fromX: isTop ? x.get() : 0,
        fromY: isTop ? y.get() : 0,
        fromOpacity: isTop ? dragFade.get() : 1,
      },
    ]);
    if (isTop) {
      gate.set(0);
      x.jump(0);
      y.jump(0);
    }
  }

  apiRef.current = { exit: launchGhost };

  function commitSwipe(direction: 1 | -1) {
    const item = latest.current.items[0];
    if (!item) return;
    const action = direction > 0 ? KEEP : DISPOSE;
    launchGhost(item.id, action);
    latest.current.onSwipe(item.id, action);
  }

  function settleBack() {
    gate.set(0);
    if (reduceMotion) {
      x.jump(0);
      y.jump(0);
      return;
    }
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
  }

  // A card returning after undo slides in from where it left.
  useLayoutEffect(() => {
    if (!topId) return;
    const kind = lastExit.current.get(topId);
    lastExit.current.delete(topId);
    if (!kind || reduceMotion) {
      x.jump(0);
      y.jump(0);
      opacity.jump(1);
      return;
    }
    const distance = flyDistance();
    x.jump(kind === "keep" ? distance : kind === "dispose" ? -distance : 0);
    y.jump(kind === "skip" ? 80 : 0);
    opacity.jump(kind === "fade" ? 0 : 1);
    animate(x, 0, SPRING);
    animate(y, 0, SPRING);
    animate(opacity, 1, { duration: 0.2 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topId]);

  // Two-finger trackpad swipes arrive as wheel events with no end event; a
  // short gap in the stream stands in for the fingers lifting. A cooldown
  // after a commit swallows the momentum that follows. Vertical scrolling
  // passes through.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let axis: "x" | "y" | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let cooldownUntil = 0;

    const onWheel = (event: WheelEvent) => {
      if (!latest.current.items[0]) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const dx = event.deltaX * scale;
      const dy = event.deltaY * scale;
      const now = performance.now();
      if (now < cooldownUntil) {
        if (Math.abs(dx) > Math.abs(dy)) event.preventDefault();
        return;
      }
      if (axis === null) {
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (idle) clearTimeout(idle);
      if (axis === "y") {
        idle = setTimeout(() => (axis = null), 160);
        return;
      }
      event.preventDefault();
      gate.set(1);
      // Natural scrolling: fingers moving right report a negative deltaX.
      // Travel is clamped so momentum cannot overshoot, and the swipe commits
      // only once the wheel stream stops: lifting the fingers decides, and
      // pulling back before that cancels.
      const limit = commitDistance() + 40;
      const next = Math.max(-limit, Math.min(limit, x.get() - dx));
      x.set(next);
      idle = setTimeout(() => {
        axis = null;
        const settled = x.get();
        if (Math.abs(settled) >= commitDistance()) {
          commitSwipe(settled > 0 ? 1 : -1);
          cooldownUntil = performance.now() + 400;
        } else {
          settleBack();
        }
      }, 90);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (idle) clearTimeout(idle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pointer drag on the top card. Horizontal intent is required before the
  // card follows.
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    lastX: number;
    lastT: number;
    vx: number;
  } | null>(null);
  const suppressClickUntil = useRef(0);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !top) return;
    const target = event.target as HTMLElement;
    if (target.closest("a, button")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      lastX: event.clientX,
      lastT: performance.now(),
      vx: 0,
    };
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        d.active = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        gate.set(1);
      } else if (Math.abs(dy) > 10) {
        drag.current = null;
        return;
      } else {
        return;
      }
    }
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    const instant = ((event.clientX - d.lastX) / dt) * 1000;
    d.vx = d.vx * 0.6 + instant * 0.4;
    d.lastX = event.clientX;
    d.lastT = now;
    x.set(dx);
    y.set(dy * 0.22);
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!d.active) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    suppressClickUntil.current = performance.now() + 150;
    const current = x.get();
    // A flick commits early, but only past a real distance: synthetic or
    // jittery input can report huge velocities over a few pixels.
    const flung =
      Math.abs(d.vx) > 700 && Math.sign(d.vx) === Math.sign(current) && Math.abs(current) > 90;
    if (!cancelled && (Math.abs(current) >= commitDistance() || flung)) {
      commitSwipe(current > 0 ? 1 : -1);
    } else {
      settleBack();
    }
  }

  const rotate = useTransform(x, [-320, 320], [-9, 9]);
  // The card thins as it is pushed, so the outcome it is heading for shows
  // through it, and a long drag never reaches the iframe edge opaque.
  const topOpacity = useTransform(() => dragFade.get() * opacity.get());
  const signedPull = useTransform(
    () => Math.max(-1, Math.min(1, x.get() / PULL_DISTANCE)) * gate.get(),
  );
  useMotionValueEvent(signedPull, "change", (value) => pull.set(value));
  const keepEdge = useTransform(signedPull, [0, 1], [0, 1]);
  const disposeEdge = useTransform(signedPull, [-1, 0], [1, 0]);

  const behind = items.slice(1, 1 + VISIBLE_BEHIND);
  const suggestion = top?.suggestion;
  const suggestedKind =
    suggestion?.action === KEEP ? "keep" : suggestion?.action === DISPOSE ? "dispose" : "extra";

  return (
    <div ref={stageRef} className="pare-stage">
      {behind.toReversed().map((item, i) => {
        const depth = behind.length - i;
        return (
          <motion.div
            key={item.id}
            className="pare-card pare-card--behind"
            initial={false}
            animate={{ scale: 1 - depth * 0.03, y: depth * 6 }}
            transition={reduceMotion ? { duration: 0 } : SETTLE}
            style={{ zIndex: 10 - depth }}
            aria-hidden
          >
            <Card item={item} />
          </motion.div>
        );
      })}

      {top && (
        <motion.div
          key={top.id}
          className={"pare-card pare-card--top" + (dragging ? " is-dragging" : "")}
          style={{ x, y, rotate, opacity: topOpacity }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
          onClickCapture={(e) => {
            if (performance.now() < suppressClickUntil.current) {
              e.stopPropagation();
              e.preventDefault();
            }
          }}
          data-testid="top-card"
          data-item-id={top.id}
        >
          <Card item={top} onOpenLink={onOpenLink}>
            {suggestion && (
              <span
                className={`pare-mark pare-mark--${suggestedKind}`}
                title={suggestion.reason ? `Suggested. ${suggestion.reason}` : "Suggested"}
                data-testid="suggestion-mark"
              />
            )}
            <motion.span
              className="pare-edge pare-edge--dispose"
              style={{ opacity: disposeEdge }}
            />
            <motion.span className="pare-edge pare-edge--keep" style={{ opacity: keepEdge }} />
          </Card>
        </motion.div>
      )}

      {ghosts.map((ghost) => (
        <GhostCard
          key={ghost.key}
          ghost={ghost}
          flyDistance={flyDistance()}
          reduceMotion={reduceMotion}
          onDone={() => setGhosts((current) => current.filter((g) => g.key !== ghost.key))}
        />
      ))}
    </div>
  );
}

function GhostCard({
  ghost,
  flyDistance,
  reduceMotion,
  onDone,
}: {
  ghost: Ghost;
  flyDistance: number;
  reduceMotion: boolean;
  onDone: () => void;
}) {
  const { kind, fromX, fromY, fromOpacity } = ghost;
  // Flying cards fade over the last part of the flight, so they never reach
  // the iframe edge where the host would clip them.
  const target =
    kind === "keep"
      ? { x: flyDistance, y: fromY + 20, rotate: 10, opacity: 0 }
      : kind === "dispose"
        ? { x: -flyDistance, y: fromY + 20, rotate: -10, opacity: 0 }
        : kind === "skip"
          ? { x: fromX, y: 64, rotate: 0, scale: 0.96, opacity: 0 }
          : { x: fromX, y: fromY - 8, rotate: 0, scale: 0.94, opacity: 0 };
  const transition = reduceMotion
    ? { duration: 0 }
    : kind === "keep" || kind === "dispose"
      ? { duration: FLY_DURATION, ease: EASE_OUT, opacity: { duration: FLY_DURATION * 0.8 } }
      : { duration: 0.24, ease: EASE_OUT };

  return (
    <motion.div
      className="pare-card pare-card--ghost"
      initial={{ x: fromX, y: fromY, rotate: fromX / 32, opacity: fromOpacity, scale: 1 }}
      animate={target}
      transition={transition}
      onAnimationComplete={onDone}
      aria-hidden
    >
      <Card item={ghost.item}>
        {(kind === "keep" || kind === "dispose") && (
          <span className={`pare-edge pare-edge--${kind}`} />
        )}
      </Card>
    </motion.div>
  );
}
